-- Migration 00144: RPC-Funktionen Abschluss & Stornierung, Teil 4
-- (fn_add_position_to_running_order, fn_ready_for_pickup, fn_hand_over_order,
--  fn_cancel_order_item, fn_cancel_order)
-- Siehe specs/implementierungsplan-schritt9.md §4 (Bestellfluss),
-- specs/bestellungen.md §3-§5 (keine Teilabholung #20, Stornierungsgrund
-- Pflicht #32, Randfall "Stornierung während Produktion"),
-- specs/fertigwarenbestand.md §3-§5 (Übergabe, Freigabe bei Storno, Randfall
-- "Storno nach Produktion, vor Übergabe"), specs/filament-material.md §4
-- (Reservierung freigeben bei Storno), specs/kunden-warenkorb-tracking.md
-- §2-§3 (anonymize_after bei HandedOver), specs/produktion.md §4 (Teilausfall,
-- Nachproduktion im selben Auftrag).
--
-- Prinzipien: #1 (nichts löschen — Storno = Statuswechsel, Bewegungen bleiben),
-- #19 (keine automatische Stornierung nicht abgeholter Bestellungen — hier
-- gibt es keinen Timeout-Pfad), #20 (keine Teilabholung, serverseitig
-- geprüft), #31 (Statuswechsel + Folgeaktionen atomar), #32 (Grund Pflicht
-- auf Positions- und Bestellungsebene).
--
-- Entscheidungen aus Task-Rückfragen (Teil 4):
--   (R1) fn_cancel_order_item hat eine Folgeaktion auf Bestellebene: bleibt
--        keine aktive Position übrig → orders 'Cancelled' (gleicher Grund);
--        sind alle verbleibenden aktiven Positionen 'Fertig' und die
--        Bestellung 'InProduction' → orders 'Finished'.
--   (R2) fn_add_position_to_running_order: qty_planned = order_items.qty −
--        Σ qty_success bereits abgeschlossener Batch-Items (Restmenge).
--   (R3) fn_hand_over_order: 'Fertig'-Katalogposition OHNE aktive
--        finished_goods_reservation → 'uebergabe'-Bewegung mit −qty direkt,
--        ohne Reservierungswechsel (Bestand bleibt korrekt).
--
-- Keine RLS-Policies hier (kommen in Migration 0015).
-- Nicht enthalten: Angebots-/Kalkulationsfunktionen, fn_retry_pending_
-- reservations (Teil 5), Abschluss eines production_order.

