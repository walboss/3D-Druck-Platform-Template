-- Migration 00170: Farben/Finishes global verfügbar statt pro Produkt freizugeben
-- Entscheidung 2026-09-20 (Betreiber): das bisherige Modell aus
-- specs/produkte-varianten-farben.md §2/§3 (product_color_finish_options
-- als "erlaubte Kombinationen pro Produkt") bedeutet doppelte Pflege --
-- Farbe/Finish global anlegen UND zusätzlich pro Produkt freischalten.
-- Das ist nicht gewünscht: jede aktive Farbe + jedes aktive Finish soll ab
-- sofort für jedes Produkt wählbar sein, ohne weiteren Freigabeschritt.
-- specs/produkte-varianten-farben.md wird in derselben Session aktualisiert.
--
-- product_color_finish_options (Tabelle) wird NICHT gelöscht (#2, keine
-- bestehende Struktur rückstandslos entfernen) -- nur die Validierung in
-- fn_create_variant_configuration_if_missing (00141) verwendet sie ab jetzt
-- nicht mehr. Ersetzt Schritt 4 der Funktion: statt gegen
-- product_color_finish_options zu prüfen, muss color_id in colors
-- (active=true) und finish_id in finishes (active=true) existieren --
-- global, ohne Produktbezug. Rest der Funktion unverändert (spaltengleiche
-- Kopie aus 00141).

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

  -- 2. Sperre je Variante ---------------------------------------------------
  perform pg_advisory_xact_lock(
    hashtext('fn_create_variant_configuration_if_missing'),
    hashtext(p_variant_id::text)
  );

  -- 3. Existenzprüfung: exakt gleiche Menge (product_part_id, color_id,
  --    finish_id) -----------------------------------------------------------
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

  -- 4. Gültigkeit: color_id/finish_id müssen global aktiv sein --------------
  -- (bis 00169: gegen product_color_finish_options des Produkts geprüft --
  -- ab hier global, ohne Produktbezug, siehe Kommentar am Migrationskopf).
  select m.product_part_id, m.color_id, m.finish_id,
         col.name as color_name, col.active as color_active,
         fin.name as finish_name, fin.active as finish_active
    into v_bad
  from jsonb_to_recordset(p_part_color_map)
    as m(product_part_id uuid, color_id uuid, finish_id uuid)
  left join colors   col on col.id = m.color_id
  left join finishes fin on fin.id = m.finish_id
  where col.id is null or col.active is not true
     or fin.id is null or fin.active is not true
  limit 1;

  if found then
    raise exception 'Farbe/Finish ungültig oder inaktiv: Farbe % (%), Finish % (%)%',
      coalesce(v_bad.color_name, '<unbekannt>'), v_bad.color_id,
      coalesce(v_bad.finish_name, '<unbekannt>'), v_bad.finish_id,
      case when v_bad.product_part_id is not null
           then ' für product_part_id ' || v_bad.product_part_id
           else '' end
      using errcode = 'check_violation',
            hint = 'color_id muss in colors (active=true) und finish_id in finishes (active=true) existieren.';
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
