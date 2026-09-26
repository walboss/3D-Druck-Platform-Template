-- Migration 00146: RPC-Funktionen Teil 5b
-- (fn_submit_custom_request, fn_create_offer_from_request, fn_revoke_offer)
-- Siehe specs/angebote-individuelle-anfragen.md §2 (custom_requests,
-- custom_request_colors, offers, offer_items), §3 (Geschäftsregeln), §4
-- (Statusübergänge), §5 (Randfälle); specs/architektur-technologie-v1.md §4
-- Punkt 4 (Token-Sicherheit, 128 Bit); specs/audit-settings.md §3 (#31:
-- jeder Statuswechsel mit audit_log-Eintrag — hier über fn_write_audit aus 00145).
--
-- Keine Datei-/ZIP-/XML-Verarbeitung der .gcode.3mf-Datei (Anwendungsebene):
-- slot_colors kommt bereits geparst als Parameter an, slice_file_upload ist
-- nur ein Textverweis. Kein fn_accept_offer (eigener Task, berührt die
-- Bestellanlage). Keine Funktion für status='geprueft'. Keine RLS-Policies.

-- ---------------------------------------------------------------------------
-- fn_hex_to_rgb(p_hex) → int[3]  (Hilfsfunktion, intern)
-- ---------------------------------------------------------------------------
-- Normalisiert einen Hex-Farbwert ('#RRGGBB', 'RRGGBB', auch 'RRGGBBAA' —
-- Alpha wird ignoriert) zu {r, g, b}. Ungültig/leer → NULL, keine Exception,
-- damit ein fehlerhafter Slot-Hex oder ein ungepflegter colors.hex nur zu
-- "kein Treffer" führt (angebote-individuelle-anfragen.md §5).
create or replace function fn_hex_to_rgb(p_hex text)
returns int[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v_hex text := lower(ltrim(trim(coalesce(p_hex, '')), '#'));
begin
  if v_hex !~ '^[0-9a-f]{6}([0-9a-f]{2})?$' then
    return null;
  end if;

  return array[
    ('x' || substr(v_hex, 1, 2))::bit(8)::int,
    ('x' || substr(v_hex, 3, 2))::bit(8)::int,
    ('x' || substr(v_hex, 5, 2))::bit(8)::int
  ];
end;
$$;

revoke all on function fn_hex_to_rgb(text) from public;
revoke all on function fn_hex_to_rgb(text) from anon;
grant execute on function fn_hex_to_rgb(text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_match_color_by_hex(p_hex) → uuid  (Hilfsfunktion, intern)
-- ---------------------------------------------------------------------------
-- Bestmöglicher Hex-Abgleich gegen colors: kleinster geometrischer Abstand im
-- RGB-Raum ((r1-r2)² + (g1-g2)² + (b1-b2)²) gewinnt. Nur aktive colors
-- (active = true) mit gültig gepflegtem hex nehmen teil — deaktivierte Farben
-- werden nie zugeordnet (→ NULL). Gleichstand → deterministisch nach name, id.
-- Ungültiger Eingabe-Hex oder keine passenden colors → NULL, keine Exception.
create or replace function fn_match_color_by_hex(p_hex text)
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v_rgb int[] := fn_hex_to_rgb(p_hex);
  v_id  uuid;
begin
  if v_rgb is null then
    return null;
  end if;

  select c.id
  into v_id
  from colors c
  cross join lateral (select fn_hex_to_rgb(c.hex) as rgb) x
  where c.active = true
    and x.rgb is not null
  order by (x.rgb[1] - v_rgb[1])^2 + (x.rgb[2] - v_rgb[2])^2 + (x.rgb[3] - v_rgb[3])^2,
           c.name, c.id
  limit 1;

  return v_id;
end;
$$;

revoke all on function fn_match_color_by_hex(text) from public;
revoke all on function fn_match_color_by_hex(text) from anon;
grant execute on function fn_match_color_by_hex(text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_submit_custom_request(p_customer, p_makerworld_link, p_own_image,
--   p_desired_size, p_qty, p_message, p_color_id, p_finish_id,
--   p_slice_file_upload, p_slot_colors) → uuid (custom_requests.id)
-- ---------------------------------------------------------------------------
-- p_customer: wie in fn_place_order (00142) — entweder
--             { "existing_customer_id": uuid }
--             oder { "first_name", "last_name", "email", "phone",
--                    "pickup_method" }   (email/phone optional)
--
-- Farbwahl (angebote-individuelle-anfragen.md §2, gegenseitiger Ausschluss):
--   p_slot_colors IS NULL        → einfarbig: p_color_id UND p_finish_id
--                                  Pflicht; keine custom_request_colors-Zeilen.
--   p_slot_colors = JSON-Array   → mehrfarbig: p_color_id/p_finish_id müssen
--     [{slot_label, hex}, ...]     NULL sein; je Slot eine
--                                  custom_request_colors-Zeile, color_id per
--                                  bestmöglichem Hex-Abgleich (kein Treffer →
--                                  NULL, kein Fehler, §5), finish_id NULL
--                                  (Slice-Daten liefern kein Finish).
--   Beides gesetzt / beides leer / leeres Array → Exception.
--
-- p_slice_file_upload: reiner Textverweis (z. B. Storage-Pfad), 1:1 gespeichert.
-- status startet immer auf 'neu'; Audit-Eintrag (null → 'neu') wie bei
-- fn_place_order für orders. Aufruf ohne Login möglich (#21, analog Checkout)
-- → actor = auth.uid() oder 'system'.
create or replace function fn_submit_custom_request(
  p_customer          jsonb,
  p_makerworld_link   text,
  p_own_image         text,
  p_desired_size      text,
  p_qty               int,
  p_message           text,
  p_color_id          uuid,
  p_finish_id         uuid,
  p_slice_file_upload text,
  p_slot_colors       jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       text := coalesce(auth.uid()::text, 'system');
  v_customer_id uuid;
  v_request_id  uuid;
  v_multicolor  boolean;
  v_slot        jsonb;
  v_slot_label  text;
  v_color_id    uuid;
begin
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

  -- 3. Kunde (Muster aus fn_place_order, 00142) --------------------------------
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
       or nullif(trim(p_customer->>'last_name'), '') is null
       or nullif(trim(p_customer->>'pickup_method'), '') is null then
      raise exception 'fn_submit_custom_request: Neuer Kunde braucht first_name, last_name und pickup_method (email/phone optional)'
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

  -- 4. Anfrage anlegen (status 'neu') -------------------------------------------
  insert into custom_requests (
    customer_id, makerworld_link, own_image, desired_size,
    color_id, finish_id, qty, message, status, slice_file_upload
  )
  values (
    v_customer_id,
    nullif(trim(p_makerworld_link), ''),
    nullif(trim(p_own_image), ''),
    trim(p_desired_size),
    p_color_id, p_finish_id,
    p_qty, p_message, 'neu',
    nullif(trim(p_slice_file_upload), '')
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
revoke all on function fn_submit_custom_request(jsonb, text, text, text, int, text, uuid, uuid, text, jsonb) from public;
grant execute on function fn_submit_custom_request(jsonb, text, text, text, int, text, uuid, uuid, text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- fn_create_offer_from_request(p_custom_request_id, p_valid_from,
--   p_valid_until, p_items, p_created_by) → uuid (offers.id)
-- ---------------------------------------------------------------------------
-- p_items: nicht-leeres JSON-Array von
--   { "product_id": uuid|null, "desired_variant_description": text,
--     "qty": int, "cost_components": {…}, "margin_percent": numeric,
--     "reason": calc_reason }
-- Je Position: offer_items.id wird vorab erzeugt, damit
-- fn_create_calculation_version(scope_type='offer_item', scope_id=<diese id>)
-- eine calculation_versions-Zeile anlegen kann (cost_components/margin/reason
-- werden dort validiert, 00145); anschließend die offer_items-Zeile mit der
-- zurückgegebenen calculation_version_id.
--
-- secure_token: encode(gen_random_bytes(16), 'hex') — 128 Bit Entropie,
-- pgcrypto liegt auf Supabase im Schema extensions → explizit qualifiziert,
-- da search_path = public.
-- 32-stelliger Hex-String (architektur-technologie-v1.md §4 Punkt 4).
-- offers.status startet auf 'offen' (§4: — → offen, Pflicht valid_from/valid_until).
--
-- custom_requests.status (§4, §3 "Neues Angebot zu bestehender Anfrage"):
--   'neu' / 'geprueft'   → 'angebot_erstellt' (+ Audit)
--   'angebot_erstellt'   → bleibt (erneutes Angebot zur selben Anfrage, 1:n)
--   'abgelehnt'          → Exception
-- Audit (#31): offer null → 'offen'; custom_request alt → 'angebot_erstellt'.
create or replace function fn_create_offer_from_request(
  p_custom_request_id uuid,
  p_valid_from        timestamptz,
  p_valid_until       timestamptz,
  p_items             jsonb,
  p_created_by        text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request     custom_requests%rowtype;
  v_offer_id    uuid;
  v_item        jsonb;
  v_item_id     uuid;
  v_product_id  uuid;
  v_desc        text;
  v_qty         int;
  v_calc_id     uuid;
begin
  -- 1. Eingabe validieren -----------------------------------------------------
  if p_custom_request_id is null then
    raise exception 'fn_create_offer_from_request: custom_request_id darf nicht NULL sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_valid_from is null or p_valid_until is null then
    raise exception 'fn_create_offer_from_request: valid_from und valid_until sind Pflicht'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_valid_until <= p_valid_from then
    raise exception 'fn_create_offer_from_request: valid_until muss nach valid_from liegen'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'fn_create_offer_from_request: items muss ein nicht-leeres JSON-Array sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_created_by), '') is null then
    raise exception 'fn_create_offer_from_request: created_by darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. Anfrage sperren und Status prüfen ---------------------------------------
  select * into v_request
  from custom_requests
  where id = p_custom_request_id
  for update;

  if not found then
    raise exception 'fn_create_offer_from_request: Anfrage % existiert nicht', p_custom_request_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_request.status = 'abgelehnt' then
    raise exception 'fn_create_offer_from_request: Anfrage % ist abgelehnt, kein Angebot möglich', p_custom_request_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- 3. Angebot anlegen (status 'offen', 128-Bit-Token) -------------------------
  insert into offers (custom_request_id, valid_from, valid_until, status, secure_token)
  values (p_custom_request_id, p_valid_from, p_valid_until, 'offen',
          encode(extensions.gen_random_bytes(16), 'hex'))
  returning id into v_offer_id;

  -- 4. Positionen: Kalkulationsversion je offer_item ---------------------------
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'fn_create_offer_from_request: jede Position muss ein JSON-Objekt sein'
        using errcode = 'invalid_parameter_value';
    end if;

    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    if v_product_id is not null
       and not exists (select 1 from products p where p.id = v_product_id) then
      raise exception 'fn_create_offer_from_request: Produkt % existiert nicht', v_product_id
        using errcode = 'invalid_parameter_value';
    end if;

    v_desc := nullif(trim(v_item->>'desired_variant_description'), '');
    if v_desc is null then
      raise exception 'fn_create_offer_from_request: desired_variant_description darf nicht leer sein'
        using errcode = 'invalid_parameter_value';
    end if;

    v_qty := (v_item->>'qty')::int;
    if v_qty is null or v_qty < 1 then
      raise exception 'fn_create_offer_from_request: qty muss >= 1 sein'
        using errcode = 'invalid_parameter_value';
    end if;

    v_item_id := gen_random_uuid();

    -- Kosten/Marge/Grund werden in fn_create_calculation_version validiert (00145).
    v_calc_id := fn_create_calculation_version(
      'offer_item',
      v_item_id,
      v_item->'cost_components',
      (v_item->>'margin_percent')::numeric,
      (v_item->>'reason')::calc_reason,
      p_created_by
    );

    insert into offer_items (id, offer_id, product_id, desired_variant_description, qty, calculation_version_id)
    values (v_item_id, v_offer_id, v_product_id, v_desc, v_qty, v_calc_id);
  end loop;

  -- 5. Audit Angebot (#31) -----------------------------------------------------
  perform fn_write_audit('offer', v_offer_id, 'status_change', 'status',
                         null, 'offen', null, p_created_by);

  -- 6. Anfrage-Status ------------------------------------------------------------
  if v_request.status in ('neu', 'geprueft') then
    update custom_requests
    set status = 'angebot_erstellt', updated_at = now()
    where id = p_custom_request_id;

    perform fn_write_audit('custom_request', p_custom_request_id, 'status_change', 'status',
                           v_request.status::text, 'angebot_erstellt', null, p_created_by);
  end if;
  -- 'angebot_erstellt' bleibt unverändert (§3/§4, kein Zurück, kein erneuter Audit)

  return v_offer_id;
end;
$$;

revoke all on function fn_create_offer_from_request(uuid, timestamptz, timestamptz, jsonb, text) from public;
revoke all on function fn_create_offer_from_request(uuid, timestamptz, timestamptz, jsonb, text) from anon;
grant execute on function fn_create_offer_from_request(uuid, timestamptz, timestamptz, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_revoke_offer(p_offer_id, p_revoke_reason, p_actor) → void
-- ---------------------------------------------------------------------------
-- Sperrt einen (z. B. geleakten) Angebotslink (§3 "Widerruf eines
-- Angebotslinks"): setzt revoked_at/revoke_reason, der fachliche
-- offers.status bleibt unverändert (Task-Vorgabe). Nur erlaubt bei
-- status = 'offen' UND revoked_at IS NULL, sonst Exception. revoke_reason ist
-- Pflicht, wenn revoked_at gesetzt wird (§2). Audit-Eintrag als
-- Feldänderung (action 'update', field revoked_at, reason = revoke_reason).
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
  set revoked_at    = v_now,
      revoke_reason = trim(p_revoke_reason),
      updated_at    = v_now
  where id = p_offer_id;

  perform fn_write_audit('offer', p_offer_id, 'update', 'revoked_at',
                         null, v_now::text, trim(p_revoke_reason), p_actor);
end;
$$;

revoke all on function fn_revoke_offer(uuid, text, text) from public;
revoke all on function fn_revoke_offer(uuid, text, text) from anon;
grant execute on function fn_revoke_offer(uuid, text, text) to authenticated;
