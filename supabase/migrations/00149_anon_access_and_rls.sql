-- Migration 00149: anon-Zugriffsschicht & RLS-Policies
-- Siehe specs/implementierungsplan-schritt9.md §3 (RLS-Konzept) und §4
-- (Funktionsübersicht); specs/00-overview.md §1 (Prinzipien #6 Kunde sieht nie
-- interne Kosten, #7 interne Notizen nie öffentlich, #21 keine Kundenkonten
-- im MVP); specs/kunden-warenkorb-tracking.md §2/§3 (cart_sessions,
-- cart_items, order_tracking_tokens); specs/angebote-individuelle-anfragen.md
-- §2/§3 (offers, secure_token, revoked_at); specs/audit-settings.md §3
-- (interne Felder nur für Admins); specs/produkte-varianten-farben.md §3
-- (durchsuchbarer Katalog).
--
-- Genau zwei Rollen: anon (Storefront/Tracking/Angebotslink, kein Login, #21)
-- und der eine Admin über Supabase Auth (authenticated).
--
-- ===========================================================================
-- PHASE 1: Fehlende anon-Funktionen (SECURITY DEFINER)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_cart_get(p_session_token text) → jsonb
-- ---------------------------------------------------------------------------
-- Liefert die cart_items der Session samt Produkt-/Variantendaten und
-- configuration_draft (kunden-warenkorb-tracking.md §2).
--
-- Entscheidung (deine Wahl laut Task): weder ein unbekanntes noch ein
-- abgelaufenes Token führen zu einer Exception, sondern zu einem leeren
-- Ergebnis ({"cart_session_id": null, "items": []}). Begründung:
-- fn_place_order (00142) prüft cart_sessions.expires_at bewusst nicht ("wird
-- bewusst nicht geprüft") — Ablauf wird im gesamten Warenkorb-Fluss nirgends
-- hart durchgesetzt, expires_at dient nur dem technischen Aufräumen (§2
-- "dürfen technisch aufgeräumt werden").
--
-- Warum das NICHT im Widerspruch zu fn_cart_update_item steht (dort führt ein
-- Verstoß zur Exception): die beiden Funktionen prüfen etwas grundlegend
-- Verschiedenes. fn_cart_get bekommt nur EINE Identität (das Token) und liest
-- rein lesend, was dazu existiert — "nichts gefunden" ist dabei nicht von
-- "Warenkorb ist leer" unterscheidbar und für den Aufrufer folgenlos, es gibt
-- keine zweite Angabe, die dagegen geprüft werden müsste. fn_cart_update_item
-- bekommt dagegen ZWEI unabhängige Identitäten (Token UND cart_item_id) und
-- muss prüfen, ob sie zusammengehören, bevor geschrieben wird — ein Mismatch
-- ist dort kein harmloser Leerzustand, sondern der Versuch, eine fremde
-- Position zu verändern, und muss hart fehlschlagen. Ein leeres Ergebnis statt
-- Exception ist für den reinen Lesefall also die konsistente Wahl: ein
-- unbekanntes/abgelaufenes Token verhält sich wie ein neuer, noch leerer
-- Warenkorb, kein hartes Fehlschlagen im Storefront.
create or replace function fn_cart_get(p_session_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_items      jsonb;
begin
  if nullif(trim(p_session_token), '') is null then
    raise exception 'fn_cart_get: session_token darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select cs.id into v_session_id
  from cart_sessions cs
  where cs.session_token = p_session_token
    and cs.expires_at >= now()
  order by cs.created_at desc
  limit 1;

  if v_session_id is null then
    return jsonb_build_object('cart_session_id', null, 'items', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'cart_item_id',         ci.id,
             'qty',                  ci.qty,
             'configuration_draft',  ci.configuration_draft,
             'product', jsonb_build_object(
               'id',            p.id,
               'name',          p.name,
               'images',        p.images,
               'is_multicolor', p.is_multicolor
             ),
             'variant', jsonb_build_object(
               'id',         pv.id,
               'size_label', pv.size_label,
               'min_qty',    pv.min_qty,
               'max_qty',    pv.max_qty,
               'step_qty',   pv.step_qty
             )
           ) order by ci.created_at, ci.id
         ), '[]'::jsonb)
    into v_items
  from cart_items ci
  join products p        on p.id  = ci.product_id
  join product_variants pv on pv.id = ci.variant_id
  where ci.cart_session_id = v_session_id;

  return jsonb_build_object('cart_session_id', v_session_id, 'items', v_items);
end;
$$;

revoke all on function fn_cart_get(text) from public;
grant execute on function fn_cart_get(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- fn_cart_add_item(p_session_token, p_product_id, p_variant_id,
--   p_configuration_draft, p_qty) → uuid (cart_items.id)
-- ---------------------------------------------------------------------------
-- Session existiert nicht → neue cart_sessions-Zeile anlegen, Token wie
-- übergeben verwenden. Mengenregeln aus product_variants (min_qty/max_qty/
-- step_qty) werden geprüft. Keine Bestandsprüfung, keine Reservierung (#14).
--
-- Zusätzlich (Ergänzung nach Rückfrage): variant_id muss zu product_id
-- gehören, sonst Exception — ein manipulierter/inkonsistenter Request soll
-- schon beim Hinzufügen zum Warenkorb auffallen, nicht erst beim Checkout in
-- fn_place_order (00142), das dieselbe Prüfung ohnehin zusätzlich nochmal
-- vornimmt (dortige Prüfung bleibt unverändert, da fn_place_order auch
-- Warenkörbe akzeptieren muss, die vor dieser Migration entstanden sind).
--
-- TTL neuer Sessions: 7 Tage (Nutzer-Entscheidung, da in keiner Spec
-- definiert) — nicht hart durchgesetzt (siehe fn_cart_get oben), nur für
-- künftiges technisches Aufräumen.
--
-- Race-Schutz "existiert nicht -> anlegen" per Advisory Lock je Token, analog
-- fn_create_variant_configuration_if_missing (00141): verhindert doppelte
-- cart_sessions-Zeilen bei zwei gleichzeitigen ersten Aufrufen mit demselben
-- neuen Token.
create or replace function fn_cart_add_item(
  p_session_token       text,
  p_product_id          uuid,
  p_variant_id          uuid,
  p_configuration_draft jsonb,
  p_qty                 int
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id      uuid;
  v_variant_product uuid;
  v_min_qty         int;
  v_max_qty         int;
  v_step_qty        int;
  v_size_label      text;
  v_item_id         uuid;
begin
  if nullif(trim(p_session_token), '') is null then
    raise exception 'fn_cart_add_item: session_token darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_product_id is null then
    raise exception 'fn_cart_add_item: product_id darf nicht NULL sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_variant_id is null then
    raise exception 'fn_cart_add_item: variant_id darf nicht NULL sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select pv.product_id, pv.min_qty, pv.max_qty, pv.step_qty, pv.size_label
    into v_variant_product, v_min_qty, v_max_qty, v_step_qty, v_size_label
  from product_variants pv
  where pv.id = p_variant_id;

  if not found then
    raise exception 'fn_cart_add_item: Variante % existiert nicht', p_variant_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_variant_product <> p_product_id then
    raise exception 'fn_cart_add_item: Variante % gehört nicht zu Produkt %, sondern zu %',
      p_variant_id, p_product_id, v_variant_product
      using errcode = 'invalid_parameter_value';
  end if;

  if p_qty is null
     or p_qty < v_min_qty
     or p_qty > v_max_qty
     or (p_qty - v_min_qty) % v_step_qty <> 0 then
    raise exception 'fn_cart_add_item: Menge % für Variante "%" ungültig (erlaubt: % bis %, Schrittweite %)',
      p_qty, v_size_label, v_min_qty, v_max_qty, v_step_qty
      using errcode = 'check_violation';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('fn_cart_add_item.session'),
    hashtext(p_session_token)
  );

  select cs.id into v_session_id
  from cart_sessions cs
  where cs.session_token = p_session_token
  order by cs.created_at desc
  limit 1;

  if v_session_id is null then
    insert into cart_sessions (session_token, expires_at)
    values (p_session_token, now() + interval '7 days')
    returning id into v_session_id;
  end if;

  insert into cart_items (cart_session_id, product_id, variant_id, configuration_draft, qty)
  values (v_session_id, p_product_id, p_variant_id, p_configuration_draft, p_qty)
  returning id into v_item_id;

  return v_item_id;
end;
$$;

revoke all on function fn_cart_add_item(text, uuid, uuid, jsonb, int) from public;
grant execute on function fn_cart_add_item(text, uuid, uuid, jsonb, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- fn_cart_update_item(p_session_token, p_cart_item_id, p_qty) → void
-- ---------------------------------------------------------------------------
-- qty = 0 → Zeile löschen (Warenkorb ist die bewusste Ausnahme von
-- "nie löschen", kunden-warenkorb-tracking.md §2). Prüft, dass das cart_item
-- tatsächlich zur Session mit diesem Token gehört — sowohl ein unbekanntes
-- cart_item als auch eines einer fremden Session lösen dieselbe Exception
-- aus (kein Rückschluss, welcher Fall vorliegt).
create or replace function fn_cart_update_item(
  p_session_token text,
  p_cart_item_id  uuid,
  p_qty           int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_token text;
begin
  if nullif(trim(p_session_token), '') is null then
    raise exception 'fn_cart_update_item: session_token darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_cart_item_id is null then
    raise exception 'fn_cart_update_item: cart_item_id darf nicht NULL sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_qty is null or p_qty < 0 then
    raise exception 'fn_cart_update_item: qty muss >= 0 sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select cs.session_token into v_owner_token
  from cart_items ci
  join cart_sessions cs on cs.id = ci.cart_session_id
  where ci.id = p_cart_item_id;

  if v_owner_token is null or v_owner_token <> p_session_token then
    raise exception 'fn_cart_update_item: Warenkorbposition % gehört nicht zu dieser Session', p_cart_item_id
      using errcode = 'invalid_parameter_value';
  end if;

  if p_qty = 0 then
    delete from cart_items where id = p_cart_item_id;
  else
    update cart_items
    set qty = p_qty, updated_at = now()
    where id = p_cart_item_id;
  end if;
end;
$$;

revoke all on function fn_cart_update_item(text, uuid, int) from public;
grant execute on function fn_cart_update_item(text, uuid, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- fn_get_order_by_token(p_token text) → jsonb
-- ---------------------------------------------------------------------------
-- Lookup über order_tracking_tokens (kunden-warenkorb-tracking.md §2/§3):
-- Token muss existieren, expires_at > now(), revoked_at IS NULL — sonst
-- Exception, dieselbe unspezifische Fehlermeldung in allen drei Fällen (kein
-- Rückschluss, ob ein Token existiert).
--
-- Liefert ausschließlich kundensichere Felder: order_number, orders.status,
-- Positionen mit Bezeichnung (Produktname+Variante+Farbe bzw.
-- desired_description im Ausnahmepfad), qty, Positionsstatus, final_price je
-- Position (aus der an der Position fixierten calculation_versions-Zeile,
-- #9), und die Zeitstempel confirmed_at/finished_at/ready_for_pickup_at/
-- handed_over_at. NIEMALS internal_note, handed_over_by, handover_note oder
-- irgendein Kostenfeld aus calculation_versions (#6/#7) — hier bewusst nicht
-- selektiert.
create or replace function fn_get_order_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_order    jsonb;
  v_items    jsonb;
begin
  if nullif(trim(p_token), '') is null then
    raise exception 'Tracking-Token ungültig oder abgelaufen'
      using errcode = 'invalid_parameter_value';
  end if;

  select ott.order_id into v_order_id
  from order_tracking_tokens ott
  where ott.token = p_token
    and ott.expires_at > now()
    and ott.revoked_at is null;

  if v_order_id is null then
    raise exception 'Tracking-Token ungültig oder abgelaufen'
      using errcode = 'invalid_parameter_value';
  end if;

  select jsonb_build_object(
           'order_number',        o.order_number,
           'status',              o.status,
           'confirmed_at',        o.confirmed_at,
           'finished_at',         o.finished_at,
           'ready_for_pickup_at', o.ready_for_pickup_at,
           'handed_over_at',      o.handed_over_at
         )
    into v_order
  from orders o
  where o.id = v_order_id;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'description', coalesce(
               oi.desired_description,
               p.name || ' - ' || pv.size_label ||
                 case when desc_agg.summary is not null
                      then ' (' || desc_agg.summary || ')'
                      else ''
                 end
             ),
             'qty',         oi.qty,
             'status',      oi.status,
             'final_price', cv.final_price
           ) order by oi.created_at, oi.id
         ), '[]'::jsonb)
    into v_items
  from order_items oi
  join calculation_versions cv on cv.id = oi.calculation_version_id
  left join products p         on p.id  = oi.product_id
  left join product_variants pv on pv.id = oi.variant_id
  left join lateral (
    select string_agg(
             case when vcc.product_part_id is null
                  then col.name || '/' || fin.name
                  else pp.name || ': ' || col.name || '/' || fin.name
             end,
             ', ' order by pp.sort_order nulls first, col.name
           ) as summary
    from variant_configuration_colors vcc
    left join product_parts pp on pp.id = vcc.product_part_id
    join colors col   on col.id = vcc.color_id
    join finishes fin on fin.id = vcc.finish_id
    where vcc.variant_configuration_id = oi.variant_configuration_id
  ) desc_agg on true
  where oi.order_id = v_order_id;

  return v_order || jsonb_build_object('items', v_items);
end;
$$;

revoke all on function fn_get_order_by_token(text) from public;
grant execute on function fn_get_order_by_token(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- fn_get_offer_by_token(p_secure_token text) → jsonb
-- ---------------------------------------------------------------------------
-- Prüft status = 'offen', revoked_at IS NULL, now() zwischen valid_from und
-- valid_until (angebote-individuelle-anfragen.md §3/§4) — bei Verstoß (auch
-- bei unbekanntem Token) dieselbe unspezifische Fehlermeldung in allen
-- Fällen.
--
-- Liefert die offer_items mit desired_variant_description, qty und
-- final_price aus der verknüpften calculation_versions-Zeile. Keine
-- Kostenkomponenten, keine margin_percent, kein min_price (#6/#7) — hier
-- bewusst nicht selektiert.
create or replace function fn_get_offer_by_token(p_secure_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer offers%rowtype;
  v_now   timestamptz := now();
  v_items jsonb;
begin
  if nullif(trim(p_secure_token), '') is null then
    raise exception 'Angebotslink ungültig oder nicht mehr verfügbar'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_offer
  from offers
  where secure_token = p_secure_token;

  if not found
     or v_offer.status <> 'offen'
     or v_offer.revoked_at is not null
     or v_now < v_offer.valid_from
     or v_now > v_offer.valid_until then
    raise exception 'Angebotslink ungültig oder nicht mehr verfügbar'
      using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'desired_variant_description', oi.desired_variant_description,
             'qty',                         oi.qty,
             'final_price',                 cv.final_price
           ) order by oi.created_at, oi.id
         ), '[]'::jsonb)
    into v_items
  from offer_items oi
  join calculation_versions cv on cv.id = oi.calculation_version_id
  where oi.offer_id = v_offer.id;

  return jsonb_build_object(
    'valid_from',  v_offer.valid_from,
    'valid_until', v_offer.valid_until,
    'items',       v_items
  );
end;
$$;

revoke all on function fn_get_offer_by_token(text) from public;
grant execute on function fn_get_offer_by_token(text) to anon, authenticated;

-- ===========================================================================
-- PHASE 2: Policies für anon (reines Kataloglesen)
-- ===========================================================================
-- Grundsatz (implementierungsplan-schritt9.md §3): anon bekommt NUR lesenden
-- Zugriff auf den Katalog. Alles andere läuft ausschließlich über die
-- SECURITY-DEFINER-Funktionen aus Phase 1 und die bestehenden anon-Funktionen
-- (fn_customer_search, fn_place_order, fn_submit_custom_request,
-- fn_accept_offer) — keine Policy auf einer Tabelle, die nur für einen
-- Funktionsaufruf nötig wäre, da SECURITY DEFINER RLS ohnehin umgeht.
--
-- Vorab-Prüfung (Task-Vorgabe): Greift eine der vier bestehenden
-- anon-Funktionen auf eine Tabelle zu, für die anon hier keine Policy
-- bekommt? Ja (u. a. cart_sessions, cart_items, customers, orders,
-- order_items, calculation_versions, custom_requests, custom_request_colors,
-- offers, offer_items) — alle vier (fn_customer_search 00141, fn_place_order
-- 00142, fn_submit_custom_request 00146, fn_accept_offer 00147) sind
-- `security definer`, RLS greift für ihre internen Zugriffe also nicht.
-- Kein SECURITY INVOKER gefunden — kein STOPP nötig.
--
-- Tabellen ohne eigenes active/is_active-Flag (product_parts, variant_parts,
-- variant_configurations, variant_configuration_colors, bundle_items)
-- bekommen eine ungefilterte SELECT-Policy — die Sichtbarkeitssteuerung
-- läuft dort ausschließlich über die active-Flags der jeweils übergeordneten
-- Tabelle (products/product_variants/product_bundles), analog zur
-- Katalog-Struktur aus produkte-varianten-farben.md §2.

-- specs/produkte-varianten-farben.md §2/§3
create policy anon_select_products on products
  for select to anon
  using (active = true);

create policy anon_select_product_variants on product_variants
  for select to anon
  using (active = true);

create policy anon_select_product_parts on product_parts
  for select to anon
  using (true);

create policy anon_select_variant_parts on variant_parts
  for select to anon
  using (true);

create policy anon_select_colors on colors
  for select to anon
  using (active = true);

create policy anon_select_finishes on finishes
  for select to anon
  using (active = true);

create policy anon_select_product_color_finish_options on product_color_finish_options
  for select to anon
  using (active = true);

create policy anon_select_variant_configurations on variant_configurations
  for select to anon
  using (true);

create policy anon_select_variant_configuration_colors on variant_configuration_colors
  for select to anon
  using (true);

create policy anon_select_product_bundles on product_bundles
  for select to anon
  using (active = true);

create policy anon_select_bundle_items on bundle_items
  for select to anon
  using (true);

-- RLS-Policies allein reichen nicht: Postgres prüft für jeden Befehl zuerst
-- die Tabellen-Grants (GRANT SELECT/INSERT/...) und erst danach die
-- RLS-Policy — ohne Grant kommt "permission denied for table ...", bevor
-- RLS überhaupt ausgewertet wird. In diesem Projekt haben anon/authenticated
-- bislang nur die generischen REFERENCES/TRIGGER/TRUNCATE-Rechte auf
-- public-Tabellen (per information_schema.table_privileges geprüft), aber
-- kein SELECT/INSERT/UPDATE/DELETE auf irgendeiner Tabelle. Die folgenden
-- GRANTs sind daher notwendig, damit "anon SELECT erlauben auf ..." aus dem
-- Task technisch überhaupt wirkt — kein zusätzlicher Business-Entscheid,
-- nur die technische Ergänzung zu den oben bereits festgelegten Policies.
grant select on
  products, product_variants, product_parts, variant_parts,
  colors, finishes, product_color_finish_options,
  variant_configurations, variant_configuration_colors,
  product_bundles, bundle_items
to anon;

-- Alle übrigen Tabellen (orders, order_items, order_bundle_groups, customers,
-- cart_sessions, cart_items, order_tracking_tokens, offers, offer_items,
-- custom_requests, custom_request_colors, calculation_versions, alle
-- filament_*, alle finished_goods_*, production_*, printers, complaints,
-- licenses, license_*, creators, admins, settings, audit_log) bekommen
-- bewusst KEINE anon-Policy — RLS ist dort bereits seit Ebene 1-13 aktiviert
-- (implementierungsplan-schritt9.md §1), ohne Policy also Deny-All für anon.

-- ===========================================================================
-- PHASE 3: Policies für authenticated (Admin)
-- ===========================================================================
-- Der Admin ist der einzige eingeloggte Nutzer (#17, "ein Betreiber = eine
-- Instanz", 00-overview.md §1) und braucht vollen Lese-/Schreibzugriff auf
-- alle Tabellen — mit genau drei Ausnahmegruppen (Task-Vorgabe):
--
--   1. audit_log: SELECT und INSERT, aber kein UPDATE/DELETE — append-only,
--      ausnahmslos (audit-settings.md §2).
--   2. Keine DELETE-Policy auf Geschäftsdaten-Tabellen (#1/#2: gelöscht wird
--      nicht, deaktiviert oder storniert wird) — orders, order_items, alle
--      *_movements, alle *_reservations, calculation_versions, offers,
--      offer_items, custom_requests, production_* bekommen nur SELECT/
--      INSERT/UPDATE. cart_sessions und cart_items sind die bewusste
--      Ausnahme (kunden-warenkorb-tracking.md §2) und behalten volles CRUD.
--      Alle sonstigen, hier nicht ausdrücklich genannten Tabellen (u. a.
--      order_bundle_groups, custom_request_colors, license_*,
--      complaints, ...) sind keine im Task genannten Geschäftsdaten-
--      Tabellen im obigen Sinn und behalten daher volles CRUD.
--   3. settings: SELECT und UPDATE, aber kein INSERT/DELETE — genau eine
--      Zeile, ein Betreiber pro Instanz (audit-settings.md §2).
--
-- Views aus Migration 00150 existieren hier noch nicht — keine Policies/
-- Grants darauf vorbereiten.
--
-- "for all" deckt select/insert/update/delete in einer Policy ab; für die
-- Ausnahmegruppen werden stattdessen die jeweils erlaubten Befehle einzeln
-- als eigene Policy angelegt (Postgres erlaubt pro Policy nur einen Befehl
-- außer bei "all").

-- ---------------------------------------------------------------------------
-- Volles CRUD für authenticated
-- ---------------------------------------------------------------------------
create policy admin_all_colors on colors
  for all to authenticated using (true) with check (true);
create policy admin_all_finishes on finishes
  for all to authenticated using (true) with check (true);
create policy admin_all_creators on creators
  for all to authenticated using (true) with check (true);
create policy admin_all_admins on admins
  for all to authenticated using (true) with check (true);
create policy admin_all_printers on printers
  for all to authenticated using (true) with check (true);
create policy admin_all_customers on customers
  for all to authenticated using (true) with check (true);
create policy admin_all_products on products
  for all to authenticated using (true) with check (true);
create policy admin_all_filament_products on filament_products
  for all to authenticated using (true) with check (true);
create policy admin_all_licenses on licenses
  for all to authenticated using (true) with check (true);
create policy admin_all_product_parts on product_parts
  for all to authenticated using (true) with check (true);
create policy admin_all_product_variants on product_variants
  for all to authenticated using (true) with check (true);
create policy admin_all_product_color_finish_options on product_color_finish_options
  for all to authenticated using (true) with check (true);
create policy admin_all_filament_spools on filament_spools
  for all to authenticated using (true) with check (true);
create policy admin_all_license_product_links on license_product_links
  for all to authenticated using (true) with check (true);
create policy admin_all_license_cost_models on license_cost_models
  for all to authenticated using (true) with check (true);
create policy admin_all_variant_parts on variant_parts
  for all to authenticated using (true) with check (true);
create policy admin_all_variant_configurations on variant_configurations
  for all to authenticated using (true) with check (true);
create policy admin_all_product_bundles on product_bundles
  for all to authenticated using (true) with check (true);
create policy admin_all_custom_request_colors on custom_request_colors
  for all to authenticated using (true) with check (true);
create policy admin_all_variant_configuration_colors on variant_configuration_colors
  for all to authenticated using (true) with check (true);
create policy admin_all_bundle_items on bundle_items
  for all to authenticated using (true) with check (true);
create policy admin_all_order_bundle_groups on order_bundle_groups
  for all to authenticated using (true) with check (true);
-- cart_sessions/cart_items: bewusste Ausnahme von "nie löschen" (§2) — volles CRUD.
create policy admin_all_cart_sessions on cart_sessions
  for all to authenticated using (true) with check (true);
create policy admin_all_cart_items on cart_items
  for all to authenticated using (true) with check (true);
create policy admin_all_order_tracking_tokens on order_tracking_tokens
  for all to authenticated using (true) with check (true);
create policy admin_all_complaints on complaints
  for all to authenticated using (true) with check (true);
create policy admin_all_license_recurring_charges on license_recurring_charges
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Geschäftsdaten: SELECT/INSERT/UPDATE, aber kein DELETE (#1/#2)
-- ---------------------------------------------------------------------------
create policy admin_select_custom_requests on custom_requests for select to authenticated using (true);
create policy admin_insert_custom_requests on custom_requests for insert to authenticated with check (true);
create policy admin_update_custom_requests on custom_requests for update to authenticated using (true) with check (true);

create policy admin_select_offers on offers for select to authenticated using (true);
create policy admin_insert_offers on offers for insert to authenticated with check (true);
create policy admin_update_offers on offers for update to authenticated using (true) with check (true);

create policy admin_select_offer_items on offer_items for select to authenticated using (true);
create policy admin_insert_offer_items on offer_items for insert to authenticated with check (true);
create policy admin_update_offer_items on offer_items for update to authenticated using (true) with check (true);

create policy admin_select_calculation_versions on calculation_versions for select to authenticated using (true);
create policy admin_insert_calculation_versions on calculation_versions for insert to authenticated with check (true);
create policy admin_update_calculation_versions on calculation_versions for update to authenticated using (true) with check (true);

create policy admin_select_orders on orders for select to authenticated using (true);
create policy admin_insert_orders on orders for insert to authenticated with check (true);
create policy admin_update_orders on orders for update to authenticated using (true) with check (true);

create policy admin_select_order_items on order_items for select to authenticated using (true);
create policy admin_insert_order_items on order_items for insert to authenticated with check (true);
create policy admin_update_order_items on order_items for update to authenticated using (true) with check (true);

create policy admin_select_filament_movements on filament_movements for select to authenticated using (true);
create policy admin_insert_filament_movements on filament_movements for insert to authenticated with check (true);
create policy admin_update_filament_movements on filament_movements for update to authenticated using (true) with check (true);

create policy admin_select_finished_goods_movements on finished_goods_movements for select to authenticated using (true);
create policy admin_insert_finished_goods_movements on finished_goods_movements for insert to authenticated with check (true);
create policy admin_update_finished_goods_movements on finished_goods_movements for update to authenticated using (true) with check (true);

create policy admin_select_finished_goods_reservations on finished_goods_reservations for select to authenticated using (true);
create policy admin_insert_finished_goods_reservations on finished_goods_reservations for insert to authenticated with check (true);
create policy admin_update_finished_goods_reservations on finished_goods_reservations for update to authenticated using (true) with check (true);

create policy admin_select_filament_reservations on filament_reservations for select to authenticated using (true);
create policy admin_insert_filament_reservations on filament_reservations for insert to authenticated with check (true);
create policy admin_update_filament_reservations on filament_reservations for update to authenticated using (true) with check (true);

create policy admin_select_production_orders on production_orders for select to authenticated using (true);
create policy admin_insert_production_orders on production_orders for insert to authenticated with check (true);
create policy admin_update_production_orders on production_orders for update to authenticated using (true) with check (true);

create policy admin_select_production_batch_items on production_batch_items for select to authenticated using (true);
create policy admin_insert_production_batch_items on production_batch_items for insert to authenticated with check (true);
create policy admin_update_production_batch_items on production_batch_items for update to authenticated using (true) with check (true);

create policy admin_select_production_material_usage on production_material_usage for select to authenticated using (true);
create policy admin_insert_production_material_usage on production_material_usage for insert to authenticated with check (true);
create policy admin_update_production_material_usage on production_material_usage for update to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- settings: SELECT/UPDATE, kein INSERT/DELETE (genau eine Zeile, #Betreiber)
-- ---------------------------------------------------------------------------
create policy admin_select_settings on settings for select to authenticated using (true);
create policy admin_update_settings on settings for update to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- audit_log: SELECT/INSERT, kein UPDATE/DELETE (append-only, ausnahmslos)
-- ---------------------------------------------------------------------------
create policy admin_select_audit_log on audit_log for select to authenticated using (true);
create policy admin_insert_audit_log on audit_log for insert to authenticated with check (true);

-- ---------------------------------------------------------------------------
-- Tabellen-Grants für authenticated (aus demselben Grund wie bei anon oben,
-- s. Phase 2: RLS-Policies allein reichen ohne die passenden GRANTs nicht)
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
  colors, finishes, creators, admins, printers, customers,
  products, filament_products, licenses,
  product_parts, product_variants, product_color_finish_options,
  filament_spools, license_product_links, license_cost_models,
  variant_parts, variant_configurations, product_bundles, custom_request_colors,
  variant_configuration_colors, bundle_items, order_bundle_groups,
  cart_sessions, cart_items, order_tracking_tokens,
  complaints, license_recurring_charges
to authenticated;

grant select, insert, update on
  custom_requests, offers, offer_items, calculation_versions,
  orders, order_items,
  filament_movements, finished_goods_movements, finished_goods_reservations, filament_reservations,
  production_orders, production_batch_items, production_material_usage
to authenticated;

grant select, update on settings to authenticated;
grant select, insert on audit_log to authenticated;
