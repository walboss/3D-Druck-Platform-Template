-- Migration 00142: RPC-Funktionen Bestellfluss, Teil 2
-- (fn_place_order, fn_confirm_order)
-- Siehe specs/implementierungsplan-schritt9.md §4 (Bestellfluss),
-- specs/bestellungen.md §3-§5 (Atomarität #15, Statusübergänge, Randfall
-- "teilweise verfügbare Mehrpositions-Bestellung"),
-- specs/fertigwarenbestand.md §2-§4 (Verfügbarkeit, Reservierung bei Confirmed),
-- specs/kunden-warenkorb-tracking.md §2-§3 (Warenkorb reserviert nichts, #14),
-- specs/kalkulation.md §2-§3 (is_current-Version als Preis-Snapshot, #9).
--
-- Keine RLS-Policies hier (kommen in Migration 0015).
-- Kein Filament-Handling (erst bei Produktionsstart, #30 — Teil 3).

-- ---------------------------------------------------------------------------
-- fn_place_order(p_cart_session_id, p_customer) → uuid (orders.id)
-- ---------------------------------------------------------------------------
-- p_customer: entweder { "existing_customer_id": uuid }
--             oder     { "first_name", "last_name", "email", "phone",
--                        "pickup_method" }   (email/phone optional)
-- Die Entscheidung "bestehender Kunde oder neu" trifft der Kunde selbst im
-- Frontend (kunden-warenkorb-tracking.md §3, kein stilles Dedup) — hier wird
-- nur geprüft, dass eine übergebene ID existiert.
--
-- Ablauf (eine Transaktion, jeder RAISE rollt alles zurück — #15/#31):
--   1. Warenkorb-Session prüfen (existiert, hat Positionen). expires_at wird
--      bewusst nicht geprüft (Entscheidung Task-Rückfrage).
--   2. customers-Datensatz auflösen oder anlegen.
--   3. Bestellnummer vergeben (Strategie siehe unten).
--   4. orders anlegen (status='New', source='catalog').
--   5. Je cart_item: Mengenregeln prüfen, variant_configuration auflösen bzw.
--      anlegen (fn_create_variant_configuration_if_missing), aktuell gültige
--      calculation_version ermitteln, order_items-Zeile (status='Offen').
--   6. Audit-Log: orders → 'New'.
--   KEINE Reservierung (#14/#30) — die erfolgt erst in fn_confirm_order.
--
-- Bestellnummer 'ORDER-<JAHR>-<5-stellig fortlaufend>', Eindeutigkeit:
--   Der Zähler wird als max(bisherige Nummer des Jahres) + 1 ermittelt. Damit
--   zwei gleichzeitige Checkouts nicht dieselbe Zahl lesen, wird vorher ein
--   transaktionsgebundener Advisory Lock genommen (pg_advisory_xact_lock, ein
--   Schlüssel für alle Bestellnummern) — die Vergabe ist damit serialisiert;
--   der zweite Aufrufer wartet, bis der erste committed/rollt zurück, und
--   liest dann dessen Nummer als neues Maximum. Bei Rollback entsteht keine
--   Lücke (anders als bei einer Sequence, die nicht zurückrollt). Das
--   UNIQUE-Constraint auf orders.order_number bleibt als zweite Sicherung.
--   Jahreswechsel: es zählen nur Nummern mit dem aktuellen Jahres-Präfix,
--   der Zähler startet also automatisch wieder bei 00001.
create or replace function fn_place_order(
  p_cart_session_id uuid,
  p_customer jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  -- anon hat keine auth.uid() → 'system' (Task-Vorgabe)
  v_actor        text := coalesce(auth.uid()::text, 'system');
  v_customer_id  uuid;
  v_order_id     uuid;
  v_year         text := to_char(current_date, 'YYYY');
  v_next_no      int;
  v_order_number text;
  v_item         record;
  v_vc_id        uuid;
  v_calc_id      uuid;
begin
  -- 1. Warenkorb-Session -----------------------------------------------------
  if p_cart_session_id is null then
    raise exception 'p_cart_session_id fehlt'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (select 1 from cart_sessions cs where cs.id = p_cart_session_id) then
    raise exception 'Warenkorb-Session % existiert nicht', p_cart_session_id
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (select 1 from cart_items ci where ci.cart_session_id = p_cart_session_id) then
    raise exception 'Warenkorb-Session % enthält keine Positionen', p_cart_session_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. Kunde -----------------------------------------------------------------
  if p_customer is null or jsonb_typeof(p_customer) <> 'object' then
    raise exception 'p_customer muss ein JSON-Objekt sein'
      using errcode = 'invalid_parameter_value';
  end if;

  if nullif(p_customer->>'existing_customer_id', '') is not null then
    v_customer_id := (p_customer->>'existing_customer_id')::uuid;

    if not exists (select 1 from customers c where c.id = v_customer_id) then
      raise exception 'Kunde % existiert nicht', v_customer_id
        using errcode = 'invalid_parameter_value';
    end if;
  else
    if nullif(trim(p_customer->>'first_name'), '') is null
       or nullif(trim(p_customer->>'last_name'), '') is null
       or nullif(trim(p_customer->>'pickup_method'), '') is null then
      raise exception 'Neuer Kunde braucht first_name, last_name und pickup_method (email/phone optional)'
        using errcode = 'invalid_parameter_value';
    end if;

    insert into customers (first_name, last_name, email, phone, pickup_method)
    values (
      trim(p_customer->>'first_name'),
      trim(p_customer->>'last_name'),
      nullif(trim(p_customer->>'email'), ''),
      nullif(trim(p_customer->>'phone'), ''),
      trim(p_customer->>'pickup_method')
    )
    returning id into v_customer_id;
  end if;

  -- 3. Bestellnummer (Strategie siehe Kommentar oben) ------------------------
  perform pg_advisory_xact_lock(hashtext('fn_place_order.order_number'));

  select coalesce(max(substring(o.order_number from '^ORDER-\d{4}-(\d{5})$')::int), 0) + 1
    into v_next_no
  from orders o
  where o.order_number like 'ORDER-' || v_year || '-%';

  if v_next_no > 99999 then
    raise exception 'Bestellnummernkreis für % erschöpft (max. 99999)', v_year;
  end if;

  v_order_number := 'ORDER-' || v_year || '-' || lpad(v_next_no::text, 5, '0');

  -- 4. Bestellung ------------------------------------------------------------
  insert into orders (order_number, customer_id, status, source)
  values (v_order_number, v_customer_id, 'New', 'catalog')
  returning id into v_order_id;

  -- 5. Positionen aus dem Warenkorb ------------------------------------------
  for v_item in
    select ci.id          as cart_item_id,
           ci.product_id,
           ci.variant_id,
           ci.configuration_draft,
           ci.qty,
           pv.product_id  as variant_product_id,
           pv.size_label,
           pv.min_qty,
           pv.max_qty,
           pv.step_qty
    from cart_items ci
    left join product_variants pv on pv.id = ci.variant_id
    where ci.cart_session_id = p_cart_session_id
    order by ci.created_at, ci.id
  loop
    if v_item.variant_product_id is null then
      raise exception 'Variante % (Warenkorbposition %) existiert nicht',
        v_item.variant_id, v_item.cart_item_id
        using errcode = 'invalid_parameter_value';
    end if;

    if v_item.variant_product_id <> v_item.product_id then
      raise exception 'Warenkorbposition %: Variante % gehört nicht zu Produkt %',
        v_item.cart_item_id, v_item.variant_id, v_item.product_id
        using errcode = 'invalid_parameter_value';
    end if;

    -- Mengenregeln (min_qty / max_qty / step_qty aus product_variants):
    -- Menge liegt in [min_qty, max_qty] und ist ab min_qty in Schritten von
    -- step_qty erreichbar (min, min+step, min+2*step, ...).
    if v_item.qty is null
       or v_item.qty < v_item.min_qty
       or v_item.qty > v_item.max_qty
       or (v_item.qty - v_item.min_qty) % v_item.step_qty <> 0 then
      raise exception 'Menge % für Variante "%" ungültig (erlaubt: % bis %, Schrittweite %)',
        v_item.qty, v_item.size_label, v_item.min_qty, v_item.max_qty, v_item.step_qty
        using errcode = 'check_violation';
    end if;

    -- Farb-/Finish-Konfiguration auflösen oder anlegen (prüft gegen
    -- product_color_finish_options, wirft bei ungültiger Kombination).
    v_vc_id := fn_create_variant_configuration_if_missing(
      v_item.variant_id, v_item.configuration_draft
    );

    -- Aktuell gültige Kalkulationsversion = Preis-Snapshot (#9). Ohne gültige
    -- Version ist das Produkt nicht bestellbar.
    select cv.id into v_calc_id
    from calculation_versions cv
    where cv.scope_type = 'product_variant'
      and cv.scope_id   = v_item.variant_id
      and cv.is_current
    order by cv.version_no desc
    limit 1;

    if v_calc_id is null then
      raise exception 'Variante "%" (%) hat keine gültige Kalkulation (is_current) und ist nicht bestellbar',
        v_item.size_label, v_item.variant_id
        using errcode = 'check_violation';
    end if;

    insert into order_items
      (order_id, product_id, variant_id, variant_configuration_id, qty, status, calculation_version_id)
    values
      (v_order_id, v_item.product_id, v_item.variant_id, v_vc_id, v_item.qty, 'Offen', v_calc_id);
  end loop;

  -- 6. Audit-Log -------------------------------------------------------------
  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('order', v_order_id, 'status_change', 'status', null, 'New', v_actor);

  return v_order_id;
end;
$$;

-- Checkout ohne Login (#21) → anon darf aufrufen; Admin ebenfalls.
revoke all on function fn_place_order(uuid, jsonb) from public;
grant execute on function fn_place_order(uuid, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- fn_confirm_order(p_order_id) → jsonb
--   { "order_status": ..., "items": [ { "order_item_id", "status",
--                                       "reserved": bool }, ... ] }
-- ---------------------------------------------------------------------------
-- Admin-Aktion: Bestellung New → Confirmed inkl. sofortiger Reservierung der
-- Fertigware (fertigwarenbestand.md §3, #30). Reserviert wird ausschließlich
-- stock_type = 'normal' (Katalogbestellung; B-Ware ist ein eigener
-- Bestandstyp und nicht Teil des Katalog-Checkouts — Entscheidung
-- Task-Rückfrage).
--
-- Ablauf (eine Transaktion — die *Versuche* sind atomar, das *Ergebnis*
-- darf gemischt sein, bestellungen.md §5):
--   1. orders-Zeile mit FOR UPDATE sperren, Status muss 'New' sein.
--   2. Je order_item mit status = 'Offen':
--      - hat es bereits eine aktive Reservierung (z. B. aus einem früheren
--        Aufruf, bei dem eine andere Position gescheitert ist) → zählt als
--        reserviert, nichts tun (keine Doppelreservierung).
--      - ohne Katalogbezug (Ausnahmepfad, variant_configuration_id IS NULL)
--        → es gibt keinen Fertigwarenbestand → 'WartetAufMaterial'
--        (Entscheidung Task-Rückfrage).
--      - sonst: Verfügbarkeit = Σ movements.qty_delta − Σ aktive
--        Reservierungen (fertigwarenbestand.md §2); reicht sie für die volle
--        Menge (alles-oder-nichts je Position) → Reservierung 'aktiv',
--        sonst → order_items.status = 'WartetAufMaterial'.
--   3. orders → 'Confirmed' (+ confirmed_at) nur, wenn JEDE aktive (nicht
--      stornierte) Position eine aktive Reservierung hat; sonst bleibt 'New'.
--   4. Audit-Log je Statuswechsel (orders, order_items, Reservierung).
--
-- Sperrstrategie gegen Race-Conditions (#5) — gewählt: SELECT ... FOR UPDATE
-- auf die variant_configurations-Zeile je Position:
--   Der Bestand ist eine Summe über finished_goods_movements und
--   finished_goods_reservations. Ein FOR UPDATE auf diesen Zeilen selbst
--   würde nichts nützen: Zeilensperren verhindern keine gleichzeitigen
--   INSERTs anderer Transaktionen (Phantome), zwei parallele Bestätigungen
--   könnten also beide "reicht" lesen und beide reservieren. Deshalb wird die
--   eine Zeile gesperrt, die alle Konkurrenten um denselben Bestand zwingend
--   teilen: die variant_configurations-Zeile. Erst NACH Erhalt dieser Sperre
--   werden Bestand und Reservierungen summiert (unter READ COMMITTED bekommt
--   jedes Statement einen frischen Snapshot, sieht also alles, was der
--   vorherige Sperrhalter committed hat) und die Reservierung eingefügt —
--   Prüfen und Anlegen sind damit für eine Konfiguration serialisiert. Die
--   Sperre hält bis Commit/Rollback der aufrufenden Transaktion.
--   Deadlock-Vermeidung: Positionen werden in fester Reihenfolge
--   (variant_configuration_id, id) durchlaufen, sodass zwei Bestellungen mit
--   überlappenden Konfigurationen ihre Sperren in derselben Reihenfolge
--   anfordern. Zusätzlich sperrt FOR UPDATE auf orders die Bestellung selbst
--   gegen doppelte gleichzeitige Bestätigung.
create or replace function fn_confirm_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Task: actor = auth.uid(). Fallback 'system' nur für Aufrufe ohne
  -- JWT-Kontext (z. B. Tests über die CLI / service_role).
  v_actor        text := coalesce(auth.uid()::text, 'system');
  v_order_status order_status;
  v_item         record;
  v_stock        int;
  v_reserved     int;
  v_reservation  uuid;
  v_all_reserved boolean;
  v_final_status order_status;
  v_items        jsonb;
begin
  -- 1. Bestellung sperren und prüfen ----------------------------------------
  select o.status into v_order_status
  from orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Bestellung % existiert nicht', p_order_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_order_status <> 'New' then
    raise exception 'Bestellung % hat Status % — bestätigen ist nur aus ''New'' möglich',
      p_order_id, v_order_status
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from order_items oi
    where oi.order_id = p_order_id and oi.status <> 'Storniert'
  ) then
    raise exception 'Bestellung % hat keine aktiven (nicht stornierten) Positionen', p_order_id
      using errcode = 'check_violation';
  end if;

  -- 2. Reservierungsversuch je offener Position ------------------------------
  for v_item in
    select oi.id, oi.variant_configuration_id, oi.qty
    from order_items oi
    where oi.order_id = p_order_id
      and oi.status = 'Offen'
    order by oi.variant_configuration_id nulls last, oi.id   -- feste Sperrreihenfolge
  loop
    -- bereits reserviert (Wiederholungsaufruf) → nichts tun
    if exists (
      select 1 from finished_goods_reservations r
      where r.order_item_id = v_item.id and r.status = 'aktiv'
    ) then
      continue;
    end if;

    if v_item.variant_configuration_id is not null then
      -- Sperre auf die Konfiguration (siehe Sperrstrategie oben)
      perform 1 from variant_configurations vc
      where vc.id = v_item.variant_configuration_id
      for update;

      -- Bestand = Σ qty_delta, Verfügbar = Bestand − Σ aktive Reservierungen
      select coalesce(sum(m.qty_delta), 0) into v_stock
      from finished_goods_movements m
      where m.variant_configuration_id = v_item.variant_configuration_id
        and m.stock_type = 'normal';

      select coalesce(sum(r.qty), 0) into v_reserved
      from finished_goods_reservations r
      where r.variant_configuration_id = v_item.variant_configuration_id
        and r.stock_type = 'normal'
        and r.status = 'aktiv';
    else
      -- Ausnahmepfad (kein Katalogbezug): kein Fertigwarenbestand vorhanden
      v_stock    := 0;
      v_reserved := 0;
    end if;

    if v_item.variant_configuration_id is not null
       and (v_stock - v_reserved) >= v_item.qty then
      -- alles-oder-nichts je Position: volle Menge reservieren
      insert into finished_goods_reservations
        (variant_configuration_id, stock_type, order_item_id, qty, status)
      values
        (v_item.variant_configuration_id, 'normal', v_item.id, v_item.qty, 'aktiv')
      returning id into v_reservation;

      -- fertigwarenbestand.md §4: jeder Reservierungsübergang mit Audit-Eintrag
      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('finished_goods_reservation', v_reservation, 'status_change', 'status', null, 'aktiv', v_actor);
    else
      update order_items
      set status = 'WartetAufMaterial', updated_at = now()
      where id = v_item.id;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('order_item', v_item.id, 'status_change', 'status', 'Offen', 'WartetAufMaterial', v_actor);
    end if;
  end loop;

  -- 3. Bestellstatus ---------------------------------------------------------
  -- Confirmed nur, wenn jede aktive Position eine aktive Reservierung hat.
  select not exists (
    select 1 from order_items oi
    where oi.order_id = p_order_id
      and oi.status <> 'Storniert'
      and not exists (
        select 1 from finished_goods_reservations r
        where r.order_item_id = oi.id and r.status = 'aktiv'
      )
  ) into v_all_reserved;

  if v_all_reserved then
    update orders
    set status = 'Confirmed', confirmed_at = now(), updated_at = now()
    where id = p_order_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('order', p_order_id, 'status_change', 'status', 'New', 'Confirmed', v_actor);

    v_final_status := 'Confirmed';
  else
    v_final_status := 'New';
  end if;

  -- 4. Ergebnisübersicht -----------------------------------------------------
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'order_item_id', oi.id,
             'status',        oi.status,
             'reserved',      exists (
                                select 1 from finished_goods_reservations r
                                where r.order_item_id = oi.id and r.status = 'aktiv'
                              )
           ) order by oi.created_at, oi.id
         ), '[]'::jsonb)
    into v_items
  from order_items oi
  where oi.order_id = p_order_id;

  return jsonb_build_object(
    'order_status', v_final_status,
    'items',        v_items
  );
end;
$$;

-- Admin-Aktion: nur authenticated, ausdrücklich nicht anon.
revoke all on function fn_confirm_order(uuid) from public;
revoke all on function fn_confirm_order(uuid) from anon;
grant execute on function fn_confirm_order(uuid) to authenticated;
