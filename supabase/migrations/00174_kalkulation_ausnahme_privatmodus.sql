-- Migration 00174: Kalkulationspflicht nur im gewerblichen Modus
-- Entscheidung 2026-09-20 (Betreiber): im Privatmodus (settings.storefront_prices_visible
-- = false) blockiert eine fehlende Kalkulationsversion "Anfrage abschicken" nicht
-- mehr. Fehlt beim Checkout eine is_current-Version für die Variante, wird
-- automatisch eine 0-€-Version angelegt (fn_create_calculation_version,
-- reason='sonstiger_grund', margin 0) -- calculation_version_id bleibt NOT NULL,
-- Versionierung/#9 (unveränderliche Preis-Historie) strukturell unverändert.
-- Im gewerblichen Modus (storefront_prices_visible = true) bleibt die bisherige
-- Pflicht-Kalkulation (Exception) unverändert.
--
-- Spaltengleiche Kopie aus 00173, geändert: v_prices_visible wird jetzt vor
-- Abschnitt 2 ermittelt (auch bei existing_customer_id verfügbar), Abschnitt 5
-- verzweigt bei fehlender Kalkulation statt immer zu scheitern.

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
begin
  select s.storefront_prices_visible into v_prices_visible from settings s limit 1;

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

revoke all on function fn_place_order(uuid, jsonb) from public;
grant execute on function fn_place_order(uuid, jsonb) to anon, authenticated;
