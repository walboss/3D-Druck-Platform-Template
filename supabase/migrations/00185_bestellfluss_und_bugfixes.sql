-- Migration 00185: Bestellfluss-Korrektur + Bugfixes aus Funktionsprüfung
-- (2026-09-24)
--
-- Explizite Adminentscheidung (Betreiber, 2026-09-24, per Chat) — weicht bewusst
-- von specs/bestellungen.md §93 ab ("New → Confirmed nur bei vollständiger
-- Fertigwaren-Reservierung"). Befund der lokalen End-to-End-Prüfung:
--
--   (1) Katalogbestellung ohne Lagerware blieb dauerhaft 'New': Position
--       'WartetAufMaterial', nach manueller Produktion 'Fertig', Bestellung
--       konnte nie 'Finished'/'ReadyForPickup'/'HandedOver' werden; die
--       gedruckte Ware landete als freier Bestand. Die X2D-Automatik (0180)
--       griff im Normalfall nie.
--   (2) Bei vorhandener Lagerware wurde reserviert UND zusätzlich ein
--       X2D-Druckauftrag angelegt (Doppelproduktion).
--
-- Neuer Ablauf fn_confirm_order:
--   - Position mit ausreichendem freiem Fertigwarenbestand → reservieren,
--     Position direkt 'Fertig', kein Druck.
--   - Position ohne ausreichenden Bestand → bleibt 'Offen', Bestellung wird
--     'Confirmed', Position wird automatisch einem X2D-Auftrag ('Geplant',
--     OHNE Filamentreservierung) zugeordnet → 'InProduktion'/'InProduction'.
--     Produktionsstart + Filamentreservierung bleiben manueller Adminklick
--     (fn_start_production_order, unverändert bis auf Punkt 4).
--   - Alles aus Lager gedeckt → Bestellung direkt 'Finished'.
--   - Altfälle (vor 00185 hängende 'New'-Bestellungen): erneutes
--     "Bestätigen" löst sie auf (wartende Positionen gehen in Produktion,
--     bereits gefertigte werden aus dem Bestand gedeckt).
-- fn_complete_order_item: produzierte Ware wird sofort für die Position
-- reserviert (vor der Bestandsbuchung, wegen Retry-Trigger 00148).
--
-- Weitere Bugfixes:
--   (3) fn_auto_calculate_new_variant: Preis/Gramm zog tare_weight_g ein
--       zweites Mal ab — initial_weight_g ist laut Admin-Maske bereits netto
--       (Brutto − Tara). Folge: ~33 % zu hoher bzw. bei Restspulen < Tara
--       negativer Filamentpreis. Rückwirkende Neuberechnung nicht nötig:
--       alle bisherigen Spulen haben purchase_price = 0 (00183).
--   (4) fn_start_production_order (00182): automatische Spulenwahl prüfte
--       nur die Farbe, nicht das Finish — seit 00184 (Weiß/Schwarz
--       zusammengefasst) konnte eine matte Spule für eine glänzende
--       Bestellung gewählt werden. Jetzt Farbe UND Finish, nur aktive
--       Filamentprodukte.
--   (5) fn_complete_production_order: Abschluss mit offenen Positionen
--       (ohne erfassten Ist-Verbrauch) wird abgelehnt (produktion.md §85).
--   (6) fn_cancel_order_item_internal: stornierte Position wird aus einem
--       noch 'Geplant'-en Auftrag gelöst, leerer Auftrag wird entfernt.

-- (1)+(2) ---------------------------------------------------------------
create or replace function fn_confirm_order(p_order_id uuid, p_actor text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor               text := coalesce(p_actor, auth.uid()::text, 'system');
  v_order_status        order_status;
  v_item                record;
  v_stock               int;
  v_reserved            int;
  v_reservation         uuid;
  v_final_status        order_status;
  v_items               jsonb;
  v_x2d_printer_id      uuid;
  v_production_order_id uuid;
  v_config_group        record;
  v_unassigned_item     record;
  v_all_done            boolean;
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

  -- 2. Lagerware reservieren (00185) -----------------------------------------
  -- Katalogpositionen, die noch nicht in Produktion sind und keine aktive
  -- Reservierung haben. Reicht der freie Fertigwarenbestand für die volle
  -- Menge: reservieren und Position direkt 'Fertig' (liegt bereit, KEIN Druck).
  -- Reicht er nicht: Position bleibt/wird 'Offen' und geht unten in die
  -- Produktion. 'Fertig' ohne Reservierung (Altfall vor 00185: produziert,
  -- aber Bestellung hing auf 'New') wird nachträglich aus dem Bestand gedeckt.
  -- Ausnahmepfad-Positionen (variant_configuration_id IS NULL) haben nie
  -- Fertigwarenbestand und nehmen hier nicht teil.
  for v_item in
    select oi.id, oi.variant_configuration_id, oi.qty, oi.status
    from order_items oi
    where oi.order_id = p_order_id
      and oi.status in ('Offen', 'WartetAufMaterial', 'Fertig')
      and oi.variant_configuration_id is not null
      and (oi.status = 'Fertig' or oi.production_order_id is null)
      and not exists (
        select 1 from finished_goods_reservations r
        where r.order_item_id = oi.id and r.status = 'aktiv'
      )
    order by oi.variant_configuration_id, oi.id   -- feste Sperrreihenfolge
  loop
    perform 1 from variant_configurations vc
    where vc.id = v_item.variant_configuration_id
    for update;

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
      insert into finished_goods_reservations
        (variant_configuration_id, stock_type, order_item_id, qty, status)
      values
        (v_item.variant_configuration_id, 'normal', v_item.id, v_item.qty, 'aktiv')
      returning id into v_reservation;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('finished_goods_reservation', v_reservation, 'status_change', 'status', null, 'aktiv', v_actor);

      if v_item.status <> 'Fertig' then
        update order_items
        set status = 'Fertig', updated_at = now()
        where id = v_item.id;

        insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
        values ('order_item', v_item.id, 'status_change', 'status', v_item.status::text, 'Fertig', v_actor);
      end if;
    elsif v_item.status = 'WartetAufMaterial' then
      -- Altfall vor 00185: wartende Position geht jetzt regulär in Produktion.
      update order_items
      set status = 'Offen', updated_at = now()
      where id = v_item.id;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('order_item', v_item.id, 'status_change', 'status', 'WartetAufMaterial', 'Offen', v_actor);
    end if;
    -- 'Fertig' ohne ausreichenden Bestand: unverändert (Ware wurde bereits
    -- anderweitig verbraucht — Admin klärt manuell).
  end loop;

  -- 3. Bestellung bestätigen --------------------------------------------------
  update orders
  set status = 'Confirmed', confirmed_at = now(), updated_at = now()
  where id = p_order_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('order', p_order_id, 'status_change', 'status', 'New', 'Confirmed', v_actor);

  v_final_status := 'Confirmed';

  -- 4. Automatische Produktionszuordnung auf Drucker X2D (0180/00181) --------
  --    Nur Positionen OHNE Lagerdeckung ('Offen', nicht zugeordnet). Der
  --    Auftrag bleibt 'Geplant', keine Filamentreservierung — Start bleibt
  --    manuelle Adminaktion (fn_start_production_order).
  --    Bündeln nur bei exakt gleicher variant_configuration_id.
  select p.id into v_x2d_printer_id
  from printers p
  where p.name = 'X2D'
    and p.active
  limit 1;

  if v_x2d_printer_id is not null then
    for v_config_group in
      select distinct oi.variant_configuration_id
      from order_items oi
      where oi.order_id = p_order_id
        and oi.status = 'Offen'
        and oi.production_order_id is null
    loop
      v_production_order_id := null;

      select po.id into v_production_order_id
      from production_orders po
      where po.printer_id = v_x2d_printer_id
        and po.status = 'Geplant'
        and exists (
          select 1 from order_items oi2
          where oi2.production_order_id = po.id
            and oi2.status <> 'Storniert'
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
        -- setzt die Position auf 'InProduktion' und die Bestellung
        -- Confirmed → InProduction (00143)
        perform fn_assign_to_production(v_unassigned_item.id, v_production_order_id);
      end loop;
    end loop;
  end if;

  -- 4b. Altfall: bereits manuell zugeordnete Positionen (vor 00185 aus
  --     'WartetAufMaterial' heraus) → Bestellung ebenfalls 'InProduction'.
  if exists (
    select 1 from order_items oi
    where oi.order_id = p_order_id and oi.status = 'InProduktion'
  ) and (select o.status from orders o where o.id = p_order_id) = 'Confirmed' then
    update orders
    set status = 'InProduction', updated_at = now()
    where id = p_order_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('order', p_order_id, 'status_change', 'status', 'Confirmed', 'InProduction', v_actor);
  end if;

  -- 5. Alles aus dem Lager gedeckt → direkt 'Finished' ----------------------
  select o.status into v_final_status from orders o where o.id = p_order_id;

  select not exists (
    select 1 from order_items oi
    where oi.order_id = p_order_id
      and oi.status not in ('Fertig', 'Storniert')
  ) into v_all_done;

  if v_all_done and v_final_status = 'Confirmed' then
    update orders
    set status = 'Finished', finished_at = now(), updated_at = now()
    where id = p_order_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('order', p_order_id, 'status_change', 'status', 'Confirmed', 'Finished', v_actor);

    v_final_status := 'Finished';
  end if;

  -- 6. Ergebnisübersicht -----------------------------------------------------
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

-- (1) Reservierung produzierter Ware ---------------------------------------
CREATE OR REPLACE FUNCTION public.fn_complete_order_item(p_production_batch_item_id uuid, p_qty_success integer, p_qty_scrap_normal integer, p_qty_scrap_complaint integer, p_actual_material_usage jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_ok_amount      numeric;
  v_already_res    int;
  v_fg_res_qty     int;
  v_fg_res_id      uuid;
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
    raise exception 'p_actual_material_usage muss ein JSON-Array [{spool_id, amount_g, scrap_amount_g?}, ...] sein'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Parameter vorab vollständig validieren, bevor gebucht wird.
  for v_usage in
    select a.ord,
           nullif(a.e->>'spool_id', '')       as spool_id_txt,
           nullif(a.e->>'amount_g', '')       as amount_g_txt,
           nullif(a.e->>'scrap_amount_g', '') as scrap_amount_g_txt
    from jsonb_array_elements(p_actual_material_usage) with ordinality as a(e, ord)
  loop
    if v_usage.spool_id_txt is null or v_usage.amount_g_txt is null then
      raise exception 'Verbrauch #%: spool_id und amount_g sind Pflicht', v_usage.ord
        using errcode = 'invalid_parameter_value';
    end if;

    if v_usage.amount_g_txt::numeric <= 0 then
      raise exception 'Verbrauch #%: amount_g muss > 0 sein (tatsächlicher Gesamtverbrauch, wird negativ gebucht)', v_usage.ord
        using errcode = 'invalid_parameter_value';
    end if;

    if v_usage.scrap_amount_g_txt is not null then
      if v_usage.scrap_amount_g_txt::numeric < 0 then
        raise exception 'Verbrauch #%: scrap_amount_g darf nicht negativ sein', v_usage.ord
          using errcode = 'invalid_parameter_value';
      end if;
      if v_usage.scrap_amount_g_txt::numeric > v_usage.amount_g_txt::numeric then
        raise exception 'Verbrauch #%: scrap_amount_g (%) darf amount_g (%) nicht überschreiten', v_usage.ord, v_usage.scrap_amount_g_txt, v_usage.amount_g_txt
          using errcode = 'invalid_parameter_value';
      end if;
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

  -- 3. Tatsächlicher Materialverbrauch (#4), aufgeteilt in 'produktion' und
  --    'fehldruck' je nach admin-seitig gemeldetem scrap_amount_g -----------
  for v_usage in
    select (e->>'spool_id')::uuid                          as spool_id,
           (e->>'amount_g')::numeric                        as amount_g,
           coalesce((e->>'scrap_amount_g')::numeric, 0)      as scrap_amount_g
    from jsonb_array_elements(p_actual_material_usage) e
    order by (e->>'spool_id')::uuid   -- gleiche Sperrreihenfolge wie beim Start
  loop
    perform 1 from filament_spools s
    where s.id = v_usage.spool_id
    for update;

    v_ok_amount := v_usage.amount_g - v_usage.scrap_amount_g;

    if v_ok_amount > 0 then
      insert into filament_movements
        (spool_id, movement_type, amount_g, reference_type, reference_id, created_by)
      values
        (v_usage.spool_id, 'produktion', -v_ok_amount,
         'production_batch_item', p_production_batch_item_id, v_actor)
      returning id into v_movement_id;

      insert into production_material_usage
        (production_batch_item_id, spool_id, amount_g, filament_movement_id)
      values
        (p_production_batch_item_id, v_usage.spool_id, v_ok_amount, v_movement_id);

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('filament_movement', v_movement_id, 'create', 'amount_g', null, (-v_ok_amount)::text, v_actor);

      v_mov_json := v_mov_json || jsonb_build_object(
        'filament_movement_id', v_movement_id,
        'spool_id',             v_usage.spool_id,
        'movement_type',        'produktion',
        'amount_g',             -v_ok_amount
      );
    end if;

    if v_usage.scrap_amount_g > 0 then
      insert into filament_movements
        (spool_id, movement_type, amount_g, reference_type, reference_id, created_by)
      values
        (v_usage.spool_id, 'fehldruck', -v_usage.scrap_amount_g,
         'production_batch_item', p_production_batch_item_id, v_actor)
      returning id into v_movement_id;

      insert into production_material_usage
        (production_batch_item_id, spool_id, amount_g, filament_movement_id)
      values
        (p_production_batch_item_id, v_usage.spool_id, v_usage.scrap_amount_g, v_movement_id);

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('filament_movement', v_movement_id, 'create', 'amount_g', null, (-v_usage.scrap_amount_g)::text, v_actor);

      v_mov_json := v_mov_json || jsonb_build_object(
        'filament_movement_id', v_movement_id,
        'spool_id',             v_usage.spool_id,
        'movement_type',        'fehldruck',
        'amount_g',             -v_usage.scrap_amount_g
      );
    end if;
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
    -- 00185: produzierte Ware sofort für DIESE Position zurücklegen (bis zur
    -- offenen Menge), damit sie nicht als freier Bestand von einer anderen
    -- Bestellung reserviert wird. Reservierung VOR der Bestandsbuchung, weil
    -- der Zugang den Retry-Trigger (00148) auslöst.
    select coalesce(sum(r.qty), 0) into v_already_res
    from finished_goods_reservations r
    where r.order_item_id = v_item.id
      and r.status = 'aktiv';

    v_fg_res_qty := least(p_qty_success, v_item.qty - v_already_res);

    if v_fg_res_qty > 0 then
      insert into finished_goods_reservations
        (variant_configuration_id, stock_type, order_item_id, qty, status)
      values
        (v_item.variant_configuration_id, 'normal', v_item.id, v_fg_res_qty, 'aktiv')
      returning id into v_fg_res_id;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('finished_goods_reservation', v_fg_res_id, 'status_change', 'status', null, 'aktiv', v_actor);
    end if;

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
$function$;

-- (3) --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_auto_calculate_new_variant()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_price_per_gram numeric;
  v_machine_rate    numeric;
  v_filament_cost   numeric;
  v_machine_cost    numeric;
  v_actor           text := coalesce(auth.uid()::text, 'system');
begin
  select avg(fs.purchase_price / nullif(fs.initial_weight_g, 0))
  into v_price_per_gram
  from filament_spools fs
  join filament_products fp on fp.id = fs.filament_product_id
  where fs.active and fp.active
    and fs.initial_weight_g > 0;  -- 00185: initial_weight_g ist bereits netto (Brutto − Tara)

  select s.machine_hourly_rate into v_machine_rate from settings s limit 1;

  v_filament_cost := coalesce(v_price_per_gram, 0) * coalesce(new.weight_g, 0);
  v_machine_cost  := coalesce(v_machine_rate, 0) * (coalesce(new.print_time_min, 0) / 60.0);

  perform fn_create_calculation_version(
    'product_variant',
    new.id,
    jsonb_build_object('filament_cost', v_filament_cost, 'machine_cost', v_machine_cost),
    20,
    'sonstiger_grund',
    v_actor
  );

  return new;
end;
$function$;

-- (4) --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_start_production_order(p_production_order_id uuid, p_spool_assignments jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor          text := coalesce(auth.uid()::text, 'system');
  v_po_status      production_order_status;
  v_item           record;
  v_assign         record;
  v_item_ids       uuid[] := '{}';   -- zugeordnete order_items (Index i)
  v_batch_ids      uuid[] := '{}';   -- zugehörige production_batch_items (Index i)
  v_idx            int;
  v_batch_id       uuid;
  v_spool_active   boolean;
  v_rest           numeric;
  v_reserved       numeric;
  v_available      numeric;
  v_reservation    uuid;
  v_now            timestamptz := now();
  v_missing        text;
  v_batch_json     jsonb := '[]'::jsonb;
  v_res_json       jsonb := '[]'::jsonb;
  v_assignments    jsonb;
  v_auto_item      record;
  v_config_rows    int;
  v_part_id        uuid;
  v_color_id       uuid;
  v_finish_id      uuid;
  v_need_g         numeric;
  v_candidate      record;
  v_candidate_id   uuid;
  v_candidate_n    int;
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

  -- 3. Parameter validieren (00182: leer/NULL jetzt erlaubt) -----------------
  v_assignments := coalesce(p_spool_assignments, '[]'::jsonb);

  if jsonb_typeof(v_assignments) <> 'array' then
    raise exception 'p_spool_assignments muss ein JSON-Array [{order_item_id, spool_id, amount_g}, ...] sein (Spulenwahl durch den Admin, #18)'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_assign in
    select a.ord,
           nullif(a.e->>'order_item_id', '') as order_item_id_txt,
           nullif(a.e->>'spool_id', '')      as spool_id_txt,
           nullif(a.e->>'amount_g', '')      as amount_g_txt
    from jsonb_array_elements(v_assignments) with ordinality as a(e, ord)
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

  -- 3b. Automatische Spulenwahl für Positionen ohne explizite Zuordnung
  --     (00182) — nur bei genau einer Farbanforderung und genau einem
  --     passenden aktiven Spulen-Kandidaten mit ausreichendem Restbestand.
  for v_auto_item in
    select oi.id, oi.qty, oi.variant_id, oi.variant_configuration_id
    from order_items oi
    where oi.id = any(v_item_ids)
      and oi.variant_configuration_id is not null
      and not exists (
        select 1 from jsonb_array_elements(v_assignments) e
        where (e->>'order_item_id')::uuid = oi.id
      )
  loop
    select count(*) into v_config_rows
    from variant_configuration_colors c
    where c.variant_configuration_id = v_auto_item.variant_configuration_id;

    if v_config_rows <> 1 then
      continue;   -- mehrfarbig oder unerwartet leer: manuell, keine Auto-Auswahl
    end if;

    select c.product_part_id, c.color_id, c.finish_id into v_part_id, v_color_id, v_finish_id
    from variant_configuration_colors c
    where c.variant_configuration_id = v_auto_item.variant_configuration_id;

    if v_part_id is null then
      select pv.material_need_g into v_need_g
      from product_variants pv
      where pv.id = v_auto_item.variant_id;
    else
      select vp.material_need_g into v_need_g
      from variant_parts vp
      where vp.variant_id = v_auto_item.variant_id
        and vp.product_part_id = v_part_id;
    end if;

    if v_need_g is null or v_need_g <= 0 then
      continue;   -- kein sinnvoller Bedarfswert: manuell
    end if;

    v_need_g := v_need_g * v_auto_item.qty;

    v_candidate_id := null;
    v_candidate_n  := 0;

    for v_candidate in
      select s.id,
             s.initial_weight_g + coalesce((
               select sum(m.amount_g) from filament_movements m where m.spool_id = s.id
             ), 0)
             - coalesce((
               select sum(r.amount_g) from filament_reservations r
               where r.spool_id = s.id and r.status = 'aktiv'
             ), 0) as available
      from filament_spools s
      join filament_products fp on fp.id = s.filament_product_id
      where fp.color_id = v_color_id
        and fp.finish_id = v_finish_id   -- 00185: Glänzend/Matt muss passen
        and fp.active
        and s.active
    loop
      if v_candidate.available >= v_need_g then
        v_candidate_n := v_candidate_n + 1;
        v_candidate_id := v_candidate.id;
      end if;
    end loop;

    if v_candidate_n = 1 then
      v_assignments := v_assignments || jsonb_build_object(
        'order_item_id', v_auto_item.id,
        'spool_id',      v_candidate_id,
        'amount_g',      v_need_g
      );
    end if;
    -- 0 oder ≥2 Kandidaten: keine Automatik, Position bleibt ggf. in der
    -- folgenden "Ohne Spulenzuordnung"-Prüfung stehen → manuelle Zuordnung.
  end loop;

  -- Jede zugeordnete Position braucht mindestens eine Spulenzuordnung
  -- (explizit ODER automatisch aus 3b).
  select string_agg(i::text, ', ') into v_missing
  from unnest(v_item_ids) as i
  where not exists (
    select 1 from jsonb_array_elements(v_assignments) e
    where (e->>'order_item_id')::uuid = i
  );

  if v_missing is not null then
    raise exception 'Ohne Spulenzuordnung: Bestellposition(en) % — der Auftrag startet nur, wenn jede zugeordnete Position eine Spulenwahl hat (automatisch nur bei eindeutiger Farbe möglich, siehe 00182)',
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

  -- 5. Reservierungen (Sperrstrategie siehe Kommentar in 00143) --------------
  for v_assign in
    select (e->>'order_item_id')::uuid as order_item_id,
           (e->>'spool_id')::uuid      as spool_id,
           (e->>'amount_g')::numeric   as amount_g
    from jsonb_array_elements(v_assignments) e
    order by (e->>'spool_id')::uuid, (e->>'order_item_id')::uuid   -- feste Sperrreihenfolge
  loop
    -- Sperre auf die Spule; erst danach summieren (#5) — gilt identisch für
    -- automatisch vorausgewählte Spulen: die Vorauswahl in 3b war ungesperrt,
    -- erst hier wird verbindlich geprüft/gebucht.
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
  set status        = 'Laeuft',
      actual_start  = v_now,
      planned_start = coalesce(planned_start, v_now),
      updated_at    = v_now
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
$function$;

-- (5) --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_complete_production_order(p_production_order_id uuid, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status  production_order_status;
  v_now     timestamptz := now();
  v_total   int;
  v_open    int;
  v_items   jsonb;
begin
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_complete_production_order: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select po.status into v_status
  from production_orders po
  where po.id = p_production_order_id
  for update;

  if not found then
    raise exception 'fn_complete_production_order: Produktionsauftrag % existiert nicht', p_production_order_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_status <> 'Laeuft' then
    raise exception 'fn_complete_production_order: Produktionsauftrag % hat Status % — Abschluss ist nur aus ''Laeuft'' möglich',
      p_production_order_id, v_status
      using errcode = 'check_violation';
  end if;

  -- 00185: nicht abschließen, solange Positionen ohne erfassten Ist-Verbrauch
  -- offen sind (produktion.md §85) — sonst hingen Position ('InProduktion')
  -- und Filamentreservierung dauerhaft.
  select count(*) filter (where b.qty_success is null) into v_open
  from production_batch_items b
  where b.production_order_id = p_production_order_id;

  if v_open > 0 then
    raise exception 'fn_complete_production_order: Produktionsauftrag % hat noch % Position(en) ohne erfassten Ist-Verbrauch — erst "Ist-Verbrauch erfassen", dann abschließen',
      p_production_order_id, v_open
      using errcode = 'check_violation';
  end if;

  update production_orders
  set status     = 'Abgeschlossen',
      actual_end = v_now,
      updated_at = v_now
  where id = p_production_order_id;

  perform fn_write_audit('production_order', p_production_order_id, 'status_change', 'status',
                         'Laeuft', 'Abgeschlossen', null, p_actor);

  select count(*),
         count(*) filter (where b.qty_success is null)
    into v_total, v_open
  from production_batch_items b
  where b.production_order_id = p_production_order_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'production_batch_item_id', b.id,
           'order_item_id',            b.order_item_id,
           'qty_planned',              b.qty_planned,
           'qty_success',              b.qty_success,
           'qty_scrap_normal',         b.qty_scrap_normal,
           'qty_scrap_complaint',      b.qty_scrap_complaint
         ) order by b.created_at, b.id), '[]'::jsonb)
    into v_items
  from production_batch_items b
  where b.production_order_id = p_production_order_id;

  return jsonb_build_object(
    'production_order_id',   p_production_order_id,
    'status',                'Abgeschlossen',
    'actual_end',             v_now,
    'batch_items_total',     v_total,
    'batch_items_open',      v_open,
    'batch_items_completed', v_total - v_open,
    'batch_items',           v_items
  );
end;
$function$;

-- (6) --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_cancel_order_item_internal(p_order_item_id uuid, p_reason text, p_actor text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item   record;
  v_reason text := nullif(trim(p_reason), '');
  v_po_id  uuid;
begin
  if v_reason is null then
    raise exception 'Stornierungsgrund ist Pflicht (#32) — p_reason darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select oi.id, oi.order_id, oi.status, oi.production_order_id
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

  -- 00185: Aus einem noch nicht gestarteten ('Geplant') Produktionsauftrag
  -- lösen; bleibt der Auftrag danach leer, wird er entfernt (kein
  -- verwaister Auftrag, keine Fehlbündelung in fn_confirm_order).
  if v_item.production_order_id is not null then
    select po.id into v_po_id
    from production_orders po
    where po.id = v_item.production_order_id
      and po.status = 'Geplant'
    for update;

    if v_po_id is not null then
      update order_items
      set production_order_id = null, updated_at = now()
      where id = p_order_item_id;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
      values ('order_item', p_order_item_id, 'update', 'production_order_id',
              v_po_id::text, null, v_reason, p_actor);

      if not exists (select 1 from order_items oi where oi.production_order_id = v_po_id)
         and not exists (select 1 from production_batch_items b where b.production_order_id = v_po_id) then
        delete from production_orders where id = v_po_id;

        insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
        values ('production_order', v_po_id, 'delete', 'status', 'Geplant', null,
                'leer nach Stornierung', p_actor);
      end if;
    end if;
  end if;

  return v_item.order_id;
end;
$function$;
