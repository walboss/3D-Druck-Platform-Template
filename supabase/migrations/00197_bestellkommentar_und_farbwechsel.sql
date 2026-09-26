-- Migration 00197: Kunden-Kommentar bei der Bestellung + Farbwechsel im Admin
--
-- Wunsch/Entscheidungen Betreiber 2026-09-26:
-- 1. Optionales Kommentarfeld im Checkout (max. 500 Zeichen). Gespeichert in
--    der vorhandenen Spalte orders.customer_message (specs/bestellungen.md:
--    strikt getrennt von internal_note). fn_place_order liest dafür
--    p_customer->>'message' (Signatur unverändert, Stand 00193 + Kommentar).
--    Anzeige im Admin-Dashboard/Bestellungen liest direkt aus orders.
-- 2. Farbe/Finish einer Bestellposition im Admin ändern
--    (fn_change_order_item_configuration):
--    - nur bis Produktionsstart: Position 'Offen'/'WartetAufMaterial', oder
--      'InProduktion' in einem noch 'Geplant'en Auftrag, oder 'Fertig' aus
--      Lagerbestand (aktive Reservierung, noch nichts für sie gedruckt);
--      Bestellung nicht ReadyForPickup/HandedOver/Cancelled
--    - Grund ist Pflicht → audit_log (alte/neue Farbe als Klartext, Grund)
--    - alte Reservierung wird freigegeben, Position aus 'Geplant'em Auftrag
--      gelöst (leerer Auftrag wird entfernt, Muster aus 00185)
--    - danach wie fn_confirm_order: Lagerbestand der neuen Farbe reicht →
--      reservieren + 'Fertig'; sonst Zuordnung zum Standard-Drucker (gleiche
--      Konfiguration bündeln) bzw. 'Offen', falls kein Standard-Drucker
--    - Bestellstatus wird passend nachgezogen. Preis bleibt (hängt an der
--      Variante, nicht an der Farbe, #9).

-- ===========================================================================
-- 1. fn_place_order mit Kunden-Kommentar
-- ===========================================================================
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
  v_actor          text := coalesce(auth.uid()::text, 'system');
  v_customer_id    uuid;
  v_phone          text;
  v_email          text;
  v_order_id       uuid;
  v_year           text := to_char(current_date, 'YYYY');
  v_next_no        int;
  v_order_number   text;
  v_item           record;
  v_vc_id          uuid;
  v_calc_id        uuid;
  v_tracking_token text;
  v_prices_visible boolean;
  v_shop_enabled   boolean;
  v_message        text;
begin
  select s.storefront_prices_visible, s.storefront_shop_enabled
    into v_prices_visible, v_shop_enabled
  from settings s limit 1;

  -- 0. Schalter "Wunschliste/Shop" (00193) ------------------------------------
  if not coalesce(v_shop_enabled, false) then
    raise exception 'Bestellungen/Wunschlisten sind derzeit deaktiviert'
      using errcode = 'P0001', hint = 'shop_disabled';
  end if;

  -- 0b. Optionaler Kunden-Kommentar (00197) → orders.customer_message ------
  v_message := nullif(trim(p_customer->>'message'), '');
  if v_message is not null and char_length(v_message) > 500 then
    raise exception 'Kommentar darf höchstens 500 Zeichen haben'
      using errcode = 'invalid_parameter_value', hint = 'message_too_long';
  end if;

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
       or nullif(trim(p_customer->>'pickup_method'), '') is null then
      raise exception 'Neuer Kunde braucht first_name und pickup_method (weitere Felder optional)'
        using errcode = 'invalid_parameter_value';
    end if;

    if coalesce(v_prices_visible, false) and nullif(trim(p_customer->>'last_name'), '') is null then
      raise exception 'Neuer Kunde braucht last_name (Pflicht im gewerblichen Modus)'
        using errcode = 'invalid_parameter_value';
    end if;

    -- Dedup-Suche (specs/17 §4 Pkt. 5), Normalisierung analog fn_customer_search.
    v_phone := nullif(trim(p_customer->>'phone'), '');
    v_email := nullif(lower(trim(p_customer->>'email')), '');

    if v_phone is not null or v_email is not null then
      select c.id into v_customer_id
      from customers c
      where (v_phone is not null and c.phone = v_phone)
         or (v_email is not null and lower(c.email) = v_email)
      order by c.created_at desc
      limit 1;
    end if;

    if v_customer_id is null then
      insert into customers (first_name, last_name, email, phone, pickup_method)
      values (
        trim(p_customer->>'first_name'),
        coalesce(nullif(trim(p_customer->>'last_name'), ''), ''),
        nullif(trim(p_customer->>'email'), ''),
        nullif(trim(p_customer->>'phone'), ''),
        trim(p_customer->>'pickup_method')
      )
      returning id into v_customer_id;
    end if;
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
  insert into orders (order_number, customer_id, status, source, customer_message)
  values (v_order_number, v_customer_id, 'New', 'catalog', v_message)
  returning id into v_order_id;

  -- 4b. Tracking-Token (kunden-warenkorb-tracking.md §2/§3) ------------------
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
      if coalesce(v_prices_visible, false) then
        raise exception 'Variante "%" (%) hat keine gültige Kalkulation (is_current) und ist nicht bestellbar',
          v_item.size_label, v_item.variant_id
          using errcode = 'check_violation';
      else
        -- Privatmodus: keine Kalkulationspflicht -- 0-€-Version automatisch
        -- anlegen (Preis für Kunden ohnehin unsichtbar, showPrices=false).
        v_calc_id := fn_create_calculation_version(
          'product_variant', v_item.variant_id, '{}'::jsonb, 0, 'sonstiger_grund', v_actor
        );
      end if;
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

-- ===========================================================================
-- 2. Farbwechsel
-- ===========================================================================

-- Klartext einer Konfiguration, z. B. "Grün/Matt" oder "Körper: Grün/Matt, Kopf: Braun/Seide"
-- (gleiche Darstellung wie fn_get_order_by_token).
create or replace function fn_variant_configuration_label_internal(p_vc_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select string_agg(
           case when vcc.product_part_id is null
                then col.name || '/' || fin.name
                else pp.name || ': ' || col.name || '/' || fin.name
           end,
           ', ' order by pp.sort_order nulls first, col.name
         )
  from variant_configuration_colors vcc
  left join product_parts pp on pp.id = vcc.product_part_id
  join colors col   on col.id = vcc.color_id
  join finishes fin on fin.id = vcc.finish_id
  where vcc.variant_configuration_id = p_vc_id;
$$;

revoke all on function fn_variant_configuration_label_internal(uuid) from public, anon, authenticated;

create or replace function fn_change_order_item_configuration(
  p_order_item_id  uuid,
  p_part_color_map jsonb,
  p_reason         text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        text := coalesce(auth.uid()::text, 'system');
  v_reason       text := nullif(trim(p_reason), '');
  v_item         record;
  v_order_status order_status;
  v_po_status    production_order_status;
  v_has_res      boolean;
  v_new_vc       uuid;
  v_old_label    text;
  v_new_label    text;
  v_stock        int;
  v_reserved     int;
  v_reservation  uuid;
  v_printer_id   uuid;
  v_po_id        uuid;
  v_new_status   order_item_status;
  v_final_status order_status;
begin
  if v_reason is null then
    raise exception 'Grund für die Farbänderung ist Pflicht'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 1. Position + Bestellung sperren und prüfen ------------------------------
  select oi.id, oi.order_id, oi.status, oi.variant_id, oi.variant_configuration_id,
         oi.production_order_id, oi.qty
    into v_item
  from order_items oi
  where oi.id = p_order_item_id
  for update;

  if not found then
    raise exception 'Bestellposition % existiert nicht', p_order_item_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_item.variant_configuration_id is null then
    raise exception 'Nur Katalogpositionen haben eine Farbkonfiguration'
      using errcode = 'check_violation';
  end if;

  select o.status into v_order_status
  from orders o where o.id = v_item.order_id
  for update;

  if v_order_status in ('ReadyForPickup', 'HandedOver', 'Cancelled') then
    raise exception 'Bestellung hat Status % — Farbe kann nicht mehr geändert werden', v_order_status
      using errcode = 'check_violation';
  end if;

  select exists (
    select 1 from finished_goods_reservations r
    where r.order_item_id = v_item.id and r.status = 'aktiv'
  ) into v_has_res;

  if v_item.production_order_id is not null then
    select po.status into v_po_status
    from production_orders po where po.id = v_item.production_order_id
    for update;
  end if;

  if not coalesce(
       v_item.status in ('Offen', 'WartetAufMaterial')
         and (v_item.production_order_id is null or v_po_status = 'Geplant')
    or v_item.status = 'InProduktion' and v_po_status = 'Geplant'
    or v_item.status = 'Fertig' and v_has_res and v_item.production_order_id is null
         and not exists (select 1 from production_batch_items b where b.order_item_id = v_item.id)
  , false) then
    raise exception 'Farbe kann nur bis zum Produktionsstart geändert werden (Position: %)', v_item.status
      using errcode = 'check_violation', hint = 'production_started';
  end if;

  -- 2. Neue Konfiguration (validiert Farben/Finishes, legt ggf. an) ----------
  v_new_vc := fn_create_variant_configuration_if_missing(v_item.variant_id, p_part_color_map);

  if v_new_vc = v_item.variant_configuration_id then
    raise exception 'Die gewählte Farbe entspricht der bisherigen'
      using errcode = 'check_violation', hint = 'unchanged';
  end if;

  v_old_label := fn_variant_configuration_label_internal(v_item.variant_configuration_id);
  v_new_label := fn_variant_configuration_label_internal(v_new_vc);

  -- 3. Alte Bindungen lösen ---------------------------------------------------
  perform fn_release_reservations_for_item_internal(v_item.id, v_actor);

  if v_item.production_order_id is not null then
    update order_items
    set production_order_id = null, updated_at = now()
    where id = v_item.id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
    values ('order_item', v_item.id, 'update', 'production_order_id',
            v_item.production_order_id::text, null, 'Farbänderung', v_actor);

    if not exists (select 1 from order_items oi where oi.production_order_id = v_item.production_order_id)
       and not exists (select 1 from production_batch_items b where b.production_order_id = v_item.production_order_id) then
      delete from production_orders where id = v_item.production_order_id;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
      values ('production_order', v_item.production_order_id, 'delete', 'status', 'Geplant', null,
              'leer nach Farbänderung', v_actor);
    end if;
  end if;

  -- 4. Konfiguration umstellen (Status zunächst 'Offen') ---------------------
  update order_items
  set variant_configuration_id = v_new_vc,
      status                   = 'Offen',
      updated_at               = now()
  where id = v_item.id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
  values ('order_item', v_item.id, 'update', 'variant_configuration_id',
          v_old_label, v_new_label, v_reason, v_actor);

  if v_item.status <> 'Offen' then
    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
    values ('order_item', v_item.id, 'status_change', 'status',
            v_item.status::text, 'Offen', 'Farbänderung', v_actor);
  end if;

  v_new_status := 'Offen';

  -- 5. Neu einplanen (nur nach Bestätigung; 'New' macht fn_confirm_order) ----
  if v_order_status <> 'New' then
    perform 1 from variant_configurations vc where vc.id = v_new_vc for update;

    select coalesce(sum(m.qty_delta), 0) into v_stock
    from finished_goods_movements m
    where m.variant_configuration_id = v_new_vc and m.stock_type = 'normal';

    select coalesce(sum(r.qty), 0) into v_reserved
    from finished_goods_reservations r
    where r.variant_configuration_id = v_new_vc and r.stock_type = 'normal' and r.status = 'aktiv';

    if (v_stock - v_reserved) >= v_item.qty then
      insert into finished_goods_reservations
        (variant_configuration_id, stock_type, order_item_id, qty, status)
      values (v_new_vc, 'normal', v_item.id, v_item.qty, 'aktiv')
      returning id into v_reservation;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('finished_goods_reservation', v_reservation, 'status_change', 'status', null, 'aktiv', v_actor);

      update order_items set status = 'Fertig', updated_at = now() where id = v_item.id;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('order_item', v_item.id, 'status_change', 'status', 'Offen', 'Fertig', v_actor);

      v_new_status := 'Fertig';
    else
      select p.id into v_printer_id
      from printers p where p.is_default and p.active limit 1;

      if v_printer_id is not null then
        -- Bestellung war schon komplett 'Finished' → wieder 'Confirmed',
        -- damit fn_assign_to_production sie auf 'InProduction' setzt.
        if v_order_status = 'Finished' then
          update orders set status = 'Confirmed', finished_at = null, updated_at = now()
          where id = v_item.order_id;

          insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
          values ('order', v_item.order_id, 'status_change', 'status', 'Finished', 'Confirmed', 'Farbänderung', v_actor);
        end if;

        select po.id into v_po_id
        from production_orders po
        where po.printer_id = v_printer_id
          and po.status = 'Geplant'
          and exists (
            select 1 from order_items oi2
            where oi2.production_order_id = po.id
              and oi2.status <> 'Storniert'
              and oi2.variant_configuration_id = v_new_vc
          )
        order by po.created_at
        limit 1
        for update;

        if v_po_id is null then
          v_po_id := fn_create_production_order(v_printer_id, null, v_actor);
        end if;

        perform fn_assign_to_production(v_item.id, v_po_id);
        v_new_status := 'InProduktion';
      end if;
    end if;
  end if;

  -- 6. Bestellstatus nachziehen ----------------------------------------------
  select o.status into v_final_status from orders o where o.id = v_item.order_id;

  if v_final_status in ('Confirmed', 'InProduction')
     and not exists (
       select 1 from order_items oi
       where oi.order_id = v_item.order_id and oi.status not in ('Fertig', 'Storniert')
     ) then
    update orders set status = 'Finished', finished_at = now(), updated_at = now()
    where id = v_item.order_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
    values ('order', v_item.order_id, 'status_change', 'status', v_final_status::text, 'Finished', 'Farbänderung', v_actor);
    v_final_status := 'Finished';
  elsif v_final_status = 'InProduction'
     and not exists (
       select 1 from order_items oi
       where oi.order_id = v_item.order_id and oi.status = 'InProduktion'
     ) then
    update orders set status = 'Confirmed', updated_at = now() where id = v_item.order_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
    values ('order', v_item.order_id, 'status_change', 'status', 'InProduction', 'Confirmed', 'Farbänderung', v_actor);
    v_final_status := 'Confirmed';
  elsif v_final_status = 'Finished' and v_new_status = 'Offen' then
    -- kein Standard-Drucker: Position wartet auf manuelle Zuordnung
    update orders set status = 'Confirmed', finished_at = null, updated_at = now() where id = v_item.order_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
    values ('order', v_item.order_id, 'status_change', 'status', 'Finished', 'Confirmed', 'Farbänderung', v_actor);
    v_final_status := 'Confirmed';
  end if;

  return jsonb_build_object(
    'old_configuration', v_old_label,
    'new_configuration', v_new_label,
    'item_status',       v_new_status,
    'order_status',      v_final_status
  );
end;
$$;

revoke all on function fn_change_order_item_configuration(uuid, jsonb, text) from public, anon;
grant execute on function fn_change_order_item_configuration(uuid, jsonb, text) to authenticated;
