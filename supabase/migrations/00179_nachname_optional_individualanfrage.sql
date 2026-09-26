-- Migration 00179: Nachname im Individualanfrage-Formular nur im gewerblichen
-- Modus Pflicht (analog Migration 00173, die das fuer fn_place_order bereits
-- umgesetzt hat -- fn_submit_custom_request hatte dieselbe Lockerung nie
-- bekommen und verlangte weiterhin immer first_name UND last_name).
-- Frontend (custom-request-form.ts/.html) entsprechend angepasst.
--
-- customers.last_name bleibt `not null` (Schema unveraendert) -- bei
-- fehlendem Nachnamen wird ein leerer String gespeichert, kein
-- Constraint-Verstoss. Funktionskoerper identisch zu 00158, nur Abschnitt 3
-- (Kunde) geaendert.

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
begin
  select s.storefront_prices_visible into v_prices_visible from settings s limit 1;

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

-- Anfrage ohne Login (#21, analog fn_place_order) → anon darf aufrufen; Admin ebenfalls.
revoke all on function fn_submit_custom_request(jsonb, text, text, text, int, text, uuid, uuid, text, jsonb, numeric, integer) from public;
grant execute on function fn_submit_custom_request(jsonb, text, text, text, int, text, uuid, uuid, text, jsonb, numeric, integer) to anon, authenticated;
