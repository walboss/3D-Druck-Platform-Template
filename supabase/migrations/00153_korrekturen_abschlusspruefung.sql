-- Migration 00153: Korrekturen aus der Abschlussprüfung (Befunde 1-5, 7)
-- Siehe specs/fertigwarenbestand.md §2-§3 (ausschuss_umbuchung),
-- specs/filament-material.md §3, §5 (fehldruck),
-- specs/kunden-warenkorb-tracking.md §2-§4 (order_tracking_tokens),
-- specs/angebote-individuelle-anfragen.md §3-§4 (Widerruf),
-- specs/produkte-varianten-farben.md §2 (source_custom_request_id),
-- specs/00-overview.md §1 Prinzipien #1, #2.
--
-- Befund 6 (fehlende Admin-Verwaltungsfunktionen: Lizenzstatus,
-- custom_requests geprueft/abgelehnt, offers abgelehnt,
-- production_orders-Abschluss, complaints) ist NICHT Teil dieser Migration.
--
-- Rückgabewert-Entscheidung fn_revoke_tracking_token: text (der neue
-- Token-String), nicht die Zeilen-uuid — per Rückfrage geklärt, da das
-- Frontend den tatsächlichen Token für den neuen Tracking-Link braucht.

-- ===========================================================================
-- ABSCHNITT A: DELETE-Grants entziehen (Befund 1, Prinzipien #1/#2)
-- ===========================================================================
-- 00149 hatte auf allen unten genannten Tabellen volles CRUD inkl. DELETE für
-- authenticated vergeben (admin_all_*-Policies "for all" + Tabellen-Grant).
-- Das widerspricht #1 ("Historische Daten niemals zerstören") und #2
-- ("Produkte deaktivieren statt löschen") sowie den expliziten Sätzen
-- "Filamenttypen ... nie gelöscht" (filament-material.md §3) und "Lizenzen
-- werden ... nie gelöscht" (lizenzen.md §3). Die RLS-Policies selbst bleiben
-- unverändert (Task-Vorgabe) — der Tabellen-Grant-Entzug allein genügt, da
-- Postgres den Tabellen-Grant vor der RLS-Policy prüft: ohne DELETE-Grant
-- kommt "permission denied for relation ...", die "for all"-Policy wird für
-- DELETE nie erreicht.
--
-- Vollständige Prüfung aller Tabellen aus dem ursprünglichen
-- "grant select, insert, update, delete on ... to authenticated"-Block
-- (00149 Phase 3): 27 Tabellen. Davon:
--   - cart_sessions, cart_items: DELETE bleibt (kunden-warenkorb-tracking.md
--     §2, ausdrückliche Ausnahme von "nie löschen" — Warenkorb ist
--     vor-transaktionaler, technischer Zustand ohne Geschäftswert).
--   - Alle übrigen 25 Tabellen: DELETE wird entzogen. Das schließt auch
--     custom_request_colors, order_bundle_groups, order_tracking_tokens und
--     complaints ein — im Task nicht einzeln in der "insbesondere"-Liste
--     genannt, aber ebenfalls historische Geschäfts-/Stammdaten im Sinne von
--     #1 (Anfragedaten, Bestellzugehörigkeit, Tracking-Zugriffshistorie,
--     Reklamationshistorie) und daher konsequent in den Entzug einbezogen.
revoke delete on
  colors, finishes, creators, admins, printers, customers,
  products, filament_products, licenses,
  product_parts, product_variants, product_color_finish_options,
  filament_spools, license_product_links, license_cost_models,
  variant_parts, variant_configurations, product_bundles, custom_request_colors,
  variant_configuration_colors, bundle_items, order_bundle_groups,
  order_tracking_tokens, complaints, license_recurring_charges
from authenticated;

-- cart_sessions, cart_items: bewusst NICHT in der obigen Liste — DELETE bleibt.

