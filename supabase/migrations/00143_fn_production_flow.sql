-- Migration 00143: RPC-Funktionen Produktionsfluss, Teil 3
-- (fn_assign_to_production, fn_start_production_order, fn_complete_order_item)
-- Siehe specs/implementierungsplan-schritt9.md §4 (Bestellfluss),
-- specs/bestellungen.md §3 (Zwei-Schritte-Produktionsstart), §4 (Statusübergänge),
-- specs/produktion.md §2-§5 (Zwei-Schritte-Trennung, Teilausfall/Nachproduktion,
-- qty_success-Logik), specs/filament-material.md §2-§4 (Restbestand,
-- Verfügbarkeit, alles-oder-nichts, Statusübergänge), specs/fertigwarenbestand.md
-- §2-§4 (finished_goods_movements bei erfolgreicher Produktion).
--
-- Prinzipien: #3 (Planung/Reservierung/Realität getrennt: assign = Planung,
-- start = Reservierung, complete = Realität), #5 (Reservierung concurrency-
-- safe), #18 (keine automatische Spulenauswahl — die Spulenwahl kommt in
-- fn_start_production_order AUSSCHLIESSLICH als Parameter vom Admin; keine
-- Stelle in dieser Migration liest filament_spools, um eine Spule zu
-- *wählen*, sondern nur, um eine vom Admin genannte Spule zu prüfen), #25
-- (Produktionsauftrag bündelt mehrere Positionen), #30 (Material erst bei
-- Produktionsstart reserviert), #31 (Statuswechsel + Folgeaktionen atomar).
--
-- Keine RLS-Policies hier (kommen in Migration 0015).
-- Nicht enthalten: fn_ready_for_pickup, fn_hand_over_order, fn_cancel_*
-- (Teil 4), fn_retry_pending_reservations (Teil 5), Abschluss eines
-- production_order (separate Admin-Aktion, produktion.md §4).

