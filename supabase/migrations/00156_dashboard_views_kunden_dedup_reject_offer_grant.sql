-- Migration 00156: Backend-Lücken aus dem Frontend-Build schließen
-- Siehe specs/16-admin-dashboard.md (Dashboard-Views),
-- specs/17-storefront-katalog-checkout.md §4 (Checkout/Kunden-Dedup),
-- specs/18-storefront-anfrage-angebot-tracking.md §7 (Angebot ablehnen),
-- BUILD-LOG.md (Abschnitte "Phase 2, Schritt 2 (Teil 1)" und
-- "Phase 1, Schritt 4" / "Schritt 7+8" für den jeweiligen Fund).
--
-- Drei unabhängige Korrekturen, siehe Abschnitte A/B/C unten.

-- ===========================================================================
-- ABSCHNITT A: Admin-Dashboard-Views (specs/16)
-- ===========================================================================
-- specs/16 sah die Anlage dieser Views ursprünglich erst "später in der
-- Umsetzungsphase der UI/UX-Spezifikation" vor. Diese Phase ist inzwischen
-- durchlaufen (Frontend-Build-Task) und hat die drei Kacheln mangels Views
-- clientseitig aggregiert (BUILD-LOG.md, "Phase 2, Schritt 2 (Teil 1)") — die
-- jetzige Aufgabe holt genau das explizit nach. Muster analog v_catalog/
-- v_order_tracking (00150): Views laufen mit den Rechten des Eigentümers
-- (umgehen RLS der Basistabellen), deshalb ausschließlich `authenticated`
-- gegrantet, kein Grant an `anon` — Dashboard ist eine reine Admin-Ansicht.
--
-- Row-Level (eine Zeile je Bestellung/Spule/Produktionsauftrag), nicht
-- vorab auf einen Zähler aggregiert — gleiches Prinzip wie v_catalog/
-- v_order_tracking, die ebenfalls Detailzeilen liefern und die Aggregation
-- (Zählen, Gruppieren) der aufrufenden Seite überlassen.