-- ===========================================================================
-- ABSCHNITT B: fn_book_b_ware — B-Ware-Umbuchung aus Ausschuss (Befund 2)
-- ===========================================================================
-- fertigwarenbestand.md §3: "B-Ware entsteht ausschließlich durch eine
-- ausschuss_umbuchung (positiv, stock_type='b_ware'), deren Quelle ein
-- Ausschuss-Eintrag in production_batch_items ist." Bislang erzeugte keine
-- Funktion diesen Bewegungstyp.
--
-- p_note ist Pflicht (analog zu den übrigen Pflicht-Begründungen in diesem
-- Projekt — Stornierungsgrund, Widerrufsgrund). finished_goods_movements hat
-- kein eigenes note-Feld; die Begründung wird daher in audit_log.reason
-- abgelegt (gleiches Muster wie cancellation_reason/revoke_reason an anderer
-- Stelle, die ebenfalls nur im Audit-Log stehen).
--
-- p_qty darf die noch nicht umgebuchte Restmenge aus qty_scrap_normal nicht
-- überschreiten: verfügbar = qty_scrap_normal − Σ(bereits gebuchte
-- ausschuss_umbuchung-Bewegungen für dieses production_batch_item). Keine
-- Rückbuchung vorgesehen (§5: einseitig) — es gibt bewusst keine Funktion,
-- die eine B-Ware-Buchung rückgängig macht.
create or replace function fn_book_b_ware(
  p_production_batch_item_id uuid,
  p_qty                      int,
  p_note                     text,
  p_actor                    text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note        text := nullif(trim(p_note), '');
  v_batch       record;
  v_vc_id       uuid;
  v_already     numeric;
  v_available   numeric;
  v_movement_id uuid;
begin
  if p_production_batch_item_id is null then
    raise exception 'fn_book_b_ware: production_batch_item_id darf nicht NULL sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'fn_book_b_ware: qty muss > 0 sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_note is null then
    raise exception 'fn_book_b_ware: note ist Pflicht (Begründung der Ausschuss-Umbuchung)'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_book_b_ware: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select b.id, b.order_item_id, b.qty_scrap_normal
    into v_batch
  from production_batch_items b
  where b.id = p_production_batch_item_id
  for update;

  if not found then
    raise exception 'fn_book_b_ware: production_batch_item % existiert nicht', p_production_batch_item_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_batch.qty_scrap_normal is null then
    raise exception 'fn_book_b_ware: production_batch_item % ist noch nicht abgeschlossen (kein qty_scrap_normal gesetzt)',
      p_production_batch_item_id
      using errcode = 'check_violation';
  end if;

  select oi.variant_configuration_id into v_vc_id
  from order_items oi
  where oi.id = v_batch.order_item_id;

  if v_vc_id is null then
    raise exception 'fn_book_b_ware: Bestellposition % hat keinen Fertigwarenbestand (Ausnahmepfad ohne Katalogbezug) — B-Ware-Umbuchung nicht möglich',
      v_batch.order_item_id
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(m.qty_delta), 0) into v_already
  from finished_goods_movements m
  where m.reference_type = 'production_batch_item'
    and m.reference_id   = p_production_batch_item_id
    and m.movement_type  = 'ausschuss_umbuchung';

  v_available := v_batch.qty_scrap_normal - v_already;

  if p_qty > v_available then
    raise exception 'fn_book_b_ware: % Stück angefordert, aber nur % verfügbar (qty_scrap_normal % abzüglich bereits umgebuchter %)',
      p_qty, v_available, v_batch.qty_scrap_normal, v_already
      using errcode = 'check_violation';
  end if;

  insert into finished_goods_movements
    (variant_configuration_id, stock_type, movement_type, qty_delta,
     reference_type, reference_id, created_by)
  values
    (v_vc_id, 'b_ware', 'ausschuss_umbuchung', p_qty,
     'production_batch_item', p_production_batch_item_id, p_actor)
  returning id into v_movement_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
  values ('finished_goods_movement', v_movement_id, 'create', 'qty_delta', null, p_qty::text, v_note, p_actor);

  return v_movement_id;
