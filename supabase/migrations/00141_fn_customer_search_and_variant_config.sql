-- Migration 00141: RPC-Funktionen Bestellfluss, Teil 1
-- (Nummer 00141 statt "0014a": die Supabase-CLI verlangt <Ziffern>_name.sql;
-- 00141/00142 sortieren zwischen 0013 und 0015, Plan-Nummern bleiben.)
-- (fn_customer_search, fn_create_variant_configuration_if_missing)
-- Siehe specs/implementierungsplan-schritt9.md §3 (RLS-Konzept: alles außer
-- Kataloglesen läuft über SECURITY DEFINER-RPCs) und §4 (Bestellfluss),
-- specs/kunden-warenkorb-tracking.md §3 (aktive Kundensuche beim Checkout),
-- specs/produkte-varianten-farben.md §3 (automatische Anlage von
-- variant_configurations beim Checkout, nur wenn gegen
-- product_color_finish_options gültig).
--
-- Beide Funktionen lesen bzw. legen nur Stammdaten an — kein Statuswechsel
-- im Sinne von Prinzip #31, daher kein audit_log-Eintrag.
-- Keine RLS-Policies hier (kommen in Migration 0015).

-- ---------------------------------------------------------------------------
-- fn_customer_search(p_phone, p_email) → boolean
-- ---------------------------------------------------------------------------
-- Aktive Kundensuche beim Checkout (kunden-warenkorb-tracking.md §3):
-- Abgleich über Telefon und E-Mail, beide optional — die Suche verwendet, was
-- der Kunde eingegeben hat.
--
-- Sicherheitsregel: liefert AUSSCHLIESSLICH true/false, niemals Kundendaten,
-- IDs oder Namen. Da die Funktion für `anon` aufrufbar ist, wäre jede weitere
-- Rückgabe eine Enumeration fremder Kundendaten über die öffentliche API.
--
-- Abgleich: Eingaben werden getrimmt, E-Mail wird case-insensitiv verglichen.
-- Leere/NULL-Eingaben werden ignoriert; sind beide leer, wird false
-- zurückgegeben (kein Treffer "auf alles"). Sind beide angegeben, reicht ein
-- Treffer auf einem der beiden Felder (ODER) — findet auch Kunden, die früher
-- nur Telefon oder nur E-Mail hinterlegt hatten.
create or replace function fn_customer_search(p_phone text, p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := nullif(trim(p_phone), '');
  v_email text := nullif(lower(trim(p_email)), '');
begin
  if v_phone is null and v_email is null then
    return false;
  end if;

  return exists (
    select 1
    from customers c
    where (v_phone is not null and c.phone = v_phone)
       or (v_email is not null and lower(c.email) = v_email)
  );
end;
$$;

revoke all on function fn_customer_search(text, text) from public;
grant execute on function fn_customer_search(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- fn_create_variant_configuration_if_missing(p_variant_id, p_part_color_map)
--   → uuid
-- ---------------------------------------------------------------------------
-- p_part_color_map: JSON-Array von Objekten
--   { "product_part_id": uuid | null, "color_id": uuid, "finish_id": uuid }
-- product_part_id = NULL → Farbe/Finish gilt für die ganze Position
-- (einfarbig, genau ein Eintrag). Mehrfarbig → je Teil ein Eintrag.
--
-- Ablauf:
--   1. Eingabe validieren (Variante existiert, Array nicht leer, Felder
--      vorhanden, keine Duplikate je Teil, keine Mischung aus NULL-Teil und
--      konkreten Teilen, Teile gehören zum Produkt der Variante).
--   2. Sperre je Variante (s. u.).
--   3. Existiert bereits eine variant_configuration dieser Variante mit exakt
--      derselben Farbmenge (Mengengleichheit über variant_configuration_colors,
--      keine Teilmenge/Obermenge) → deren id zurückgeben.
--   4. Sonst jede (color_id, finish_id) gegen product_color_finish_options des
--      Produkts prüfen (active = true) — ungültig → RAISE EXCEPTION, keine
--      Anlage.
--   5. Gültig → variant_configurations + variant_configuration_colors anlegen,
--      neue id zurückgeben.
--
-- Race-Condition-Schutz (gewählt: transaktionsgebundener Advisory Lock je
-- variant_id, pg_advisory_xact_lock):
--   "Diese Farbkombination existiert schon" ist eine Mengengleichheit über die
--   Kindtabelle variant_configuration_colors. Das lässt sich nicht als
--   UNIQUE-Constraint ausdrücken, also ist INSERT ... ON CONFLICT hier nicht
--   anwendbar (dafür müsste eine zusätzliche Hash-Spalte auf
--   variant_configurations eingeführt werden — Änderung an bestehender
--   Tabelle, nicht Teil dieses Tasks). Ein SELECT ... FOR UPDATE auf die
--   product_variants-Zeile würde ebenfalls serialisieren, blockiert aber
--   unnötig gleichzeitige Admin-Updates an der Variante. Der Advisory Lock
--   serialisiert nur Aufrufe dieser Funktion für dieselbe Variante,
--   gilt bis zum Ende der aufrufenden Transaktion (also über den gesamten
--   späteren fn_place_order-Aufruf hinweg) und wird VOR der Existenzprüfung
--   genommen — damit ist "prüfen, dann anlegen" für eine Variante atomar:
--   der zweite Aufrufer wartet, sieht nach Commit des ersten dessen Zeile und
--   gibt deren id zurück statt ein Duplikat anzulegen. Eine Hash-Kollision
--   zweier Varianten-IDs führt nur zu unnötiger Serialisierung, nie zu
--   falschem Verhalten.
create or replace function fn_create_variant_configuration_if_missing(
  p_variant_id uuid,
  p_part_color_map jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id      uuid;
  v_product_name    text;
  v_count           int;
  v_null_part_count int;
  v_existing_id     uuid;
  v_new_id          uuid;
  v_bad             record;
begin
  -- 1. Eingabe validieren -------------------------------------------------
  select pv.product_id, p.name
    into v_product_id, v_product_name
  from product_variants pv
  join products p on p.id = pv.product_id
  where pv.id = p_variant_id;

  if v_product_id is null then
    raise exception 'Variante % existiert nicht', p_variant_id
      using errcode = 'invalid_parameter_value';
  end if;

  if p_part_color_map is null or jsonb_typeof(p_part_color_map) <> 'array' then
    raise exception 'p_part_color_map muss ein JSON-Array sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_part_color_map) e;

  if v_count = 0 then
    raise exception 'p_part_color_map darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  -- jedes Element muss ein Objekt mit color_id und finish_id sein
  if exists (
    select 1
    from jsonb_array_elements(p_part_color_map) e
    where jsonb_typeof(e) <> 'object'
       or nullif(e->>'color_id', '') is null
       or nullif(e->>'finish_id', '') is null
  ) then
    raise exception 'Jeder Eintrag in p_part_color_map braucht color_id und finish_id (product_part_id optional/null)'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Einfarbig (product_part_id = NULL) und mehrfarbig (Teile) nicht mischen;
  -- einfarbig = genau ein Eintrag.
  select count(*) into v_null_part_count
  from jsonb_to_recordset(p_part_color_map)
    as m(product_part_id uuid, color_id uuid, finish_id uuid)
  where m.product_part_id is null;

  if v_null_part_count > 0 and v_count > 1 then
    raise exception 'Einfarbige Konfiguration (product_part_id = null) darf nur genau einen Eintrag enthalten (erhalten: %)', v_count
      using errcode = 'invalid_parameter_value';
  end if;

  -- keine zwei Einträge für dasselbe Teil
  if exists (
    select 1
    from jsonb_to_recordset(p_part_color_map)
      as m(product_part_id uuid, color_id uuid, finish_id uuid)
    group by m.product_part_id
    having count(*) > 1
  ) then
    raise exception 'p_part_color_map enthält mehrere Einträge für dasselbe product_part_id'
      using errcode = 'invalid_parameter_value';
  end if;

  -- angegebene Teile müssen zum Produkt der Variante gehören
  select m.product_part_id into v_bad
  from jsonb_to_recordset(p_part_color_map)
    as m(product_part_id uuid, color_id uuid, finish_id uuid)
  where m.product_part_id is not null
    and not exists (
      select 1 from product_parts pp
      where pp.id = m.product_part_id and pp.product_id = v_product_id
    )
  limit 1;

  if found then
    raise exception 'product_part_id % gehört nicht zum Produkt "%" der Variante %',
      v_bad.product_part_id, v_product_name, p_variant_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. Sperre je Variante (siehe Kommentar oben) ---------------------------
  perform pg_advisory_xact_lock(
    hashtext('fn_create_variant_configuration_if_missing'),
    hashtext(p_variant_id::text)
  );

  -- 3. Existenzprüfung: exakt gleiche Menge (product_part_id, color_id,
  --    finish_id) — jede Eingabezeile ist in der Konfiguration enthalten UND
  --    jede Konfigurationszeile ist in der Eingabe enthalten.
  select vc.id into v_existing_id
  from variant_configurations vc
  where vc.variant_id = p_variant_id
    and not exists (
      select 1
      from jsonb_to_recordset(p_part_color_map)
        as m(product_part_id uuid, color_id uuid, finish_id uuid)
      where not exists (
        select 1 from variant_configuration_colors c
        where c.variant_configuration_id = vc.id
          and c.product_part_id is not distinct from m.product_part_id
          and c.color_id  = m.color_id
          and c.finish_id = m.finish_id
      )
    )
    and not exists (
      select 1 from variant_configuration_colors c
      where c.variant_configuration_id = vc.id
        and not exists (
          select 1
          from jsonb_to_recordset(p_part_color_map)
            as m(product_part_id uuid, color_id uuid, finish_id uuid)
          where m.product_part_id is not distinct from c.product_part_id
            and m.color_id  = c.color_id
            and m.finish_id = c.finish_id
        )
    )
  order by vc.created_at
  limit 1;

  if v_existing_id is not null then
    return v_existing_id;
  end if;

  -- 4. Gültigkeit gegen product_color_finish_options (pro Produkt, nicht pro
  --    Teil — produkte-varianten-farben.md §3) ------------------------------
  select m.product_part_id, m.color_id, m.finish_id,
         col.name as color_name, fin.name as finish_name
    into v_bad
  from jsonb_to_recordset(p_part_color_map)
    as m(product_part_id uuid, color_id uuid, finish_id uuid)
  left join colors   col on col.id = m.color_id
  left join finishes fin on fin.id = m.finish_id
  where not exists (
    select 1 from product_color_finish_options o
    where o.product_id = v_product_id
      and o.color_id   = m.color_id
      and o.finish_id  = m.finish_id
      and o.active
  )
  limit 1;

  if found then
    raise exception 'Farb-/Finish-Kombination ist für Produkt "%" nicht erlaubt: Farbe % (%), Finish % (%)%',
      v_product_name,
      coalesce(v_bad.color_name, '<unbekannt>'), v_bad.color_id,
      coalesce(v_bad.finish_name, '<unbekannt>'), v_bad.finish_id,
      case when v_bad.product_part_id is not null
           then ' für product_part_id ' || v_bad.product_part_id
           else '' end
      using errcode = 'check_violation',
            hint = 'Erlaubte Kombinationen stehen in product_color_finish_options (active = true) des Produkts.';
  end if;

  -- 5. Anlage ---------------------------------------------------------------
  insert into variant_configurations (variant_id)
  values (p_variant_id)
  returning id into v_new_id;

  insert into variant_configuration_colors
    (variant_configuration_id, product_part_id, color_id, finish_id)
  select v_new_id, m.product_part_id, m.color_id, m.finish_id
  from jsonb_to_recordset(p_part_color_map)
    as m(product_part_id uuid, color_id uuid, finish_id uuid);

  return v_new_id;
end;
$$;

-- Wird laut implementierungsplan-schritt9.md §4 intern von fn_place_order
-- (SECURITY DEFINER) aufgerufen — dafür ist kein Grant an anon nötig.
-- Direkt aufrufbar nur für die Admin-Rolle (authenticated).
revoke all on function fn_create_variant_configuration_if_missing(uuid, jsonb) from public;
revoke all on function fn_create_variant_configuration_if_missing(uuid, jsonb) from anon;
grant execute on function fn_create_variant_configuration_if_missing(uuid, jsonb) to authenticated;
