-- Migration 00193: Shop-Schalter serverseitig durchsetzen
--
-- Befund Security-Check 2026-09-25 (Entscheidung Betreiber 2026-09-25: "DB
-- blockt"): settings.storefront_shop_enabled (00164) und
-- settings.storefront_custom_request_enabled (00165) wirkten nur im Frontend
-- (Route-Guards). Ein Direktaufruf über den API-Worker legte trotz
-- ausgeschaltetem Schalter Bestellungen/Individualanfragen an.
--
-- fn_place_order (Stand 00174) und fn_submit_custom_request (Stand 00179)
-- werden unverändert übernommen, nur ergänzt um Schritt 0: ist der jeweilige
-- Schalter aus (oder fehlt die settings-Zeile), bricht die Funktion mit
-- Fehler ab (hint 'shop_disabled' bzw. 'custom_request_disabled', der
-- API-Worker übersetzt das in einen Kundentext).
--
-- create or replace lässt die Grants unverändert (Stand 00192: kein anon,
-- nur authenticated + service_role).

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
begin
  select s.storefront_prices_visible, s.storefront_shop_enabled
    into v_prices_visible, v_shop_enabled
  from settings s limit 1;

  -- 0. Schalter "Wunschliste/Shop" (00193) ------------------------------------
  if not coalesce(v_shop_enabled, false) then
    raise exception 'Bestellungen/Wunschlisten sind derzeit deaktiviert'
      using errcode = 'P0001', hint = 'shop_disabled';
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
  insert into orders (order_number, customer_id, status, source)
  values (v_order_number, v_customer_id, 'New', 'catalog')
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

create or replace function fn_submit_custom_request(
  p_customer                jsonb,
  p_makerworld_link         text,
  p_own_image               text,
  p_desired_size            text,
  p_qty                     int,
  p_message                 text,
  p_color_id                uuid,
  p_finish_id               uuid,
  p_slice_file_upload       text,
  p_slot_colors             jsonb,
  p_estimated_weight_g      numeric default null,
  p_estimated_print_minutes integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor          text := coalesce(auth.uid()::text, 'system');
  v_customer_id    uuid;
  v_request_id     uuid;
  v_multicolor     boolean;
  v_slot           jsonb;
  v_slot_label     text;
  v_color_id       uuid;
  v_prices_visible boolean;
  v_request_enabled boolean;
begin
  select s.storefront_prices_visible, s.storefront_custom_request_enabled
    into v_prices_visible, v_request_enabled
  from settings s limit 1;

  -- 0. Schalter "Individualanfrage" (00193) ------------------------------------
  if not coalesce(v_request_enabled, false) then
    raise exception 'Individualanfragen sind derzeit deaktiviert'
      using errcode = 'P0001', hint = 'custom_request_disabled';
  end if;

  -- 1. Pflichtfelder ----------------------------------------------------------
  if nullif(trim(p_desired_size), '') is null then
    raise exception 'fn_submit_custom_request: desired_size darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_qty is null or p_qty < 1 then
    raise exception 'fn_submit_custom_request: qty muss >= 1 sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_message), '') is null then
    raise exception 'fn_submit_custom_request: message darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. Farbwahl: einfarbig XOR mehrfarbig (§2) ---------------------------------
  v_multicolor := p_slot_colors is not null and jsonb_typeof(p_slot_colors) <> 'null';

  if v_multicolor then
    if jsonb_typeof(p_slot_colors) <> 'array' or jsonb_array_length(p_slot_colors) = 0 then
      raise exception 'fn_submit_custom_request: slot_colors muss ein nicht-leeres JSON-Array von {slot_label, hex} sein'
        using errcode = 'invalid_parameter_value';
    end if;
    if p_color_id is not null or p_finish_id is not null then
      raise exception 'fn_submit_custom_request: color_id/finish_id und slot_colors schließen sich gegenseitig aus (einfarbig ODER mehrfarbig)'
        using errcode = 'invalid_parameter_value';
    end if;
  else
    if p_color_id is null or p_finish_id is null then
      raise exception 'fn_submit_custom_request: einfarbige Anfrage braucht color_id und finish_id (oder slot_colors für mehrfarbig)'
        using errcode = 'invalid_parameter_value';
    end if;
    if not exists (select 1 from colors c where c.id = p_color_id) then
      raise exception 'fn_submit_custom_request: Farbe % existiert nicht', p_color_id
        using errcode = 'invalid_parameter_value';
    end if;
    if not exists (select 1 from finishes f where f.id = p_finish_id) then
      raise exception 'fn_submit_custom_request: Finish % existiert nicht', p_finish_id
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- 3. Kunde (Muster aus fn_place_order, zuletzt 00174) ------------------------
  if p_customer is null or jsonb_typeof(p_customer) <> 'object' then
    raise exception 'fn_submit_custom_request: p_customer muss ein JSON-Objekt sein'
      using errcode = 'invalid_parameter_value';
  end if;

  if nullif(p_customer->>'existing_customer_id', '') is not null then
    v_customer_id := (p_customer->>'existing_customer_id')::uuid;

    if not exists (select 1 from customers c where c.id = v_customer_id) then
      raise exception 'fn_submit_custom_request: Kunde % existiert nicht', v_customer_id
        using errcode = 'invalid_parameter_value';
    end if;
  else
    if nullif(trim(p_customer->>'first_name'), '') is null
       or nullif(trim(p_customer->>'pickup_method'), '') is null then
      raise exception 'fn_submit_custom_request: Neuer Kunde braucht first_name und pickup_method (weitere Felder optional)'
        using errcode = 'invalid_parameter_value';
    end if;

    if coalesce(v_prices_visible, false) and nullif(trim(p_customer->>'last_name'), '') is null then
      raise exception 'fn_submit_custom_request: Neuer Kunde braucht last_name (Pflicht im gewerblichen Modus)'
        using errcode = 'invalid_parameter_value';
    end if;

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

  -- 4. Anfrage anlegen (status 'neu') -------------------------------------------
  -- estimated_weight_g / estimated_print_minutes: unverbindlicher Vorschlag
  -- aus der 3mf-Datei, 1:1 gespeichert (NULL wenn nicht übergeben).
  insert into custom_requests (
    customer_id, makerworld_link, own_image, desired_size,
    color_id, finish_id, qty, message, status, slice_file_upload,
    estimated_weight_g, estimated_print_minutes
  )
  values (
    v_customer_id,
    nullif(trim(p_makerworld_link), ''),
    nullif(trim(p_own_image), ''),
    trim(p_desired_size),
    p_color_id, p_finish_id,
    p_qty, p_message, 'neu',
    nullif(trim(p_slice_file_upload), ''),
    p_estimated_weight_g, p_estimated_print_minutes
  )
  returning id into v_request_id;

  -- 5. Mehrfarbig: je Slot eine custom_request_colors-Zeile ---------------------
  if v_multicolor then
    for v_slot in select value from jsonb_array_elements(p_slot_colors)
    loop
      if jsonb_typeof(v_slot) <> 'object' then
        raise exception 'fn_submit_custom_request: jeder slot_colors-Eintrag muss ein Objekt {slot_label, hex} sein'
          using errcode = 'invalid_parameter_value';
      end if;

      v_slot_label := nullif(trim(v_slot->>'slot_label'), '');
      if v_slot_label is null then
        raise exception 'fn_submit_custom_request: slot_label darf nicht leer sein'
          using errcode = 'invalid_parameter_value';
      end if;

      -- kein/ungültiger Hex oder keine passende Farbe → NULL (§5, kein Blocker)
      v_color_id := fn_match_color_by_hex(v_slot->>'hex');

      insert into custom_request_colors (custom_request_id, slot_label, color_id, finish_id)
      values (v_request_id, v_slot_label, v_color_id, null);
    end loop;
  end if;

  -- 6. Audit-Log (#31) -----------------------------------------------------------
  perform fn_write_audit('custom_request', v_request_id, 'status_change', 'status',
                         null, 'neu', null, v_actor);

  return v_request_id;
end;
$$;