end;
$$;

revoke all on function fn_book_b_ware(uuid, int, text, text) from public;
revoke all on function fn_book_b_ware(uuid, int, text, text) from anon;
grant execute on function fn_book_b_ware(uuid, int, text, text) to authenticated;

-- ===========================================================================
-- ABSCHNITT C: fn_complete_order_item erweitert — Fehldruck-Split (Befund 3)
-- ===========================================================================
-- filament-material.md §5: "Der tatsächlich verbrauchte Materialanteil wird
-- trotzdem als filament_movements-Eintrag gebucht (movement_type =
-- 'fehldruck')." Bislang bucht fn_complete_order_item den gesamten
-- tatsächlichen Verbrauch je Spule immer als movement_type='produktion',
-- unabhängig von qty_scrap_normal/qty_scrap_complaint.
--
-- Gewählte Variante (Task-Vorgabe: möglichst wenig an der Signatur brechen):
-- KEINE neue Positionsparameter, KEINE Signaturänderung. Stattdessen bekommt
-- jedes Element von p_actual_material_usage ein neues, optionales Feld
-- "scrap_amount_g" (Default 0, wenn fehlend — vollständig abwärtskompatibel
-- zu bestehenden Aufrufern, die dieses Feld nicht kennen):
--   { "spool_id": uuid, "amount_g": numeric, "scrap_amount_g": numeric? }
-- amount_g bleibt wie bisher der GESAMTE tatsächliche Verbrauch von dieser
-- Spule für dieses Batch-Item. scrap_amount_g ist der Anteil davon, der auf
-- Fehldruck/Ausschuss entfällt (0 <= scrap_amount_g <= amount_g) und separat
-- als eigene filament_movements-Zeile mit movement_type='fehldruck' gebucht
-- wird; der Rest (amount_g − scrap_amount_g) wie bisher als 'produktion'.
-- Die Aufteilung kommt ausschließlich vom Admin als Parameter — keine
-- Schätzung/Herleitung aus qty_scrap_normal in dieser Funktion.
-- Da CREATE OR REPLACE die Parameterliste nicht ändert, ist kein DROP nötig.
--
-- Sonst unverändert: Sperrreihenfolge (spool_id), Prüfungen, Reservierungen,
-- Fertigware-Buchung, Status-Kaskade order_item → order.
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
  v_ok_amount      numeric;
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

-- ===========================================================================
-- ABSCHNITT D: Tracking-Token-Lebenszyklus (Befund 4)
-- ===========================================================================
-- kunden-warenkorb-tracking.md §2/§3: order_tracking_tokens wurde bislang nur
-- gelesen (fn_get_order_by_token, 00149), nie angelegt oder widerrufen.
--
-- fn_place_order und fn_accept_offer legen ab jetzt beim Anlegen der
-- Bestellung automatisch ein Tracking-Token an (128 Bit Entropie, analog
-- offers.secure_token, encode(extensions.gen_random_bytes(16), 'hex')),
-- Laufzeit 1 Jahr. Da der Token zur Anzeige an den Kunden zurückgegeben
-- werden muss, ändert sich der Rückgabetyp beider Funktionen von uuid auf
-- jsonb {"order_id", "tracking_token"} — das erfordert DROP + CREATE (ein
-- reiner CREATE OR REPLACE kann den Rückgabetyp nicht ändern). Die
-- Token-Anlage selbst wird nicht separat auditiert (gleiches Muster wie bei
-- offers.secure_token, dessen Anlage ebenfalls nicht separat auditiert wird
-- — auditiert wird der fachliche Status, nicht das technische Secret).

drop function if exists fn_place_order(uuid, jsonb);