-- ---------------------------------------------------------------------------
-- fn_assign_to_production(p_order_item_id, p_production_order_id) → void
-- ---------------------------------------------------------------------------
-- SCHRITT 1 der Zwei-Schritte-Trennung (bestellungen.md §3, produktion.md §3):
-- reiner Planungsschritt. Setzt order_items.production_order_id und
-- order_items.status → 'InProduktion'. KEINE Filamentreservierung, KEINE
-- Spulenwahl (#18, #30) — das passiert erst in fn_start_production_order.
--
-- Regeln:
--   - order_items.status muss 'Offen' oder 'WartetAufMaterial' sein
--     (WartetAufMaterial ist ein optionaler Zwischenzustand, bestellungen.md §3).
--   - Zielauftrag darf 'Geplant' ODER 'Laeuft' sein (Nachproduktion/Zuordnung
--     zu einem laufenden Auftrag ist ausdrücklich erlaubt, produktion.md §4).
--     'Abgeschlossen'/'Fehlgeschlagen' sind Endzustände → Exception.
--   - orders.status 'Confirmed' → 'InProduction', sobald die erste Position
--     'InProduktion' wird (bestellungen.md §4). Ist die Bestellung noch 'New'
--     (Position war 'WartetAufMaterial'), bleibt orders.status unverändert —
--     nur der Übergang aus 'Confirmed' ist definiert.
--   - Audit-Log je Statuswechsel (order_item, ggf. order) sowie für das
--     Setzen von production_order_id.
create or replace function fn_assign_to_production(
  p_order_item_id uuid,
  p_production_order_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Task: actor = auth.uid(). Fallback 'system' nur für Aufrufe ohne
  -- JWT-Kontext (z. B. Tests über die CLI / service_role).
  v_actor        text := coalesce(auth.uid()::text, 'system');
  v_item         record;
  v_po_status    production_order_status;
  v_order_status order_status;
begin
  -- 1. Position sperren und prüfen -------------------------------------------
  select oi.id, oi.order_id, oi.status, oi.production_order_id
    into v_item
  from order_items oi
  where oi.id = p_order_item_id
  for update;

  if not found then
    raise exception 'Bestellposition % existiert nicht', p_order_item_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_item.status not in ('Offen', 'WartetAufMaterial') then
    raise exception 'Bestellposition % hat Status % — Zuordnung zur Produktion ist nur aus ''Offen'' oder ''WartetAufMaterial'' möglich',
      p_order_item_id, v_item.status
      using errcode = 'check_violation';
  end if;

  -- 2. Zielauftrag prüfen ('Geplant' oder 'Laeuft') --------------------------
  select po.status into v_po_status
  from production_orders po
  where po.id = p_production_order_id
  for update;

  if not found then
    raise exception 'Produktionsauftrag % existiert nicht', p_production_order_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_po_status not in ('Geplant', 'Laeuft') then
    raise exception 'Produktionsauftrag % hat Status % — Zuordnung ist nur zu ''Geplant'' oder ''Laeuft'' möglich',
      p_production_order_id, v_po_status
      using errcode = 'check_violation';
  end if;

  -- 3. Planungsschritt: Zuordnung + Status -----------------------------------
  update order_items
  set production_order_id = p_production_order_id,
      status              = 'InProduktion',
      updated_at          = now()
  where id = p_order_item_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values
    ('order_item', p_order_item_id, 'status_change', 'status',
     v_item.status::text, 'InProduktion', v_actor),
    ('order_item', p_order_item_id, 'update', 'production_order_id',
     v_item.production_order_id::text, p_production_order_id::text, v_actor);

  -- 4. Bestellung: Confirmed → InProduction (bestellungen.md §4) -------------
  select o.status into v_order_status
  from orders o
  where o.id = v_item.order_id
  for update;

  if v_order_status = 'Confirmed' then
    update orders
    set status = 'InProduction', updated_at = now()
    where id = v_item.order_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('order', v_item.order_id, 'status_change', 'status', 'Confirmed', 'InProduction', v_actor);
  end if;
end;
$$;

-- Admin-Aktion: nur authenticated, ausdrücklich nicht anon.
revoke all on function fn_assign_to_production(uuid, uuid) from public;
revoke all on function fn_assign_to_production(uuid, uuid) from anon;
grant execute on function fn_assign_to_production(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_start_production_order(p_production_order_id, p_spool_assignments) → jsonb
--   p_spool_assignments: [ { "order_item_id": uuid, "spool_id": uuid,
--                            "amount_g": numeric }, ... ]
--   Rückgabe: { "production_order_id", "status", "actual_start",
--               "batch_items":  [ { "production_batch_item_id", "order_item_id",
--                                   "qty_planned" }, ... ],
--               "reservations": [ { "reservation_id", "order_item_id",
--                                   "production_batch_item_id", "spool_id",
--                                   "amount_g" }, ... ] }
-- ---------------------------------------------------------------------------
-- SCHRITT 2 der Zwei-Schritte-Trennung: production_orders 'Geplant' → 'Laeuft'.
-- Erst jetzt wird Filament reserviert (#30), für ALLE dem Auftrag
-- zugeordneten Positionen (produktion.md §3).
--
-- Prinzip #18 — Spulenwahl NUR durch den Admin:
--   Die Zuordnung "welche Spule, wie viel Gramm, für welche Position" kommt
--   vollständig als Parameter. Diese Funktion liest filament_spools nur, um
--   die übergebene spool_id zu validieren — sie sucht, sortiert oder schlägt
--   NIE selbst eine Spule vor. Auch ein Abgleich "passt die Spulenfarbe zur
--   Position?" findet bewusst nicht statt: das ist die Adminentscheidung.
--
-- Ablauf (eine Transaktion, jeder RAISE rollt ALLES zurück — kein Teilstart):
--   1. production_orders-Zeile FOR UPDATE, Status muss 'Geplant' sein.
--   2. Zugeordnete Positionen = order_items mit production_order_id = Auftrag
--      und status = 'InProduktion'. Mindestens eine, sonst Exception.
--   3. Parameter validieren: nicht-leeres Array; je Eintrag order_item_id
--      gehört zu den zugeordneten Positionen, spool_id existiert und ist
--      aktiv, amount_g > 0. Jede zugeordnete Position braucht mindestens eine
--      Zuordnung (mehrere sind erlaubt, z. B. mehrfarbige Teile), sonst
--      Exception — der Auftrag startet nur komplett.
--   4. Je zugeordneter Position eine production_batch_items-Zeile
--      (qty_planned = order_items.qty).
--   5. Je Zuordnung: Spule sperren, Verfügbarkeit prüfen, Reservierung
--      'aktiv' anlegen (alles-oder-nichts je Zuordnung, filament-material.md
--      §3; reicht es nicht → Exception → Gesamt-Rollback).
--   6. production_orders → 'Laeuft', actual_start = now().
--   7. Audit je Statuswechsel (Reservierung —→aktiv, Auftrag Geplant→Laeuft).
--
-- Sperrstrategie gegen Race-Conditions (#5) — gewählt: SELECT ... FOR UPDATE
-- auf die filament_spools-Zeile je Zuordnung:
--   Restbestand und Verfügbarkeit sind Summen über filament_movements und
--   filament_reservations (filament-material.md §2). Ein FOR UPDATE auf diesen
--   Summanden-Zeilen nützt nichts: Zeilensperren verhindern keine
--   gleichzeitigen INSERTs anderer Transaktionen (Phantome) — zwei parallele
--   Starts könnten beide "reicht" lesen und beide reservieren. Deshalb wird
--   die eine Zeile gesperrt, die alle Konkurrenten um dieselbe Menge zwingend
--   teilen: die filament_spools-Zeile. Erst NACH Erhalt dieser Sperre werden
--   Restbestand (initial_weight_g + Σ movements.amount_g) und aktive
--   Reservierungen summiert (unter READ COMMITTED bekommt jedes Statement
--   einen frischen Snapshot, sieht also alles, was der vorherige Sperrhalter
--   committed hat) und die Reservierung eingefügt — Prüfen und Anlegen sind
--   damit je Spule serialisiert. Die Sperre hält bis Commit/Rollback der
--   aufrufenden Transaktion; ein zweiter Starter wartet und sieht dann die
--   bereits angelegte Reservierung. Mehrere Zuordnungen auf dieselbe Spule
--   innerhalb EINES Aufrufs sehen einander ebenfalls (gleiche Transaktion),
--   die zweite rechnet also mit der bereits reduzierten Verfügbarkeit.
--   Deadlock-Vermeidung: Zuordnungen werden in fester Reihenfolge
--   (spool_id, order_item_id) verarbeitet, sodass zwei Aufrufe mit
--   überlappenden Spulen ihre Sperren in derselben Reihenfolge anfordern.
--   Zusätzlich sperrt FOR UPDATE auf production_orders den Auftrag selbst
--   gegen doppelten gleichzeitigen Start.
create or replace function fn_start_production_order(
  p_production_order_id uuid,
  p_spool_assignments   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor         text := coalesce(auth.uid()::text, 'system');
  v_po_status     production_order_status;
  v_item          record;
  v_assign        record;
  v_item_ids      uuid[] := '{}';   -- zugeordnete order_items (Index i)
  v_batch_ids     uuid[] := '{}';   -- zugehörige production_batch_items (Index i)
  v_idx           int;
  v_batch_id      uuid;
  v_spool_active  boolean;
  v_rest          numeric;
  v_reserved      numeric;
  v_available     numeric;
  v_reservation   uuid;
  v_now           timestamptz := now();
  v_missing       text;
  v_batch_json    jsonb := '[]'::jsonb;
  v_res_json      jsonb := '[]'::jsonb;
begin
  -- 1. Auftrag sperren und prüfen -------------------------------------------
  select po.status into v_po_status
  from production_orders po
  where po.id = p_production_order_id
  for update;

  if not found then
    raise exception 'Produktionsauftrag % existiert nicht', p_production_order_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_po_status <> 'Geplant' then
    raise exception 'Produktionsauftrag % hat Status % — Start ist nur aus ''Geplant'' möglich',
      p_production_order_id, v_po_status
      using errcode = 'check_violation';
  end if;

  -- 2. Zugeordnete Positionen (Schritt 1 muss erfolgt sein) ------------------
  for v_item in
    select oi.id
    from order_items oi
    where oi.production_order_id = p_production_order_id
      and oi.status = 'InProduktion'
    order by oi.created_at, oi.id
    for update
  loop
    v_item_ids := v_item_ids || v_item.id;
  end loop;

  if coalesce(array_length(v_item_ids, 1), 0) = 0 then
    raise exception 'Produktionsauftrag % hat keine zugeordneten Positionen (status ''InProduktion'')',
      p_production_order_id
      using errcode = 'check_violation';
  end if;

  -- 3. Parameter validieren --------------------------------------------------
  if p_spool_assignments is null
     or jsonb_typeof(p_spool_assignments) <> 'array'
     or jsonb_array_length(p_spool_assignments) = 0 then
    raise exception 'p_spool_assignments muss ein nicht-leeres JSON-Array [{order_item_id, spool_id, amount_g}, ...] sein (Spulenwahl durch den Admin, #18)'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_assign in
    select a.ord,
           nullif(a.e->>'order_item_id', '') as order_item_id_txt,
           nullif(a.e->>'spool_id', '')      as spool_id_txt,
           nullif(a.e->>'amount_g', '')      as amount_g_txt
    from jsonb_array_elements(p_spool_assignments) with ordinality as a(e, ord)
  loop
    if v_assign.order_item_id_txt is null
       or v_assign.spool_id_txt is null
       or v_assign.amount_g_txt is null then
      raise exception 'Zuordnung #%: order_item_id, spool_id und amount_g sind Pflicht', v_assign.ord
        using errcode = 'invalid_parameter_value';
    end if;

    if v_assign.amount_g_txt::numeric <= 0 then
      raise exception 'Zuordnung #%: amount_g muss > 0 sein (ist %)', v_assign.ord, v_assign.amount_g_txt
        using errcode = 'invalid_parameter_value';
    end if;

    if array_position(v_item_ids, v_assign.order_item_id_txt::uuid) is null then
      raise exception 'Zuordnung #%: Bestellposition % ist dem Produktionsauftrag % nicht (mehr) zugeordnet',
        v_assign.ord, v_assign.order_item_id_txt, p_production_order_id
        using errcode = 'invalid_parameter_value';
    end if;

    -- Nur Validierung der vom Admin genannten Spule — keine Auswahl (#18).
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

  -- Jede zugeordnete Position braucht mindestens eine Spulenzuordnung.
  select string_agg(i::text, ', ') into v_missing
  from unnest(v_item_ids) as i
  where not exists (
    select 1 from jsonb_array_elements(p_spool_assignments) e
    where (e->>'order_item_id')::uuid = i
  );

  if v_missing is not null then
    raise exception 'Ohne Spulenzuordnung: Bestellposition(en) % — der Auftrag startet nur, wenn jede zugeordnete Position eine Spulenwahl hat',
      v_missing
      using errcode = 'check_violation';
  end if;

  -- 4. production_batch_items je Position -----------------------------------
  for v_idx in 1 .. array_length(v_item_ids, 1) loop
    insert into production_batch_items (production_order_id, order_item_id, qty_planned)
    select p_production_order_id, oi.id, oi.qty
    from order_items oi
    where oi.id = v_item_ids[v_idx]
    returning id into v_batch_id;

    v_batch_ids := v_batch_ids || v_batch_id;

    v_batch_json := v_batch_json || jsonb_build_object(
      'production_batch_item_id', v_batch_id,
      'order_item_id',            v_item_ids[v_idx],
      'qty_planned',              (select oi.qty from order_items oi where oi.id = v_item_ids[v_idx])
    );
  end loop;

  -- 5. Reservierungen (Sperrstrategie siehe Kommentar oben) ------------------
  for v_assign in
    select (e->>'order_item_id')::uuid as order_item_id,
           (e->>'spool_id')::uuid      as spool_id,
           (e->>'amount_g')::numeric   as amount_g
    from jsonb_array_elements(p_spool_assignments) e
    order by (e->>'spool_id')::uuid, (e->>'order_item_id')::uuid   -- feste Sperrreihenfolge
  loop
    -- Sperre auf die Spule; erst danach summieren (#5)
    perform 1 from filament_spools s
    where s.id = v_assign.spool_id
    for update;

    -- Restbestand = initial_weight_g + Σ movements.amount_g
    select s.initial_weight_g + coalesce((
             select sum(m.amount_g) from filament_movements m where m.spool_id = s.id
           ), 0)
      into v_rest
    from filament_spools s
    where s.id = v_assign.spool_id;

    -- Verfügbar = Restbestand − Σ aktive Reservierungen
    select coalesce(sum(r.amount_g), 0) into v_reserved
    from filament_reservations r
    where r.spool_id = v_assign.spool_id
      and r.status = 'aktiv';

    v_available := v_rest - v_reserved;

    -- alles-oder-nichts je Zuordnung; Fehlschlag → Gesamt-Rollback
    if v_available < v_assign.amount_g then
      raise exception 'Spule %: nicht genug Filament für Bestellposition % — benötigt % g, verfügbar % g (Restbestand % g, davon % g bereits reserviert). Produktionsauftrag % wurde NICHT gestartet.',
        v_assign.spool_id, v_assign.order_item_id, v_assign.amount_g,
        v_available, v_rest, v_reserved, p_production_order_id
        using errcode = 'check_violation';
    end if;

    v_batch_id := v_batch_ids[array_position(v_item_ids, v_assign.order_item_id)];

    insert into filament_reservations
      (spool_id, order_item_id, production_batch_item_id, amount_g, status)
    values
      (v_assign.spool_id, v_assign.order_item_id, v_batch_id, v_assign.amount_g, 'aktiv')
    returning id into v_reservation;

    -- filament-material.md §4: jeder Reservierungsübergang mit Audit-Eintrag
    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('filament_reservation', v_reservation, 'status_change', 'status', null, 'aktiv', v_actor);

    v_res_json := v_res_json || jsonb_build_object(
      'reservation_id',           v_reservation,
      'order_item_id',            v_assign.order_item_id,
      'production_batch_item_id', v_batch_id,
      'spool_id',                 v_assign.spool_id,
      'amount_g',                 v_assign.amount_g
    );
  end loop;

  -- 6. Auftrag: Geplant → Laeuft ---------------------------------------------
  update production_orders
  set status       = 'Laeuft',
      actual_start = v_now,
      updated_at   = v_now
  where id = p_production_order_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('production_order', p_production_order_id, 'status_change', 'status', 'Geplant', 'Laeuft', v_actor);

  -- 7. Übersicht -------------------------------------------------------------
  return jsonb_build_object(
    'production_order_id', p_production_order_id,
    'status',              'Laeuft',
    'actual_start',        v_now,
    'batch_items',         v_batch_json,
    'reservations',        v_res_json
  );
end;
$$;

revoke all on function fn_start_production_order(uuid, jsonb) from public;
revoke all on function fn_start_production_order(uuid, jsonb) from anon;
grant execute on function fn_start_production_order(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_complete_order_item(p_production_batch_item_id, p_qty_success,
--                        p_qty_scrap_normal, p_qty_scrap_complaint,
--                        p_actual_material_usage) → jsonb
--   p_actual_material_usage: [ { "spool_id": uuid, "amount_g": numeric }, ... ]
--                            (tatsächlicher Verbrauch, positiv angegeben)
--   Rückgabe: { "production_batch_item_id", "order_item_id", "order_id",
--               "qty_success", "qty_scrap_normal", "qty_scrap_complaint",
--               "qty_success_total", "qty_required", "order_item_status",
--               "order_status", "production_order_status",
--               "filament_movements": [ { "filament_movement_id", "spool_id",
--                                         "amount_g" }, ... ],
--               "reservations_consumed": [uuid, ...],
--               "finished_goods_movement_id": uuid|null }
-- ---------------------------------------------------------------------------
-- REALITÄT (#3/#4): bucht das Ergebnis eines production_batch_item.
--
-- Ablauf (eine Transaktion, jeder RAISE rollt alles zurück — #31):
--   1. production_batch_items-Zeile FOR UPDATE; darf noch nicht abgeschlossen
--      sein (qty_success IS NULL); zugehöriger production_order muss 'Laeuft'
--      sein. Mengen: nicht null, >= 0.
--   2. qty_success / qty_scrap_normal / qty_scrap_complaint setzen (#28:
--      Reklamationsersatz getrennt vom regulären Ausschuss), Audit je Feld.
--   3. Tatsächlicher Materialverbrauch je Spule (#4): filament_movements
--      (movement_type='produktion', amount_g NEGATIV, reference_type=
--      'production_batch_item'), production_material_usage-Zeile, Audit je
--      Bewegung. Die Spule wird FOR UPDATE gesperrt (gleiche Sperrreihenfolge
--      wie in fn_start_production_order: spool_id), damit ein paralleler
--      Produktionsstart nicht zwischen Summieren und Buchen liest. Kein
--      Abgleich gegen den geplanten Bedarf (produktion.md §5: Abweichung ist
--      Reporting, keine Sperre); die Spule muss nicht zwingend eine der
--      reservierten sein (Realität ≠ Planung, #3).
--   4. Zugehörige filament_reservations (production_batch_item_id = dieses
--      Batch-Item, status 'aktiv') → 'verbraucht', Audit je Reservierung
--      (filament-material.md §4).
--   5. qty_success > 0 und Katalogposition (variant_configuration_id gesetzt):
--      finished_goods_movements 'produktion_erfolgreich', +qty_success,
--      stock_type 'normal', reference production_batch_item, Audit.
--      Ausnahmepfad-Positionen (desired_description, keine
--      variant_configuration) haben keinen Fertigwarenbestand → keine
--      Bewegung (analog fn_confirm_order).
--   6. order_items.status → 'Fertig' NUR, wenn Σ qty_success über ALLE
--      production_batch_items dieser Position >= order_items.qty
--      (produktion.md §3: nur Erfolg zählt, 5/8 ≠ 7/8) und die Position
--      aktuell 'InProduktion' ist. Audit.
--   7. orders.status 'InProduction' → 'Finished' (+ finished_at), wenn ALLE
--      aktiven (nicht stornierten) Positionen 'Fertig' sind. Audit.
--   production_orders.status bleibt 'Laeuft' — KEIN Auto-Abschluss bei
--   Teilausfall (produktion.md §4); Nachproduktion = weitere
--   production_batch_items im selben Auftrag; Abschluss ist eine separate
--   Admin-Aktion und nicht Teil dieser Funktion.
create or replace function fn_complete_order_item(
  p_production_batch_item_id uuid,
  p_qty_success              int,
  p_qty_scrap_normal         int,
  p_qty_scrap_complaint      int,
  p_actual_material_usage    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor          text := coalesce(auth.uid()::text, 'system');
  v_batch          record;
  v_po_status      production_order_status;
  v_item           record;
  v_order_status   order_status;
  v_usage          record;
  v_movement_id    uuid;
  v_fg_movement_id uuid;
  v_res            record;
  v_success_total  int;
  v_item_status    order_item_status;
  v_final_order    order_status;
  v_all_done       boolean;
  v_now            timestamptz := now();
  v_mov_json       jsonb := '[]'::jsonb;
  v_res_ids        jsonb := '[]'::jsonb;
begin
  -- 1. Batch-Item sperren und prüfen -----------------------------------------
  select b.id, b.production_order_id, b.order_item_id, b.qty_planned,
         b.qty_success, b.qty_scrap_normal, b.qty_scrap_complaint
    into v_batch
  from production_batch_items b
  where b.id = p_production_batch_item_id
  for update;

  if not found then
    raise exception 'production_batch_item % existiert nicht', p_production_batch_item_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_batch.qty_success is not null
     or v_batch.qty_scrap_normal is not null
     or v_batch.qty_scrap_complaint is not null then
    raise exception 'production_batch_item % ist bereits abgeschlossen (qty_success=%, qty_scrap_normal=%, qty_scrap_complaint=%) — Nachproduktion erhält eine neue Zeile im selben Auftrag',
      p_production_batch_item_id, v_batch.qty_success, v_batch.qty_scrap_normal, v_batch.qty_scrap_complaint
      using errcode = 'check_violation';
  end if;

  select po.status into v_po_status
  from production_orders po
  where po.id = v_batch.production_order_id
  for update;

  if v_po_status <> 'Laeuft' then
    raise exception 'Produktionsauftrag % hat Status % — Abschluss einer Position ist nur bei ''Laeuft'' möglich',
      v_batch.production_order_id, v_po_status
      using errcode = 'check_violation';
  end if;

  if p_qty_success is null or p_qty_scrap_normal is null or p_qty_scrap_complaint is null
     or p_qty_success < 0 or p_qty_scrap_normal < 0 or p_qty_scrap_complaint < 0 then
    raise exception 'qty_success, qty_scrap_normal und qty_scrap_complaint müssen angegeben und >= 0 sein'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_actual_material_usage is null or jsonb_typeof(p_actual_material_usage) <> 'array' then
    raise exception 'p_actual_material_usage muss ein JSON-Array [{spool_id, amount_g}, ...] sein'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Parameter vorab vollständig validieren, bevor gebucht wird.
  for v_usage in
    select a.ord,
           nullif(a.e->>'spool_id', '')  as spool_id_txt,
           nullif(a.e->>'amount_g', '')  as amount_g_txt
    from jsonb_array_elements(p_actual_material_usage) with ordinality as a(e, ord)
  loop
    if v_usage.spool_id_txt is null or v_usage.amount_g_txt is null then
      raise exception 'Verbrauch #%: spool_id und amount_g sind Pflicht', v_usage.ord
        using errcode = 'invalid_parameter_value';
    end if;

    if v_usage.amount_g_txt::numeric <= 0 then
      raise exception 'Verbrauch #%: amount_g muss > 0 sein (tatsächlicher Verbrauch, wird negativ gebucht)', v_usage.ord
        using errcode = 'invalid_parameter_value';
    end if;

    if not exists (select 1 from filament_spools s where s.id = v_usage.spool_id_txt::uuid) then
      raise exception 'Verbrauch #%: Spule % existiert nicht', v_usage.ord, v_usage.spool_id_txt
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  -- Position sperren (Statusentscheidung weiter unten)
  select oi.id, oi.order_id, oi.qty, oi.status, oi.variant_configuration_id
    into v_item
  from order_items oi
  where oi.id = v_batch.order_item_id
  for update;

  -- 2. Ergebnis auf dem Batch-Item -------------------------------------------
  update production_batch_items
  set qty_success         = p_qty_success,
      qty_scrap_normal    = p_qty_scrap_normal,
      qty_scrap_complaint = p_qty_scrap_complaint,
      updated_at          = v_now
  where id = p_production_batch_item_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values
    ('production_batch_item', p_production_batch_item_id, 'update', 'qty_success',         null, p_qty_success::text,         v_actor),
    ('production_batch_item', p_production_batch_item_id, 'update', 'qty_scrap_normal',    null, p_qty_scrap_normal::text,    v_actor),
    ('production_batch_item', p_production_batch_item_id, 'update', 'qty_scrap_complaint', null, p_qty_scrap_complaint::text, v_actor);

  -- 3. Tatsächlicher Materialverbrauch (#4) ----------------------------------
  for v_usage in
    select (e->>'spool_id')::uuid    as spool_id,
           (e->>'amount_g')::numeric as amount_g
    from jsonb_array_elements(p_actual_material_usage) e
    order by (e->>'spool_id')::uuid   -- gleiche Sperrreihenfolge wie beim Start
  loop
    perform 1 from filament_spools s
    where s.id = v_usage.spool_id
    for update;

    insert into filament_movements
      (spool_id, movement_type, amount_g, reference_type, reference_id, created_by)
    values
      (v_usage.spool_id, 'produktion', -v_usage.amount_g,
       'production_batch_item', p_production_batch_item_id, v_actor)
    returning id into v_movement_id;

    insert into production_material_usage
      (production_batch_item_id, spool_id, amount_g, filament_movement_id)
    values
      (p_production_batch_item_id, v_usage.spool_id, v_usage.amount_g, v_movement_id);

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('filament_movement', v_movement_id, 'create', 'amount_g', null, (-v_usage.amount_g)::text, v_actor);

    v_mov_json := v_mov_json || jsonb_build_object(
      'filament_movement_id', v_movement_id,
      'spool_id',             v_usage.spool_id,
      'amount_g',             -v_usage.amount_g
    );
  end loop;

  -- 4. Reservierungen → verbraucht (filament-material.md §4) -----------------
  for v_res in
    update filament_reservations r
    set status = 'verbraucht', updated_at = v_now
    where r.production_batch_item_id = p_production_batch_item_id
      and r.status = 'aktiv'
    returning r.id
  loop
    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('filament_reservation', v_res.id, 'status_change', 'status', 'aktiv', 'verbraucht', v_actor);

    v_res_ids := v_res_ids || to_jsonb(v_res.id);
  end loop;

  -- 5. Fertigware bei Erfolg (fertigwarenbestand.md §2) ----------------------
  if p_qty_success > 0 and v_item.variant_configuration_id is not null then
    insert into finished_goods_movements
      (variant_configuration_id, stock_type, movement_type, qty_delta,
       reference_type, reference_id, created_by)
    values
      (v_item.variant_configuration_id, 'normal', 'produktion_erfolgreich', p_qty_success,
       'production_batch_item', p_production_batch_item_id, v_actor)
    returning id into v_fg_movement_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('finished_goods_movement', v_fg_movement_id, 'create', 'qty_delta', null, p_qty_success::text, v_actor);
  end if;

  -- 6. Position: Fertig nur bei Σ qty_success >= qty (produktion.md §3) ------
  select coalesce(sum(b.qty_success), 0) into v_success_total
  from production_batch_items b
  where b.order_item_id = v_item.id;

  v_item_status := v_item.status;

  if v_item.status = 'InProduktion' and v_success_total >= v_item.qty then
    update order_items
    set status = 'Fertig', updated_at = v_now
    where id = v_item.id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('order_item', v_item.id, 'status_change', 'status', 'InProduktion', 'Fertig', v_actor);

    v_item_status := 'Fertig';
  end if;

  -- 7. Bestellung: alle aktiven Positionen Fertig → Finished -----------------
  select o.status into v_order_status
  from orders o
  where o.id = v_item.order_id
  for update;

  v_final_order := v_order_status;

  if v_item_status = 'Fertig' and v_order_status = 'InProduction' then
    select not exists (
      select 1 from order_items oi
      where oi.order_id = v_item.order_id
        and oi.status not in ('Fertig', 'Storniert')
    ) and exists (
      select 1 from order_items oi
      where oi.order_id = v_item.order_id
        and oi.status = 'Fertig'
    ) into v_all_done;

    if v_all_done then
      update orders
      set status = 'Finished', finished_at = v_now, updated_at = v_now
      where id = v_item.order_id;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('order', v_item.order_id, 'status_change', 'status', 'InProduction', 'Finished', v_actor);

      v_final_order := 'Finished';
    end if;
  end if;

  -- production_orders.status bleibt bewusst 'Laeuft' (kein Auto-Abschluss).
  return jsonb_build_object(
    'production_batch_item_id',   p_production_batch_item_id,
    'order_item_id',              v_item.id,
    'order_id',                   v_item.order_id,
    'qty_success',                p_qty_success,
    'qty_scrap_normal',           p_qty_scrap_normal,
    'qty_scrap_complaint',        p_qty_scrap_complaint,
    'qty_success_total',          v_success_total,
    'qty_required',               v_item.qty,
    'order_item_status',          v_item_status,
    'order_status',               v_final_order,
    'production_order_status',    v_po_status,
    'filament_movements',         v_mov_json,
    'reservations_consumed',      v_res_ids,
    'finished_goods_movement_id', v_fg_movement_id
  );
end;
$$;

revoke all on function fn_complete_order_item(uuid, int, int, int, jsonb) from public;
revoke all on function fn_complete_order_item(uuid, int, int, int, jsonb) from anon;
grant execute on function fn_complete_order_item(uuid, int, int, int, jsonb) to authenticated;