-- ---------------------------------------------------------------------------
-- v_dashboard_orders_open — offene Bestellungen
-- ---------------------------------------------------------------------------
-- Statusmenge ('New','Confirmed','InProduction') exakt wie bereits im
-- Frontend etabliert und dokumentiert (BUILD-LOG.md, "Phase 2, Schritt 2
-- (Teil 1)") — hier nur serverseitig nachgezogen, keine neue Geschäftsregel.
create view v_dashboard_orders_open as
select
  o.id          as order_id,
  o.order_number,
  o.status,
  o.created_at,
  o.customer_id,
  c.first_name,
  c.last_name
from orders o
join customers c on c.id = o.customer_id
where o.status in ('New', 'Confirmed', 'InProduction');

grant select on v_dashboard_orders_open to authenticated;

-- ---------------------------------------------------------------------------
-- v_dashboard_stock_low — Filamentspulen unter dem Schwellenwert
-- ---------------------------------------------------------------------------
-- Restbestand/Verfügbar-Formel identisch zum Datenmodell (initial_weight_g +
-- Σ filament_movements.amount_g; verfügbar = Restbestand − Σ aktive
-- filament_reservations.amount_g). Schwellenwert 100 g fest verdrahtet, da es
-- kein settings-Feld dafür gibt (im Datenmodell/RLS geprüft) — derselbe Wert,
-- der bereits im Frontend als Annahme dokumentiert ist (BUILD-LOG.md, "Phase
-- 2, Schritt 2 (Teil 1)"), hier nur übernommen statt neu erfunden.
create view v_dashboard_stock_low as
select
  fs.id                as spool_id,
  fs.filament_product_id,
  fp.manufacturer,
  fp.product_name,
  fp.material,
  col.name              as color_name,
  fs.initial_weight_g + coalesce(mov.amount_sum, 0)                            as rest_g,
  fs.initial_weight_g + coalesce(mov.amount_sum, 0) - coalesce(res.qty_sum, 0) as available_g
from filament_spools fs
join filament_products fp on fp.id = fs.filament_product_id
left join colors col on col.id = fp.color_id
left join lateral (
  select sum(m.amount_g) as amount_sum
  from filament_movements m
  where m.spool_id = fs.id
) mov on true
left join lateral (
  select sum(r.amount_g) as qty_sum
  from filament_reservations r
  where r.spool_id = fs.id
    and r.status = 'aktiv'
) res on true
where fs.active = true
  and (fs.initial_weight_g + coalesce(mov.amount_sum, 0) - coalesce(res.qty_sum, 0)) < 100;

grant select on v_dashboard_stock_low to authenticated;

-- ---------------------------------------------------------------------------
-- v_dashboard_production_running — laufende Produktionsaufträge + Fortschritt
-- ---------------------------------------------------------------------------
-- Fortschritt = Anzahl/Menge der Batch-Items mit bereits erfasstem
-- Ist-Verbrauch (qty_success is not null, siehe fn_complete_order_item)
-- gegenüber allen Batch-Items des Auftrags.
create view v_dashboard_production_running as
select
  po.id          as production_order_id,
  po.printer_id,
  pr.name        as printer_name,
  po.planned_start,
  po.actual_start,
  coalesce(batch.batch_items_total, 0)     as batch_items_total,
  coalesce(batch.batch_items_completed, 0) as batch_items_completed,
  coalesce(batch.qty_planned_total, 0)     as qty_planned_total,
  coalesce(batch.qty_success_total, 0)     as qty_success_total
from production_orders po
left join printers pr on pr.id = po.printer_id
left join lateral (
  select
    count(*)                                                as batch_items_total,
    count(*) filter (where pbi.qty_success is not null)     as batch_items_completed,
    sum(pbi.qty_planned)                                    as qty_planned_total,
    sum(pbi.qty_success)                                    as qty_success_total
  from production_batch_items pbi
  where pbi.production_order_id = po.id
) batch on true
where po.status = 'Laeuft';

grant select on v_dashboard_production_running to authenticated;

-- ===========================================================================
-- ABSCHNITT B: fn_place_order — Kunden-Dedup vor Neuanlage (specs/17 §4 Pkt. 5)
-- ===========================================================================
-- Bisher (00153): ohne explizit übergebene existing_customer_id wurde IMMER
-- ein neuer customers-Datensatz angelegt — Spec §4 Punkt 5 sieht aber vor,
-- dass die Verknüpfung mit einem bestehenden Kunden serverseitig anhand der
-- eingegebenen Telefon/E-Mail-Daten passiert (BUILD-LOG.md, "Phase 1,
-- Schritt 4" — dort als vermutete Backend-Lücke dokumentiert).
--
-- Korrektur: vor der Neuanlage wird jetzt nach einem bestehenden Kunden
-- gesucht, ODER-Logik über Telefon/E-Mail, exakt dieselbe Normalisierung wie
-- fn_customer_search (00141): Telefon getrimmt, E-Mail getrimmt+lowercase.
-- Bei mehreren Treffern (kein UNIQUE-Constraint auf phone/email, siehe
-- Datenmodell §4) wird deterministisch der zuletzt angelegte Kunde gewählt
-- (order by created_at desc limit 1) — rein technische Tie-Break-Entscheidung,
-- keine Geschäftsregel, da die Spec dafür keine Vorgabe macht.
--
-- Signatur und Rückgabetyp bleiben unverändert (jsonb {order_id,
-- tracking_token}), daher reines CREATE OR REPLACE ohne DROP.
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
        trim(p_customer->>'last_name'),
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

-- Grant unverändert (Checkout ohne Login, #21) — anon + authenticated.
revoke all on function fn_place_order(uuid, jsonb) from public;
grant execute on function fn_place_order(uuid, jsonb) to anon, authenticated;

-- ===========================================================================
-- ABSCHNITT C: fn_reject_offer — EXECUTE-Grant für anon (specs/18 §7)
-- ===========================================================================
-- Task-Vorgabe: nur den Grant ergänzen, Funktionssignatur/-verhalten NICHT
-- ändern (fn_reject_offer bleibt (p_offer_id uuid, p_rejection_reason text,
-- p_actor text), analog dem Vorgehen bei fn_accept_offer/
-- fn_get_offer_by_token, deren anon-Grant ebenfalls ohne Signaturänderung
-- gesetzt wurde). Admin-seitige Ablehnung im Postfach (fn_reject_offer dort
-- bereits mit authenticated-Grant genutzt) bleibt unverändert bestehen.
--
-- Hinweis (kein Teil dieser Migration, siehe Rückmeldung im Chat): Damit ein
-- anonymer Kunde diese Funktion über den Token-Link tatsächlich aufrufen
-- kann, braucht das Frontend eine Möglichkeit, das zugehörige offers.id aus
-- dem secure_token zu ermitteln — fn_get_offer_by_token (00149) liefert
-- aktuell keine id zurück. Das ist eine Frontend-/RPC-Erweiterung außerhalb
-- des Umfangs dieser Migration (nur Grant, keine Signaturänderung).
grant execute on function fn_reject_offer(uuid, text, text) to anon;