create or replace function fn_place_order(
  p_cart_session_id uuid,
  p_customer jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- anon hat keine auth.uid() → 'system' (Task-Vorgabe)
  v_actor          text := coalesce(auth.uid()::text, 'system');
  v_customer_id    uuid;
  v_order_id       uuid;
  v_year           text := to_char(current_date, 'YYYY');
  v_next_no        int;
  v_order_number   text;
  v_item           record;
  v_vc_id          uuid;
  v_calc_id        uuid;
  v_tracking_token text;
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

  -- 3. Bestellnummer (Strategie siehe Kommentar in 00142) --------------------
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

  -- 4b. Tracking-Token (Befund 4, kunden-warenkorb-tracking.md §2/§3) --------
  v_tracking_token := encode(extensions.gen_random_bytes(16), 'hex');

  insert into order_tracking_tokens (order_id, token, expires_at)
  values (v_order_id, v_tracking_token, now() + interval '1 year');

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

    if v_item.qty is null
       or v_item.qty < v_item.min_qty
       or v_item.qty > v_item.max_qty
       or (v_item.qty - v_item.min_qty) % v_item.step_qty <> 0 then
      raise exception 'Menge % für Variante "%" ungültig (erlaubt: % bis %, Schrittweite %)',
        v_item.qty, v_item.size_label, v_item.min_qty, v_item.max_qty, v_item.step_qty
        using errcode = 'check_violation';
    end if;

    v_vc_id := fn_create_variant_configuration_if_missing(
      v_item.variant_id, v_item.configuration_draft
    );

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

  return jsonb_build_object(
    'order_id',       v_order_id,
    'tracking_token', v_tracking_token
  );
end;
$$;

revoke all on function fn_place_order(uuid, jsonb) from public;
grant execute on function fn_place_order(uuid, jsonb) to anon, authenticated;

drop function if exists fn_accept_offer(text);

create or replace function fn_accept_offer(p_secure_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor          text := coalesce(auth.uid()::text, 'system');
  v_offer          offers%rowtype;
  v_customer_id    uuid;
  v_order_id       uuid;
  v_year           text := to_char(current_date, 'YYYY');
  v_next_no        int;
  v_order_number   text;
  v_item           record;
  v_now            timestamptz := now();
  v_tracking_token text;
begin
  -- 1. Angebot laden, sperren, prüfen ----------------------------------------
  if nullif(trim(p_secure_token), '') is null then
    raise exception 'fn_accept_offer: secure_token darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_offer
  from offers
  where secure_token = p_secure_token
  for update;

  if not found then
    raise exception 'fn_accept_offer: kein Angebot zu diesem Token'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_offer.status <> 'offen' then
    raise exception 'fn_accept_offer: Angebot % hat Status % (nur ''offen'' kann angenommen werden)',
      v_offer.id, v_offer.status
      using errcode = 'check_violation';
  end if;

  if v_offer.revoked_at is not null then
    raise exception 'fn_accept_offer: Angebotslink für % ist gesperrt (widerrufen am %)',
      v_offer.id, v_offer.revoked_at
      using errcode = 'check_violation';
  end if;

  if v_now not between v_offer.valid_from and v_offer.valid_until then
    raise exception 'fn_accept_offer: Angebot % ist nicht gültig (gültig von % bis %, jetzt %)',
      v_offer.id, v_offer.valid_from, v_offer.valid_until, v_now
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from offer_items oi where oi.offer_id = v_offer.id) then
    raise exception 'fn_accept_offer: Angebot % hat keine Positionen', v_offer.id
      using errcode = 'check_violation';
  end if;

  -- 2. Kunde aus der zugehörigen Anfrage --------------------------------------
  select cr.customer_id into v_customer_id
  from custom_requests cr
  where cr.id = v_offer.custom_request_id;

  if v_customer_id is null then
    raise exception 'fn_accept_offer: Anfrage % zu Angebot % existiert nicht',
      v_offer.custom_request_id, v_offer.id
      using errcode = 'invalid_parameter_value';
  end if;

  -- 3. Bestellnummer (Strategie und Lock-Schlüssel wie fn_place_order, 00142)
  perform pg_advisory_xact_lock(hashtext('fn_place_order.order_number'));

  select coalesce(max(substring(o.order_number from '^ORDER-\d{4}-(\d{5})$')::int), 0) + 1
    into v_next_no
  from orders o
  where o.order_number like 'ORDER-' || v_year || '-%';

  if v_next_no > 99999 then
    raise exception 'fn_accept_offer: Bestellnummernkreis für % erschöpft (max. 99999)', v_year;
  end if;

  v_order_number := 'ORDER-' || v_year || '-' || lpad(v_next_no::text, 5, '0');

  -- 4. Bestellung ------------------------------------------------------------
  insert into orders (order_number, customer_id, status, source, offer_id)
  values (v_order_number, v_customer_id, 'New', 'custom_offer', v_offer.id)
  returning id into v_order_id;

  -- 4b. Tracking-Token (Befund 4, kunden-warenkorb-tracking.md §2/§3) --------
  v_tracking_token := encode(extensions.gen_random_bytes(16), 'hex');

  insert into order_tracking_tokens (order_id, token, expires_at)
  values (v_order_id, v_tracking_token, v_now + interval '1 year');

  -- 5. Positionen (Ausnahmepfad, Kalkulationsversion unverändert, #9) --------
  for v_item in
    select oi.id, oi.desired_variant_description, oi.qty, oi.calculation_version_id
    from offer_items oi
    where oi.offer_id = v_offer.id
    order by oi.created_at, oi.id
  loop
    if v_item.qty is null or v_item.qty < 1 then
      raise exception 'fn_accept_offer: Angebotsposition % hat ungültige Menge %',
        v_item.id, v_item.qty
        using errcode = 'check_violation';
    end if;

    insert into order_items (
      order_id, product_id, variant_id, variant_configuration_id,
      desired_description, qty, status, calculation_version_id
    )
    values (
      v_order_id, null, null, null,
      v_item.desired_variant_description, v_item.qty, 'Offen', v_item.calculation_version_id
    );
  end loop;

  -- 6. Angebot: offen → akzeptiert ---------------------------------------------
  update offers
  set status     = 'akzeptiert',
      updated_at = v_now
  where id = v_offer.id;

  -- 7. Audit (#31) -------------------------------------------------------------
  perform fn_write_audit('order', v_order_id, 'status_change', 'status',
                         null, 'New', null, v_actor);
  perform fn_write_audit('offer', v_offer.id, 'status_change', 'status',
                         'offen', 'akzeptiert', null, v_actor);

  -- 8. Reservierungsversuch (bestellungen.md §4: New → Confirmed) -------------
  perform fn_confirm_order(v_order_id);

  return jsonb_build_object(
    'order_id',       v_order_id,
    'tracking_token', v_tracking_token
  );
end;
$$;

revoke all on function fn_accept_offer(text) from public;
grant execute on function fn_accept_offer(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- fn_revoke_tracking_token(p_order_id, p_revoke_reason, p_actor) → text
-- ---------------------------------------------------------------------------
-- kunden-warenkorb-tracking.md §3: Neugenerierung bei Missbrauchsverdacht ist
-- eine NEUE Zeile, die alte wird revoked_at/revoke_reason gesetzt statt
-- gelöscht (#1). Widerruft alle aktuell aktiven Tokens der Bestellung
-- (Normalfall: genau eines — defensiv auch mehrere, falls die Invariante
-- "höchstens ein aktives Token je Bestellung" je verletzt worden wäre) und
-- legt danach ein neues an. Gibt den neuen Token-STRING zurück (nicht die
-- Zeilen-id) — das Frontend braucht den Wert selbst, um den neuen
-- Tracking-Link zu bauen (per Rückfrage geklärt).
--
-- Keine Einschränkung nach Bestellstatus: das Token ist ein reiner
-- Zugriffs-Credential, unabhängig vom Bestellfortschritt — die Spec bindet
-- den Widerruf nur an "Missbrauchsverdacht", nicht an einen bestimmten
-- orders.status.
--
-- Der neue Token-Wert selbst wird NICHT im Klartext ins audit_log geschrieben
-- (gleiches Vorsichtsprinzip wie bei offers.secure_token) — auditiert wird
-- nur, dass ein neues Token angelegt wurde, mit Verweis auf dessen id.
create or replace function fn_revoke_tracking_token(
  p_order_id      uuid,
  p_revoke_reason text,
  p_actor         text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason    text := nullif(trim(p_revoke_reason), '');
  v_now       timestamptz := now();
  v_old       record;
  v_found     boolean := false;
  v_new_token text;
  v_new_id    uuid;
begin
  if p_order_id is null then
    raise exception 'fn_revoke_tracking_token: order_id darf nicht NULL sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_reason is null then
    raise exception 'fn_revoke_tracking_token: revoke_reason ist Pflicht'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_revoke_tracking_token: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (select 1 from orders o where o.id = p_order_id) then
    raise exception 'fn_revoke_tracking_token: Bestellung % existiert nicht', p_order_id
      using errcode = 'invalid_parameter_value';
  end if;

  for v_old in
    update order_tracking_tokens
    set revoked_at    = v_now,
        revoke_reason = v_reason,
        updated_at    = v_now
    where order_id    = p_order_id
      and revoked_at is null
    returning id
  loop
    v_found := true;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
    values ('order_tracking_token', v_old.id, 'update', 'revoked_at', null, v_now::text, v_reason, p_actor);
  end loop;

  if not v_found then
    raise exception 'fn_revoke_tracking_token: Bestellung % hat kein aktives Tracking-Token', p_order_id
      using errcode = 'check_violation';
  end if;

  v_new_token := encode(extensions.gen_random_bytes(16), 'hex');

  insert into order_tracking_tokens (order_id, token, expires_at)
  values (p_order_id, v_new_token, v_now + interval '1 year')
  returning id into v_new_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('order_tracking_token', v_new_id, 'create', 'order_id', null, p_order_id::text, p_actor);

  return v_new_token;
end;
$$;

revoke all on function fn_revoke_tracking_token(uuid, text, text) from public;
revoke all on function fn_revoke_tracking_token(uuid, text, text) from anon;
grant execute on function fn_revoke_tracking_token(uuid, text, text) to authenticated;

-- ===========================================================================
-- ABSCHNITT E: fn_revoke_offer korrigiert (Befund 5)
-- ===========================================================================
-- angebote-individuelle-anfragen.md §4 beschreibt offen → widerrufen als
-- echten Statusübergang. Bislang setzte fn_revoke_offer (00146) nur
-- revoked_at/revoke_reason, nie offers.status — der ENUM-Wert 'widerrufen'
-- war damit toter Code. Ergänzt jetzt status = 'widerrufen'.
--
-- Auswirkung auf fn_expire_offers (00148) geprüft: dessen WHERE-Klausel ist
-- "where status = 'offen' and valid_until < v_now" — ein widerrufenes Angebot
-- hat nach dieser Korrektur status='widerrufen', erfüllt die Bedingung also
-- nicht mehr und wird nicht mehr angefasst. Das ist exakt das gewünschte
-- Verhalten (widerrufen ist ein Endzustand) — KEINE Änderung an
-- fn_expire_offers nötig, greift bereits korrekt.
--
-- Auswirkung auf fn_get_offer_by_token (00149) geprüft: die Bedingung dort
-- ist bereits "v_offer.status <> 'offen' OR v_offer.revoked_at is not null
-- OR ...", die erste Teilbedingung reicht nach der Korrektur allein aus —
-- KEINE Änderung nötig, bleibt korrekt (die revoked_at-Prüfung wird dadurch
-- redundant, aber nicht falsch).
--
-- Auswirkung auf fn_accept_offer geprüft: prüft ebenfalls zuerst
-- "status <> 'offen'" (schlägt für ein widerrufenes Angebot jetzt schon dort
-- fehl) und danach zusätzlich "revoked_at is not null" — zweite Prüfung wird
-- unerreichbar, aber weiterhin korrekt. Keine Änderung, da nicht Teil dieses
-- Befunds.
--
-- Audit: die bisherige 'update'/'revoked_at'-Zeile bleibt erhalten (Feld hat
-- sich tatsächlich geändert), zusätzlich eine korrekte 'status_change'-Zeile
-- für den Statuswechsel selbst (#31, Muster wie bei allen anderen
-- Statusübergängen in diesem Projekt).
create or replace function fn_revoke_offer(
  p_offer_id      uuid,
  p_revoke_reason text,
  p_actor         text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer offers%rowtype;
  v_now   timestamptz := now();
begin
  if p_offer_id is null then
    raise exception 'fn_revoke_offer: offer_id darf nicht NULL sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_revoke_reason), '') is null then
    raise exception 'fn_revoke_offer: revoke_reason ist Pflicht'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_revoke_offer: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_offer
  from offers
  where id = p_offer_id
  for update;

  if not found then
    raise exception 'fn_revoke_offer: Angebot % existiert nicht', p_offer_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_offer.revoked_at is not null then
    raise exception 'fn_revoke_offer: Angebot % ist bereits widerrufen (%)', p_offer_id, v_offer.revoked_at
      using errcode = 'invalid_parameter_value';
  end if;

  if v_offer.status <> 'offen' then
    raise exception 'fn_revoke_offer: Angebot % hat Status % (nur ''offen'' kann widerrufen werden)', p_offer_id, v_offer.status
      using errcode = 'invalid_parameter_value';
  end if;

  update offers
  set status        = 'widerrufen',
      revoked_at    = v_now,
      revoke_reason = trim(p_revoke_reason),
      updated_at    = v_now
  where id = p_offer_id;

  perform fn_write_audit('offer', p_offer_id, 'update', 'revoked_at',
                         null, v_now::text, trim(p_revoke_reason), p_actor);
  perform fn_write_audit('offer', p_offer_id, 'status_change', 'status',
                         'offen', 'widerrufen', trim(p_revoke_reason), p_actor);
end;
$$;

revoke all on function fn_revoke_offer(uuid, text, text) from public;
revoke all on function fn_revoke_offer(uuid, text, text) from anon;
grant execute on function fn_revoke_offer(uuid, text, text) to authenticated;

-- ===========================================================================
-- ABSCHNITT F: FK nachziehen (Befund 7)
-- ===========================================================================
-- produkte-varianten-farben.md §2: products.source_custom_request_id war seit
-- 0002_ebene2.sql bewusst ohne FK angelegt ("FK wird in einer späteren
-- Migration nachgezogen") — dieser Nachzug blieb bislang aus.
--
-- ADD CONSTRAINT validiert per Default alle bestehenden Zeilen gegen die
-- Referenz (kein NOT VALID) — ein orphaner Wert würde den Migrationslauf mit
-- einer klaren FK-Verletzung abbrechen. Vorab-Prüfung des aktuellen Standes
-- (siehe Bericht): products.source_custom_request_id ist zu diesem Zeitpunkt
-- ausschließlich NULL, da 00151 keine Katalogdaten seedet und die einzige
-- Quelle für nicht-NULL-Werte (ein Admin-Workflow "Produkt aus Anfrage
-- anlegen") noch nicht existiert — kein Datenkonflikt zu erwarten.
alter table products
  add constraint fk_products_source_custom_request
  foreign key (source_custom_request_id) references custom_requests(id);
