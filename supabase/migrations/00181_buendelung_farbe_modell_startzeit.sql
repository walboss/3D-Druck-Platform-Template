-- Migration 00181: Bündelung nach Farbe/Modell + Startzeit automatisch beim Klick
-- Rückfrage/Präzisierung von Betreiber zu Migration 0180 (2026-09-21, per Chat).
--
-- ABSCHNITT A: fn_confirm_order — Bündelung nur bei gleicher Konfiguration
-- -----------------------------------------------------------------------
-- Bisher (0180): jede unzugeordnete 'Offen'-Position landete im ERSTEN
-- gefundenen wartenden ('Geplant') X2D-Auftrag, unabhängig davon, welches
-- Modell/welche Farbe dort bereits liegt. Korrektur: Bündelung nur, wenn ein
-- wartender X2D-Auftrag bereits eine Position mit EXAKT derselben
-- variant_configuration_id enthält — die kapselt bereits Modell (über
-- variant_id → product_variants → products) UND Farbe/Finish (über
-- variant_configuration_colors, siehe fn_create_variant_configuration_if_missing
-- in 00141: dieselbe Farbkombination auf derselben Variante bekommt IMMER
-- dieselbe variant_configuration_id, nie eine neue). Für jede in dieser
-- Bestellung neu auftretende Konfiguration ohne passenden wartenden Auftrag
-- wird ein eigener neuer X2D-Auftrag angelegt.
--
-- Ausnahmepfad-Positionen (variant_configuration_id IS NULL, individuelle
-- Anfragen ohne Katalogbezug) haben kein Modell/keine Farbe zum Abgleichen —
-- sie werden weiterhin gebündelt, aber nur untereinander (NULL gilt als eigene
-- Gruppe, IS NOT DISTINCT FROM-Vergleich), nie mit einer Katalog-Konfiguration
-- vermischt.
create or replace function fn_confirm_order(
  p_order_id uuid,
  p_actor    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor              text := coalesce(p_actor, auth.uid()::text, 'system');
  v_order_status       order_status;
  v_item               record;
  v_stock              int;
  v_reserved           int;
  v_reservation        uuid;
  v_all_reserved       boolean;
  v_final_status       order_status;
  v_items              jsonb;
  v_x2d_printer_id     uuid;
  v_production_order_id uuid;
  v_config_group       record;
  v_unassigned_item    record;
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

  -- 2. Reservierungsversuch je offener / wartender Position -------------------
  -- Ausnahmepfad-Positionen (variant_configuration_id IS NULL) nehmen NICHT
  -- teil: es gibt für sie strukturell nie Fertigwarenbestand (individuell
  -- gefertigte Einzelstücke ohne Katalogbezug, angebote-individuelle-
  -- anfragen.md §3) — kein Reservierungsversuch, kein Statuswechsel, sie
  -- bleiben auf ihrem aktuellen Status stehen.
  for v_item in
    select oi.id, oi.variant_configuration_id, oi.qty, oi.status
    from order_items oi
    where oi.order_id = p_order_id
      and oi.status in ('Offen', 'WartetAufMaterial')
      and oi.variant_configuration_id is not null
    order by oi.variant_configuration_id, oi.id   -- feste Sperrreihenfolge
  loop
    -- bereits reserviert (Wiederholungsaufruf) → nichts tun
    if exists (
      select 1 from finished_goods_reservations r
      where r.order_item_id = v_item.id and r.status = 'aktiv'
    ) then
      continue;
    end if;

    -- Sperre auf die Konfiguration (siehe Sperrstrategie in 00142/00148)
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

    if (v_stock - v_reserved) >= v_item.qty then
      -- alles-oder-nichts je Position: volle Menge reservieren
      insert into finished_goods_reservations
        (variant_configuration_id, stock_type, order_item_id, qty, status)
      values
        (v_item.variant_configuration_id, 'normal', v_item.id, v_item.qty, 'aktiv')
      returning id into v_reservation;

      -- fertigwarenbestand.md §4: jeder Reservierungsübergang mit Audit-Eintrag
      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('finished_goods_reservation', v_reservation, 'status_change', 'status', null, 'aktiv', v_actor);

      -- Retry-Erfolg: wartende Position zurück auf 'Offen' (wie regulär reserviert)
      if v_item.status = 'WartetAufMaterial' then
        update order_items
        set status = 'Offen', updated_at = now()
        where id = v_item.id;

        insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
        values ('order_item', v_item.id, 'status_change', 'status', 'WartetAufMaterial', 'Offen', v_actor);
      end if;
    elsif v_item.status = 'Offen' then
      update order_items
      set status = 'WartetAufMaterial', updated_at = now()
      where id = v_item.id;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('order_item', v_item.id, 'status_change', 'status', 'Offen', 'WartetAufMaterial', v_actor);
    end if;
    -- (bereits wartende Position ohne ausreichenden Bestand: unverändert)
  end loop;

  -- 3. Bestellstatus -----------------------------------------------------------
  -- Confirmed, wenn JEDE aktive (nicht stornierte) Position entweder eine
  -- aktive Reservierung hat ODER eine Ausnahmepfad-Position ist (s. o.) —
  -- Ausnahmepfad-Positionen blockieren Confirmed nicht.
  select not exists (
    select 1 from order_items oi
    where oi.order_id = p_order_id
      and oi.status <> 'Storniert'
      and oi.variant_configuration_id is not null
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

    -- 3b. Automatische Produktionszuordnung auf Drucker X2D (0180), gebündelt
    --     nur bei exakt gleicher variant_configuration_id (= gleiches Modell
    --     UND gleiche Farbe/Finish, 00141) — Korrektur aus 00181.
    select p.id into v_x2d_printer_id
    from printers p
    where p.name = 'X2D'
    limit 1;

    if v_x2d_printer_id is not null then
      for v_config_group in
        select distinct oi.variant_configuration_id
        from order_items oi
        where oi.order_id = p_order_id
          and oi.status = 'Offen'
          and oi.production_order_id is null
      loop
        -- Bündeln: wartenden ('Geplant') X2D-Auftrag mit derselben
        -- Konfiguration wiederverwenden (NULL bündelt nur mit NULL).
        select po.id into v_production_order_id
        from production_orders po
        where po.printer_id = v_x2d_printer_id
          and po.status = 'Geplant'
          and exists (
            select 1 from order_items oi2
            where oi2.production_order_id = po.id
              and oi2.variant_configuration_id is not distinct from v_config_group.variant_configuration_id
          )
        order by po.created_at
        limit 1
        for update;

        if v_production_order_id is null then
          v_production_order_id := fn_create_production_order(v_x2d_printer_id, null, v_actor);
        end if;

        for v_unassigned_item in
          select oi.id
          from order_items oi
          where oi.order_id = p_order_id
            and oi.status = 'Offen'
            and oi.production_order_id is null
            and oi.variant_configuration_id is not distinct from v_config_group.variant_configuration_id
          order by oi.created_at, oi.id
        loop
          perform fn_assign_to_production(v_unassigned_item.id, v_production_order_id);
        end loop;
      end loop;
    end if;
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

revoke all on function fn_confirm_order(uuid, text) from public;
revoke all on function fn_confirm_order(uuid, text) from anon;
grant execute on function fn_confirm_order(uuid, text) to authenticated;

-- ABSCHNITT B: fn_start_production_order — Startzeit automatisch mit Klick
-- -----------------------------------------------------------------------
-- Bisher musste planned_start (seit 0180 nullable) irgendwie manuell
-- nachgetragen werden, es gab dafür aber gar keine UI. Präzisierung Betreiber:
-- der Klick auf "Produktion starten" soll die Startzeit gleich mit
-- übernehmen. War planned_start noch nicht gesetzt (NULL, der
-- Auto-angelegte "wartend"-Fall aus 0180), wird sie beim tatsächlichen Start
-- auf denselben Zeitpunkt wie actual_start gesetzt. War bereits eine
-- Startzeit hinterlegt (z. B. später per DB durch den Admin vorgeplant),
-- bleibt sie unangetastet — nur die tatsächliche Spulenwahl/Reservierung ist
-- Inhalt dieser Funktion (Prinzip #18, unverändert).
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

  -- 6. Auftrag: Geplant → Laeuft, Startzeit mit übernehmen (00181) -----------
  update production_orders
  set status       = 'Laeuft',
      actual_start = v_now,
      planned_start = coalesce(planned_start, v_now),
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