-- ===========================================================================
-- Interne Hilfsfunktionen (nicht per RPC aufrufbar)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_release_reservations_for_item_internal(p_order_item_id, p_actor) → jsonb
--   { "finished_goods_reservations": [uuid...], "filament_reservations": [uuid...] }
-- ---------------------------------------------------------------------------
-- Gibt ALLE aktiven Reservierungen einer Position frei (fertigwarenbestand.md
-- §4, filament-material.md §4): status → 'freigegeben', released_at = now().
-- Es wird KEINE Bewegung rückgängig gemacht (fertigwarenbestand.md §5:
-- produzierte Ware bleibt im Bestand, #1). Audit je Reservierung.
-- Wird von fn_cancel_order_item (Storno-Position) und fn_cancel_order
-- (auch für 'Fertig'-Positionen, deren Bestand wieder verfügbar werden
-- soll) verwendet.
create or replace function fn_release_reservations_for_item_internal(
  p_order_item_id uuid,
  p_actor         text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now    timestamptz := now();
  v_r      record;
  v_fg     jsonb := '[]'::jsonb;
  v_fil    jsonb := '[]'::jsonb;
begin
  for v_r in
    update finished_goods_reservations r
    set status = 'freigegeben', released_at = v_now, updated_at = v_now
    where r.order_item_id = p_order_item_id
      and r.status = 'aktiv'
    returning r.id
  loop
    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('finished_goods_reservation', v_r.id, 'status_change', 'status', 'aktiv', 'freigegeben', p_actor);
    v_fg := v_fg || to_jsonb(v_r.id);
  end loop;

  for v_r in
    update filament_reservations r
    set status = 'freigegeben', released_at = v_now, updated_at = v_now
    where r.order_item_id = p_order_item_id
      and r.status = 'aktiv'
    returning r.id
  loop
    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('filament_reservation', v_r.id, 'status_change', 'status', 'aktiv', 'freigegeben', p_actor);
    v_fil := v_fil || to_jsonb(v_r.id);
  end loop;

  return jsonb_build_object(
    'finished_goods_reservations', v_fg,
    'filament_reservations',       v_fil
  );
end;
$$;

revoke all on function fn_release_reservations_for_item_internal(uuid, text) from public;
revoke all on function fn_release_reservations_for_item_internal(uuid, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- fn_cancel_order_item_internal(p_order_item_id, p_reason, p_actor) → uuid (order_id)
-- ---------------------------------------------------------------------------
-- Kern der Positionsstornierung OHNE Folgeaktion auf Bestellebene — wird von
-- fn_cancel_order_item (mit Folgeaktion R1) und fn_cancel_order (Bestellung
-- setzt ihren Status selbst) verwendet.
--   - p_reason Pflicht (#32).
--   - Nur vor 'Fertig' (bestellungen.md §4): erlaubt aus 'Offen',
--     'WartetAufMaterial', 'InProduktion'. 'Fertig'/'Storniert' → Exception.
--   - status → 'Storniert', cancellation_reason; Audit (reason im Audit).
--   - Alle aktiven Reservierungen freigeben (siehe oben).
create or replace function fn_cancel_order_item_internal(
  p_order_item_id uuid,
  p_reason        text,
  p_actor         text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item   record;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_reason is null then
    raise exception 'Stornierungsgrund ist Pflicht (#32) — p_reason darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select oi.id, oi.order_id, oi.status
    into v_item
  from order_items oi
  where oi.id = p_order_item_id
  for update;

  if not found then
    raise exception 'Bestellposition % existiert nicht', p_order_item_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_item.status not in ('Offen', 'WartetAufMaterial', 'InProduktion') then
    raise exception 'Bestellposition % hat Status % — Stornierung ist nur vor ''Fertig'' möglich (Offen, WartetAufMaterial, InProduktion)',
      p_order_item_id, v_item.status
      using errcode = 'check_violation';
  end if;

  update order_items
  set status              = 'Storniert',
      cancellation_reason = v_reason,
      updated_at          = now()
  where id = p_order_item_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
  values ('order_item', p_order_item_id, 'status_change', 'status',
          v_item.status::text, 'Storniert', v_reason, p_actor);

  -- Reservierungen freigeben; produzierte Ware bleibt im Bestand (#1).
  perform fn_release_reservations_for_item_internal(p_order_item_id, p_actor);

  return v_item.order_id;
end;
$$;

revoke all on function fn_cancel_order_item_internal(uuid, text, text) from public;
revoke all on function fn_cancel_order_item_internal(uuid, text, text) from anon, authenticated;

-- ===========================================================================
-- Öffentliche RPC-Funktionen (authenticated)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_add_position_to_running_order(p_order_item_id, p_spool_assignments) → jsonb
--   p_spool_assignments: [ { "spool_id": uuid, "amount_g": numeric }, ... ]
--   Rückgabe: { "order_item_id", "production_order_id",
--               "production_batch_item_id", "qty_planned",
--               "reservations": [ { "reservation_id", "spool_id", "amount_g" } ] }
-- ---------------------------------------------------------------------------
-- Schließt die Lücke aus Teil 3: fn_start_production_order reserviert nur
-- beim Übergang 'Geplant' → 'Laeuft'. Eine Position, die per
-- fn_assign_to_production einem bereits LAUFENDEN Auftrag zugeordnet wurde
-- (bestellungen.md §3: ausdrücklich erlaubt), bekommt hiermit ihre
-- Filamentreservierung + production_batch_item. Deckt ebenso die
-- Nachproduktion ab (produktion.md §4): weiteres Batch-Item im SELBEN Auftrag.
--
-- Voraussetzungen (sonst Exception):
--   - order_items.status = 'InProduktion', production_order_id gesetzt,
--   - production_orders.status = 'Laeuft',
--   - kein offenes Batch-Item (qty_success IS NULL) für diese Position,
--   - Restmenge (qty − Σ qty_success abgeschlossener Batch-Items) > 0 (R2).
--
-- Spulenwahl NUR durch den Admin (#18): kommt vollständig als Parameter;
-- filament_spools wird nur gelesen, um die übergebene spool_id zu prüfen.
--
-- Sperrstrategie (#5) — identisch zu fn_start_production_order (00143):
--   SELECT ... FOR UPDATE auf die filament_spools-Zeile, ERST DANACH
--   Restbestand (initial_weight_g + Σ movements) und Σ aktive Reservierungen
--   summieren, dann INSERT. Zeilensperren auf den Summanden verhindern keine
--   Phantome, die Spulenzeile ist der eine gemeinsame Sperrpunkt aller
--   Konkurrenten um dieselbe Menge. Feste Sperrreihenfolge nach spool_id
--   (Deadlock-Vermeidung, gleiche Ordnung wie in 00143). Alles-oder-nichts je
--   Zuordnung; reicht eine nicht → Exception → Gesamt-Rollback.
create or replace function fn_add_position_to_running_order(
  p_order_item_id     uuid,
  p_spool_assignments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        text := coalesce(auth.uid()::text, 'system');
  v_item         record;
  v_po_status    production_order_status;
  v_done         int;
  v_qty_planned  int;
  v_assign       record;
  v_spool_active boolean;
  v_rest         numeric;
  v_reserved     numeric;
  v_available    numeric;
  v_batch_id     uuid;
  v_reservation  uuid;
  v_res_json     jsonb := '[]'::jsonb;
begin
  -- 1. Position + Auftrag sperren und prüfen ---------------------------------
  select oi.id, oi.qty, oi.status, oi.production_order_id
    into v_item
  from order_items oi
  where oi.id = p_order_item_id
  for update;

  if not found then
    raise exception 'Bestellposition % existiert nicht', p_order_item_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_item.status <> 'InProduktion' or v_item.production_order_id is null then
    raise exception 'Bestellposition % hat Status % / production_order_id % — sie muss ''InProduktion'' und einem Auftrag zugeordnet sein (fn_assign_to_production)',
      p_order_item_id, v_item.status, v_item.production_order_id
      using errcode = 'check_violation';
  end if;

  select po.status into v_po_status
  from production_orders po
  where po.id = v_item.production_order_id
  for update;

  if v_po_status <> 'Laeuft' then
    raise exception 'Produktionsauftrag % hat Status % — nur bei ''Laeuft'' möglich (bei ''Geplant'' übernimmt fn_start_production_order die Reservierung)',
      v_item.production_order_id, v_po_status
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from production_batch_items b
    where b.order_item_id = p_order_item_id and b.qty_success is null
  ) then
    raise exception 'Bestellposition % hat bereits ein offenes (nicht abgeschlossenes) production_batch_item',
      p_order_item_id
      using errcode = 'check_violation';
  end if;

  -- Restmenge (R2): qty − Σ qty_success abgeschlossener Batch-Items
  select coalesce(sum(b.qty_success), 0) into v_done
  from production_batch_items b
  where b.order_item_id = p_order_item_id;

  v_qty_planned := v_item.qty - v_done;

  if v_qty_planned <= 0 then
    raise exception 'Bestellposition %: Menge bereits erreicht (% von % erfolgreich) — keine Nachproduktion nötig',
      p_order_item_id, v_done, v_item.qty
      using errcode = 'check_violation';
  end if;

  -- 2. Parameter validieren --------------------------------------------------
  if p_spool_assignments is null
     or jsonb_typeof(p_spool_assignments) <> 'array'
     or jsonb_array_length(p_spool_assignments) = 0 then
    raise exception 'p_spool_assignments muss ein nicht-leeres JSON-Array [{spool_id, amount_g}, ...] sein (Spulenwahl durch den Admin, #18)'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_assign in
    select a.ord,
           nullif(a.e->>'spool_id', '') as spool_id_txt,
           nullif(a.e->>'amount_g', '') as amount_g_txt
    from jsonb_array_elements(p_spool_assignments) with ordinality as a(e, ord)
  loop
    if v_assign.spool_id_txt is null or v_assign.amount_g_txt is null then
      raise exception 'Zuordnung #%: spool_id und amount_g sind Pflicht', v_assign.ord
        using errcode = 'invalid_parameter_value';
    end if;

    if v_assign.amount_g_txt::numeric <= 0 then
      raise exception 'Zuordnung #%: amount_g muss > 0 sein (ist %)', v_assign.ord, v_assign.amount_g_txt
        using errcode = 'invalid_parameter_value';
    end if;

    select s.active into v_spool_active
    from filament_spools s
    where s.id = v_assign.spool_id_txt::uuid;

    if not found then
      raise exception 'Zuordnung #%: Spule % existiert nicht', v_assign.ord, v_assign.spool_id_txt
        using errcode = 'invalid_parameter_value';
    end if;

    if not v_spool_active then
      raise exception 'Zuordnung #%: Spule % ist deaktiviert', v_assign.ord, v_assign.spool_id_txt
        using errcode = 'check_violation';
    end if;
  end loop;

  -- 3. Batch-Item -------------------------------------------------------------
  insert into production_batch_items (production_order_id, order_item_id, qty_planned)
  values (v_item.production_order_id, p_order_item_id, v_qty_planned)
  returning id into v_batch_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('production_batch_item', v_batch_id, 'create', 'qty_planned', null, v_qty_planned::text, v_actor);

  -- 4. Reservierungen (Sperrstrategie siehe Kommentar oben) ------------------
  for v_assign in
    select (e->>'spool_id')::uuid    as spool_id,
           (e->>'amount_g')::numeric as amount_g
    from jsonb_array_elements(p_spool_assignments) e
    order by (e->>'spool_id')::uuid   -- feste Sperrreihenfolge
  loop
    perform 1 from filament_spools s
    where s.id = v_assign.spool_id
    for update;

    select s.initial_weight_g + coalesce((
             select sum(m.amount_g) from filament_movements m where m.spool_id = s.id
           ), 0)
      into v_rest
    from filament_spools s
    where s.id = v_assign.spool_id;

    select coalesce(sum(r.amount_g), 0) into v_reserved
    from filament_reservations r
    where r.spool_id = v_assign.spool_id
      and r.status = 'aktiv';

    v_available := v_rest - v_reserved;

    if v_available < v_assign.amount_g then
      raise exception 'Spule %: nicht genug Filament für Bestellposition % — benötigt % g, verfügbar % g (Restbestand % g, davon % g bereits reserviert). Nichts angelegt.',
        v_assign.spool_id, p_order_item_id, v_assign.amount_g,
        v_available, v_rest, v_reserved
        using errcode = 'check_violation';
    end if;

    insert into filament_reservations
      (spool_id, order_item_id, production_batch_item_id, amount_g, status)
    values
      (v_assign.spool_id, p_order_item_id, v_batch_id, v_assign.amount_g, 'aktiv')
    returning id into v_reservation;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('filament_reservation', v_reservation, 'status_change', 'status', null, 'aktiv', v_actor);

    v_res_json := v_res_json || jsonb_build_object(
      'reservation_id', v_reservation,
      'spool_id',       v_assign.spool_id,
      'amount_g',       v_assign.amount_g
    );
  end loop;

  return jsonb_build_object(
    'order_item_id',            p_order_item_id,
    'production_order_id',      v_item.production_order_id,
    'production_batch_item_id', v_batch_id,
    'qty_planned',              v_qty_planned,
    'reservations',             v_res_json
  );
end;
$$;

revoke all on function fn_add_position_to_running_order(uuid, jsonb) from public;
revoke all on function fn_add_position_to_running_order(uuid, jsonb) from anon;
grant execute on function fn_add_position_to_running_order(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_ready_for_pickup(p_order_id) → void
-- ---------------------------------------------------------------------------
-- 'Finished' → 'ReadyForPickup'. Serverseitige Prüfung "keine Teilabholung"
-- (#20, bestellungen.md §3): ALLE aktiven (nicht stornierten) Positionen
-- müssen 'Fertig' sein — sonst Exception mit Liste der offenen Positionen.
-- Setzt ready_for_pickup_at, Audit. Kein Timeout-Pfad (#19).
create or replace function fn_ready_for_pickup(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  text := coalesce(auth.uid()::text, 'system');
  v_status order_status;
  v_open   text;
  v_now    timestamptz := now();
begin
  select o.status into v_status
  from orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Bestellung % existiert nicht', p_order_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_status <> 'Finished' then
    raise exception 'Bestellung % hat Status % — ''ReadyForPickup'' ist nur aus ''Finished'' möglich',
      p_order_id, v_status
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from order_items oi
    where oi.order_id = p_order_id and oi.status <> 'Storniert'
  ) then
    raise exception 'Bestellung % hat keine aktiven (nicht stornierten) Positionen', p_order_id
      using errcode = 'check_violation';
  end if;

  -- #20: keine Teilabholung — jede aktive Position muss 'Fertig' sein
  select string_agg(oi.id::text || ' (' || oi.status::text || ')', ', ' order by oi.created_at, oi.id)
    into v_open
  from order_items oi
  where oi.order_id = p_order_id
    and oi.status not in ('Fertig', 'Storniert');

  if v_open is not null then
    raise exception 'Bestellung %: keine Teilabholung (#20) — noch nicht fertige Positionen: %',
      p_order_id, v_open
      using errcode = 'check_violation';
  end if;

  update orders
  set status              = 'ReadyForPickup',
      ready_for_pickup_at = v_now,
      updated_at          = v_now
  where id = p_order_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('order', p_order_id, 'status_change', 'status', 'Finished', 'ReadyForPickup', v_actor);
end;
$$;

revoke all on function fn_ready_for_pickup(uuid) from public;
revoke all on function fn_ready_for_pickup(uuid) from anon;
grant execute on function fn_ready_for_pickup(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_hand_over_order(p_order_id, p_handed_over_by, p_handover_note) → void
-- ---------------------------------------------------------------------------
-- 'ReadyForPickup' → 'HandedOver'. handed_over_by ist Pflicht (admins.id),
-- handover_note optional.
--
-- Folgeaktionen (atomar, #31):
--   1. Je aktiver finished_goods_reservation der Bestellung: status →
--      'verbraucht_bei_uebergabe' UND finished_goods_movements 'uebergabe'
--      mit qty_delta = −qty (Konfiguration/stock_type aus der Reservierung,
--      reference order_item) — endgültige Entnahme (fertigwarenbestand.md §3).
--   2. (R3) 'Fertig'-Katalogposition OHNE aktive Reservierung (z. B. Pfad
--      WartetAufMaterial → produziert → Fertig, bevor Teil 5 die
--      Reservierung nachholt): 'uebergabe'-Bewegung mit −order_items.qty,
--      stock_type 'normal', direkt — damit der Bestand die physisch
--      übergebene Ware widerspiegelt. Ausnahmepfad-Positionen (ohne
--      variant_configuration_id) haben keinen Fertigwarenbestand → nichts.
--   3. DSGVO-Kopplung (kunden-warenkorb-tracking.md §2/§3):
--      customers.anonymize_after = greatest(coalesce(anonymize_after,
--      current_date), current_date + settings.customer_data_retention_days)
--      (synchron, kein Cron). Die Frist kann dadurch nur nach hinten
--      verschoben werden, nie nach vorn — Schutz gegen versehentliche
--      Frühlöschung bei verkürzter Retention-Einstellung (Entscheidung
--      Task-Rückfrage). Die settings-Zeile muss existieren (ein Betreiber =
--      eine Instanz), sonst Exception — kein stiller Fallback auf einen Default.
--   4. Audit je Statuswechsel (order, Reservierungen) und je Bewegung.
create or replace function fn_hand_over_order(
  p_order_id       uuid,
  p_handed_over_by uuid,
  p_handover_note  text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       text := coalesce(auth.uid()::text, 'system');
  v_order       record;
  v_r           record;
  v_item        record;
  v_movement    uuid;
  v_retention   int;
  v_old_anon    date;
  v_new_anon    date;
  v_now         timestamptz := now();
begin
  -- 1. Bestellung sperren und prüfen ----------------------------------------
  select o.id, o.status, o.customer_id into v_order
  from orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Bestellung % existiert nicht', p_order_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_order.status <> 'ReadyForPickup' then
    raise exception 'Bestellung % hat Status % — Übergabe ist nur aus ''ReadyForPickup'' möglich',
      p_order_id, v_order.status
      using errcode = 'check_violation';
  end if;

  if p_handed_over_by is null then
    raise exception 'handed_over_by ist Pflicht (bestellungen.md §4)'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (select 1 from admins a where a.id = p_handed_over_by) then
    raise exception 'Admin % (handed_over_by) existiert nicht', p_handed_over_by
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. Reservierungen → verbraucht_bei_uebergabe + Bewegung 'uebergabe' ------
  for v_r in
    select r.id, r.variant_configuration_id, r.stock_type, r.order_item_id, r.qty
    from finished_goods_reservations r
    join order_items oi on oi.id = r.order_item_id
    where oi.order_id = p_order_id
      and r.status = 'aktiv'
    order by r.created_at, r.id
    for update of r
  loop
    update finished_goods_reservations
    set status = 'verbraucht_bei_uebergabe', updated_at = v_now
    where id = v_r.id;

    insert into finished_goods_movements
      (variant_configuration_id, stock_type, movement_type, qty_delta,
       reference_type, reference_id, created_by)
    values
      (v_r.variant_configuration_id, v_r.stock_type, 'uebergabe', -v_r.qty,
       'order_item', v_r.order_item_id, v_actor)
    returning id into v_movement;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values
      ('finished_goods_reservation', v_r.id, 'status_change', 'status',
       'aktiv', 'verbraucht_bei_uebergabe', v_actor),
      ('finished_goods_movement', v_movement, 'create', 'qty_delta',
       null, (-v_r.qty)::text, v_actor);
  end loop;

  -- 3. (R3) Fertig-Katalogpositionen ohne aktive Reservierung ---------------
  for v_item in
    select oi.id, oi.variant_configuration_id, oi.qty
    from order_items oi
    where oi.order_id = p_order_id
      and oi.status = 'Fertig'
      and oi.variant_configuration_id is not null
      and not exists (
        select 1 from finished_goods_reservations r
        where r.order_item_id = oi.id
          and r.status = 'verbraucht_bei_uebergabe'   -- gerade eben umgebucht
      )
    order by oi.created_at, oi.id
  loop
    insert into finished_goods_movements
      (variant_configuration_id, stock_type, movement_type, qty_delta,
       reference_type, reference_id, created_by)
    values
      (v_item.variant_configuration_id, 'normal', 'uebergabe', -v_item.qty,
       'order_item', v_item.id, v_actor)
    returning id into v_movement;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('finished_goods_movement', v_movement, 'create', 'qty_delta',
            null, (-v_item.qty)::text, v_actor);
  end loop;

  -- 4. Bestellung → HandedOver -----------------------------------------------
  update orders
  set status         = 'HandedOver',
      handed_over_at = v_now,
      handed_over_by = p_handed_over_by,
      handover_note  = nullif(trim(p_handover_note), ''),
      updated_at     = v_now
  where id = p_order_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('order', p_order_id, 'status_change', 'status', 'ReadyForPickup', 'HandedOver', v_actor);

  -- 5. DSGVO: anonymize_after ------------------------------------------------
  select s.customer_data_retention_days into v_retention
  from settings s
  order by s.created_at
  limit 1;

  if v_retention is null then
    raise exception 'settings.customer_data_retention_days nicht konfiguriert (keine settings-Zeile) — anonymize_after kann nicht gesetzt werden'
      using errcode = 'check_violation';
  end if;

  select c.anonymize_after into v_old_anon
  from customers c
  where c.id = v_order.customer_id
  for update;

  -- nur nach hinten verschieben, nie nach vorn
  v_new_anon := greatest(coalesce(v_old_anon, current_date), current_date + v_retention);

  update customers
  set anonymize_after = v_new_anon,
      updated_at      = v_now
  where id = v_order.customer_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('customer', v_order.customer_id, 'update', 'anonymize_after',
          v_old_anon::text, v_new_anon::text, v_actor);
end;
$$;

revoke all on function fn_hand_over_order(uuid, uuid, text) from public;
revoke all on function fn_hand_over_order(uuid, uuid, text) from anon;
grant execute on function fn_hand_over_order(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_cancel_order_item(p_order_item_id, p_reason) → void
-- ---------------------------------------------------------------------------
-- Positionsstornierung (Kern: fn_cancel_order_item_internal) mit Folgeaktion
-- auf Bestellebene (R1):
--   - bleibt keine aktive Position übrig → orders 'Cancelled' (gleicher
--     Grund), sofern die Bestellung nicht schon 'Cancelled'/'HandedOver' ist;
--   - sonst: Bestellung 'InProduction' und alle verbleibenden aktiven
--     Positionen 'Fertig' → orders 'Finished' (+ finished_at).
create or replace function fn_cancel_order_item(
  p_order_item_id uuid,
  p_reason        text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        text := coalesce(auth.uid()::text, 'system');
  v_order_id     uuid;
  v_order_status order_status;
  v_active       int;
  v_not_done     int;
  v_now          timestamptz := now();
begin
  v_order_id := fn_cancel_order_item_internal(p_order_item_id, p_reason, v_actor);

  -- Folgeaktion Bestellebene (R1)
  select o.status into v_order_status
  from orders o
  where o.id = v_order_id
  for update;

  select count(*) filter (where oi.status <> 'Storniert'),
         count(*) filter (where oi.status not in ('Storniert', 'Fertig'))
    into v_active, v_not_done
  from order_items oi
  where oi.order_id = v_order_id;

  if v_active = 0 then
    if v_order_status not in ('Cancelled', 'HandedOver') then
      update orders
      set status              = 'Cancelled',
          cancellation_reason = trim(p_reason),
          updated_at          = v_now
      where id = v_order_id;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
      values ('order', v_order_id, 'status_change', 'status',
              v_order_status::text, 'Cancelled', trim(p_reason), v_actor);
    end if;
  elsif v_not_done = 0 and v_order_status = 'InProduction' then
    update orders
    set status = 'Finished', finished_at = v_now, updated_at = v_now
    where id = v_order_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('order', v_order_id, 'status_change', 'status', 'InProduction', 'Finished', v_actor);
  end if;
end;
$$;

revoke all on function fn_cancel_order_item(uuid, text) from public;
revoke all on function fn_cancel_order_item(uuid, text) from anon;
grant execute on function fn_cancel_order_item(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_cancel_order(p_order_id, p_reason) → void
-- ---------------------------------------------------------------------------
-- Bestellstornierung, "jederzeit außer nach HandedOver" (bestellungen.md §4);
-- eine bereits stornierte Bestellung → Exception. p_reason Pflicht (#32).
--   - orders → 'Cancelled', cancellation_reason, Audit.
--   - Alle Positionen mit Status Offen/WartetAufMaterial/InProduktion werden
--     mit demselben Grund storniert (fn_cancel_order_item_internal — inkl.
--     Freigabe ihrer Reservierungen).
--   - 'Fertig'-Positionen werden NICHT storniert (bestellungen.md §5: die
--     produzierte Ware bleibt im Bestand und wird vom Admin eingeordnet),
--     aber ihre aktiven Reservierungen werden freigegeben, damit der Bestand
--     wieder verfügbar ist (fertigwarenbestand.md §5).
create or replace function fn_cancel_order(
  p_order_id uuid,
  p_reason   text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  text := coalesce(auth.uid()::text, 'system');
  v_reason text := nullif(trim(p_reason), '');
  v_status order_status;
  v_item   record;
  v_now    timestamptz := now();
begin
  if v_reason is null then
    raise exception 'Stornierungsgrund ist Pflicht (#32) — p_reason darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select o.status into v_status
  from orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Bestellung % existiert nicht', p_order_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_status = 'HandedOver' then
    raise exception 'Bestellung % ist bereits übergeben (HandedOver) — Stornierung nicht mehr möglich',
      p_order_id
      using errcode = 'check_violation';
  end if;

  if v_status = 'Cancelled' then
    raise exception 'Bestellung % ist bereits storniert', p_order_id
      using errcode = 'check_violation';
  end if;

  -- Positionen: nicht fertige stornieren, fertige nur freigeben
  for v_item in
    select oi.id, oi.status
    from order_items oi
    where oi.order_id = p_order_id
      and oi.status <> 'Storniert'
    order by oi.created_at, oi.id
  loop
    if v_item.status = 'Fertig' then
      perform fn_release_reservations_for_item_internal(v_item.id, v_actor);
    else
      perform fn_cancel_order_item_internal(v_item.id, v_reason, v_actor);
    end if;
  end loop;

  update orders
  set status              = 'Cancelled',
      cancellation_reason = v_reason,
      updated_at          = v_now
  where id = p_order_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
  values ('order', p_order_id, 'status_change', 'status', v_status::text, 'Cancelled', v_reason, v_actor);
end;
$$;

revoke all on function fn_cancel_order(uuid, text) from public;
revoke all on function fn_cancel_order(uuid, text) from anon;
grant execute on function fn_cancel_order(uuid, text) to authenticated;
