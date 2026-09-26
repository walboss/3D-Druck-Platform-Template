-- Migration 00147: RPC-Funktionen Teil 5c
-- (fn_accept_offer)
-- Siehe specs/angebote-individuelle-anfragen.md §3 (akzeptiertes Angebot →
-- reguläre orders/order_items-Anlage, Ausnahmepfad), §4 (offen → akzeptiert),
-- §5 (Randfälle: erneuter Aufruf nach Akzeptanz, Verfügbarkeit bei Nutzung);
-- specs/bestellungen.md §2 (order_items-Constraint Katalog-Trippel XOR
-- desired_description), §3 (Atomarität #15), §4 (New → Confirmed);
-- specs/00-overview.md #9 (alte Bestellungen unverändert bei neuen Preisen),
-- #15 (Bestellannahme atomar).
--
-- Entscheidung (Task-Vorgabe): offer_items hat kein variant_id /
-- variant_configuration_id — das Katalog-Trippel auf order_items kann aus
-- einem Angebot strukturell nie erfüllt werden. Deshalb nutzen ALLE aus einem
-- Angebot entstehenden order_items den Ausnahmepfad (product_id / variant_id /
-- variant_configuration_id = NULL, desired_description gesetzt), unabhängig
-- davon, ob offer_items.product_id gesetzt ist — dieses bleibt rein
-- informativ auf Angebotsebene und wird nicht übertragen.
--
-- fn_place_order (00142) wird NICHT wiederverwendet (cart-basiert,
-- cart_items.product_id NOT NULL — strukturell inkompatibel). orders /
-- order_items werden hier direkt aufgebaut, anschließend wird das bestehende
-- fn_confirm_order(order_id) für den Reservierungsversuch aufgerufen.
-- Keine Schema-Änderung, keine RLS-Policies.

-- ---------------------------------------------------------------------------
-- fn_accept_offer(p_secure_token) → uuid (orders.id)
-- ---------------------------------------------------------------------------
-- Kunde nutzt den Angebotslink und löst damit die Bestellung aus
-- (angebote-individuelle-anfragen.md §4: offen → akzeptiert).
--
-- Ablauf (eine Transaktion, jeder RAISE rollt alles zurück — #15/#31):
--   1. offers per secure_token laden und mit FOR UPDATE sperren (zwei
--      gleichzeitige Aufrufe desselben Links: der zweite wartet und sieht
--      dann status = 'akzeptiert' → Exception). Exception, wenn:
--        - kein Angebot zum Token
--        - status <> 'offen' (deckt auch "Link nach Akzeptanz erneut
--          aufgerufen" ab, §5 — kein zusätzlicher DB-Zustand)
--        - revoked_at IS NOT NULL (gesperrter Link, §3 — status bleibt 'offen')
--        - now() nicht in [valid_from, valid_until]
--   2. customer_id aus der zugehörigen custom_request (Kunde ist über die
--      Anfrage bereits bekannt — kein neuer customers-Datensatz).
--   3. Bestellnummer 'ORDER-<JAHR>-<5-stellig>' — gleiche Strategie und
--      DERSELBE Advisory-Lock-Schlüssel wie fn_place_order (00142), damit
--      Katalog-Checkout und Angebotsannahme sich denselben Nummernkreis
--      teilen und gegeneinander serialisiert sind.
--   4. orders anlegen: status = 'New', source = 'custom_offer',
--      offer_id = offers.id.
--   5. Je offer_items-Zeile eine order_items-Zeile über den Ausnahmepfad:
--      product_id / variant_id / variant_configuration_id = NULL,
--      desired_description = desired_variant_description, qty,
--      calculation_version_id = offer_items.calculation_version_id
--      UNVERÄNDERT übernommen — keine Neuberechnung, der Preis ist beim
--      Angebot fixiert (#9), status = 'Offen'.
--   6. offers.status: offen → akzeptiert.
--   7. Audit (#31): orders null → 'New', offers 'offen' → 'akzeptiert'.
--   8. fn_confirm_order(order_id): Reservierungsversuch. Da alle Positionen
--      ohne Katalogbezug sind, gibt es keinen Fertigwarenbestand — sie gehen
--      auf 'WartetAufMaterial', die Bestellung bleibt 'New' (identisches
--      Verhalten wie eine reguläre Bestellung ohne Bestand, §5).
--
-- Aufruf ohne Login (#21, Kunde hat keinen Account) → anon darf aufrufen;
-- actor = auth.uid() oder 'system'. fn_confirm_order ist zwar für anon
-- gesperrt, wird hier aber innerhalb der SECURITY-DEFINER-Funktion als
-- Funktionsowner aufgerufen — die Sperre für direkte anon-Aufrufe bleibt.
create or replace function fn_accept_offer(p_secure_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        text := coalesce(auth.uid()::text, 'system');
  v_offer        offers%rowtype;
  v_customer_id  uuid;
  v_order_id     uuid;
  v_year         text := to_char(current_date, 'YYYY');
  v_next_no      int;
  v_order_number text;
  v_item         record;
  v_now          timestamptz := now();
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
  -- Ergebnis (Confirmed oder weiterhin New mit WartetAufMaterial) wird von
  -- fn_confirm_order selbst persistiert und auditiert.
  perform fn_confirm_order(v_order_id);

  return v_order_id;
end;
$$;

-- Angebotsannahme ohne Login (#21, analog fn_place_order) → anon darf aufrufen; Admin ebenfalls.
revoke all on function fn_accept_offer(text) from public;
grant execute on function fn_accept_offer(text) to anon, authenticated;
