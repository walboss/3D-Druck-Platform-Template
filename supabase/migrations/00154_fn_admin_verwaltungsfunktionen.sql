-- Migration 00154: Admin-Verwaltungsfunktionen (Befund 6 der Abschlussprüfung)
-- Siehe specs/produktion.md §2 (production_orders, complaints), §4
-- (Statusübergänge), specs/lizenzen.md §2, §4 (licenses.status),
-- specs/angebote-individuelle-anfragen.md §4 (custom_requests, offers
-- Statusübergänge), specs/audit-settings.md §3 (#31: jeder Statuswechsel mit
-- audit_log-Eintrag — hier über fn_write_audit aus 00145).
--
-- 00153 hatte Befund 6 ausdrücklich ausgeklammert ("NICHT Teil dieser
-- Migration"): fehlende auslösende Funktionen für mehrere in den Specs
-- beschriebene Statusübergänge. Dies ist der letzte fachliche
-- Backend-Baustein (Task-Vorgabe).
--
-- Alle Funktionen SECURITY DEFINER, Grant nur authenticated (reine
-- Admin-Aktionen, kein anon-Zugriff). p_actor kommt als expliziter Parameter
-- (Muster aus 00146/00153, nicht auth.uid()-Fallback wie in 00143/00144).
--
-- Nicht enthalten (Task-Vorgabe):
--   - Keine Funktion für custom_requests.status = 'geprueft' (bewusst
--     ungenutzt im MVP).
--   - Keine Änderung an bestehenden Funktionen aus 00141-00153.
--   - Keine automatische/zeitgesteuerte Lizenzprüfung.
--   - Keine RLS-Policies.
--
-- Bericht zu fn_fail_production_order (Task-Rückfrage): Was passiert mit noch
-- aktiven filament_reservations der zugeordneten Positionen beim Übergang
-- Laeuft → Fehlgeschlagen? produktion.md §4/§5 äußert sich dazu nicht explizit
-- (nur "kein Zurück von Abgeschlossen/Fehlgeschlagen"). Die Erwartung aus dem
-- Task — Reservierungen bleiben unangetastet, da das Material real verbraucht
-- wurde und der Admin den Verbrauch weiterhin über fn_complete_order_item je
-- production_batch_item bucht (unabhängig vom production_orders.status) —
-- deckt sich mit dem Rest der Spec: fn_complete_order_item verlangt nur
-- production_orders.status = 'Laeuft' beim Buchen einer einzelnen Position,
-- nicht beim gesamten Auftrag, und filament_reservations.status kennt kein
-- "fehlgeschlagen" (nur aktiv/freigegeben/verbraucht). Ein automatisches
-- Freigeben würde reale, bereits verbrauchte Materialbuchungen fachlich falsch
-- als "wieder verfügbar" darstellen. Umgesetzt wie erwartet: fn_fail_
-- production_order fasst filament_reservations nicht an.
--
-- actual_end auf production_orders (Spalte existiert seit 0010, in keiner
-- bisherigen Funktion gesetzt): wird hier bei BEIDEN Terminalübergängen
-- (Abgeschlossen und Fehlgeschlagen) gesetzt — rein mechanische Befüllung
-- eines bestehenden Zeitstempelfelds analog zu actual_start (00143) und den
-- übrigen Terminal-Zeitstempeln im Projekt (finished_at, handed_over_at,
-- ready_for_pickup_at, resolved_at), keine eigene Geschäftsentscheidung.

-- ===========================================================================
-- PRODUKTION
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_create_production_order(p_printer_id, p_planned_start, p_actor) → uuid
-- ---------------------------------------------------------------------------
-- Legt einen production_order mit status='Geplant' an (produktion.md §2).
-- printer_id ist FK nullable — ohne Drucker erlaubt. Ist er gesetzt, muss er
-- existieren und active=true sein, sonst Exception.
create or replace function fn_create_production_order(
  p_printer_id    uuid,
  p_planned_start timestamptz,
  p_actor         text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_printer_active boolean;
  v_id             uuid;
begin
  if p_planned_start is null then
    raise exception 'fn_create_production_order: planned_start darf nicht NULL sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_create_production_order: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_printer_id is not null then
    select p.active into v_printer_active
    from printers p
    where p.id = p_printer_id;

    if not found then
      raise exception 'fn_create_production_order: Drucker % existiert nicht', p_printer_id
        using errcode = 'invalid_parameter_value';
    end if;

    if not v_printer_active then
      raise exception 'fn_create_production_order: Drucker % ist deaktiviert', p_printer_id
        using errcode = 'check_violation';
    end if;
  end if;

  insert into production_orders (printer_id, status, planned_start)
  values (p_printer_id, 'Geplant', p_planned_start)
  returning id into v_id;

  perform fn_write_audit('production_order', v_id, 'status_change', 'status',
                         null, 'Geplant', null, p_actor);

  return v_id;
end;
$$;

revoke all on function fn_create_production_order(uuid, timestamptz, text) from public;
revoke all on function fn_create_production_order(uuid, timestamptz, text) from anon;
grant execute on function fn_create_production_order(uuid, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_complete_production_order(p_production_order_id, p_actor) → jsonb
-- ---------------------------------------------------------------------------
-- Laeuft → Abgeschlossen, nur aus 'Laeuft' erlaubt (produktion.md §4). Der
-- Admin entscheidet manuell, wann abgeschlossen wird, auch bei Teilausfall —
-- KEIN Auto-Abschluss, KEINE Prüfung, ob alle Positionen fertig sind. Die
-- Funktion verweigert den Abschluss also nicht, wenn noch batch_items ohne
-- qty_success existieren. Rückgabe: Übersicht, wie viele batch_items mit
-- welchem Ergebnis im Auftrag lagen (informativ fürs Frontend).
create or replace function fn_complete_production_order(
  p_production_order_id uuid,
  p_actor                text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function fn_complete_production_order(uuid, text) from public;
revoke all on function fn_complete_production_order(uuid, text) from anon;
grant execute on function fn_complete_production_order(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_fail_production_order(p_production_order_id, p_reason, p_actor) → void
-- ---------------------------------------------------------------------------
-- Laeuft → Fehlgeschlagen, nur aus 'Laeuft' erlaubt. p_reason Pflicht.
-- filament_reservations der zugeordneten Positionen bleiben unangetastet
-- (siehe Bericht am Kopf dieser Migration) — Materialverbrauch wird
-- unverändert je production_batch_item über fn_complete_order_item gebucht.
create or replace function fn_fail_production_order(
  p_production_order_id uuid,
  p_reason               text,
  p_actor                text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status production_order_status;
  v_reason text := nullif(trim(p_reason), '');
  v_now    timestamptz := now();
begin
  if v_reason is null then
    raise exception 'fn_fail_production_order: reason ist Pflicht'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_fail_production_order: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select po.status into v_status
  from production_orders po
  where po.id = p_production_order_id
  for update;

  if not found then
    raise exception 'fn_fail_production_order: Produktionsauftrag % existiert nicht', p_production_order_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_status <> 'Laeuft' then
    raise exception 'fn_fail_production_order: Produktionsauftrag % hat Status % — nur aus ''Laeuft'' möglich',
      p_production_order_id, v_status
      using errcode = 'check_violation';
  end if;

  update production_orders
  set status     = 'Fehlgeschlagen',
      actual_end = v_now,
      updated_at = v_now
  where id = p_production_order_id;

  perform fn_write_audit('production_order', p_production_order_id, 'status_change', 'status',
                         'Laeuft', 'Fehlgeschlagen', v_reason, p_actor);
end;
$$;

revoke all on function fn_fail_production_order(uuid, text, text) from public;
revoke all on function fn_fail_production_order(uuid, text, text) from anon;
grant execute on function fn_fail_production_order(uuid, text, text) to authenticated;

-- ===========================================================================
-- REKLAMATIONEN
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_report_complaint(p_order_item_id, p_reason, p_actor) → uuid
-- ---------------------------------------------------------------------------
-- Legt eine complaints-Zeile an (reported_at = now(), decision/resolved_at
-- NULL). p_reason Pflicht. Nur für order_items zulässig, deren Bestellung
-- bereits HandedOver ist — eine Reklamation vor Übergabe ist fachlich ein
-- Storno, kein Reklamationsfall.
create or replace function fn_report_complaint(
  p_order_item_id uuid,
  p_reason         text,
  p_actor          text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason      text := nullif(trim(p_reason), '');
  v_order_id    uuid;
  v_order_status order_status;
  v_now         timestamptz := now();
  v_id          uuid;
begin
  if v_reason is null then
    raise exception 'fn_report_complaint: reason ist Pflicht'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_report_complaint: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select oi.order_id into v_order_id
  from order_items oi
  where oi.id = p_order_item_id;

  if not found then
    raise exception 'fn_report_complaint: Bestellposition % existiert nicht', p_order_item_id
      using errcode = 'invalid_parameter_value';
  end if;

  select o.status into v_order_status
  from orders o
  where o.id = v_order_id
  for update;

  if v_order_status <> 'HandedOver' then
    raise exception 'fn_report_complaint: Bestellung % (Position %) hat Status % — eine Reklamation ist erst nach ''HandedOver'' möglich, vorher ist es ein Storno',
      v_order_id, p_order_item_id, v_order_status
      using errcode = 'check_violation';
  end if;

  insert into complaints (order_item_id, reported_at, reason)
  values (p_order_item_id, v_now, v_reason)
  returning id into v_id;

  perform fn_write_audit('complaint', v_id, 'create', 'reported_at',
                         null, v_now::text, v_reason, p_actor);

  return v_id;
end;
$$;

revoke all on function fn_report_complaint(uuid, text, text) from public;
revoke all on function fn_report_complaint(uuid, text, text) from anon;
grant execute on function fn_report_complaint(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_resolve_complaint(p_complaint_id, p_decision, p_decision_note, p_cost,
--   p_replacement_batch_item_id, p_actor) → void
-- ---------------------------------------------------------------------------
-- Setzt decision, decision_note, cost, resolved_at = now(), optional
-- replacement_production_batch_item_id. Nur auf einer noch offenen
-- Reklamation (resolved_at IS NULL). Bei decision='ersatzproduktion' muss
-- replacement_batch_item_id gesetzt sein, sonst Exception; bei den anderen
-- Entscheidungen muss es NULL sein. Die Ersatzproduktion selbst wird NICHT
-- hier ausgelöst — der Admin legt sie regulär über die bestehenden
-- Produktionsfunktionen an und verweist hier nur darauf.
create or replace function fn_resolve_complaint(
  p_complaint_id               uuid,
  p_decision                    complaint_decision,
  p_decision_note                text,
  p_cost                         numeric,
  p_replacement_batch_item_id  uuid,
  p_actor                        text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_complaint complaints%rowtype;
  v_now       timestamptz := now();
begin
  if p_decision is null then
    raise exception 'fn_resolve_complaint: decision ist Pflicht'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_resolve_complaint: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_decision = 'ersatzproduktion' and p_replacement_batch_item_id is null then
    raise exception 'fn_resolve_complaint: decision ''ersatzproduktion'' erfordert replacement_batch_item_id'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_decision <> 'ersatzproduktion' and p_replacement_batch_item_id is not null then
    raise exception 'fn_resolve_complaint: replacement_batch_item_id ist nur bei decision ''ersatzproduktion'' erlaubt'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_replacement_batch_item_id is not null
     and not exists (select 1 from production_batch_items b where b.id = p_replacement_batch_item_id) then
    raise exception 'fn_resolve_complaint: production_batch_item % (Ersatzproduktion) existiert nicht', p_replacement_batch_item_id
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_complaint
  from complaints
  where id = p_complaint_id
  for update;

  if not found then
    raise exception 'fn_resolve_complaint: Reklamation % existiert nicht', p_complaint_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_complaint.resolved_at is not null then
    raise exception 'fn_resolve_complaint: Reklamation % ist bereits gelöst (%)', p_complaint_id, v_complaint.resolved_at
      using errcode = 'check_violation';
  end if;

  update complaints
  set decision                              = p_decision,
      decision_note                          = nullif(trim(p_decision_note), ''),
      cost                                    = p_cost,
      resolved_at                             = v_now,
      replacement_production_batch_item_id  = p_replacement_batch_item_id,
      updated_at                              = v_now
  where id = p_complaint_id;

  perform fn_write_audit('complaint', p_complaint_id, 'update', 'decision',
                         null, p_decision::text, null, p_actor);
  perform fn_write_audit('complaint', p_complaint_id, 'status_change', 'resolved_at',
                         null, v_now::text, null, p_actor);

  if p_cost is not null then
    perform fn_write_audit('complaint', p_complaint_id, 'update', 'cost',
                           null, p_cost::text, null, p_actor);
  end if;

  if p_replacement_batch_item_id is not null then
    perform fn_write_audit('complaint', p_complaint_id, 'update', 'replacement_production_batch_item_id',
                           null, p_replacement_batch_item_id::text, null, p_actor);
  end if;
end;
$$;

revoke all on function fn_resolve_complaint(uuid, complaint_decision, text, numeric, uuid, text) from public;
revoke all on function fn_resolve_complaint(uuid, complaint_decision, text, numeric, uuid, text) from anon;
grant execute on function fn_resolve_complaint(uuid, complaint_decision, text, numeric, uuid, text) to authenticated;

-- ===========================================================================
-- LIZENZEN
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_expire_license(p_license_id, p_actor) → void
-- ---------------------------------------------------------------------------
-- status aktiv → abgelaufen. Bewusst als Admin-Aktion, nicht als Cronjob
-- (lizenzen.md §4, Task-Vorgabe). Kein Zurück nach 'aktiv' — Aufruf auf einer
-- nicht-aktiven Lizenz → Exception.
create or replace function fn_expire_license(
  p_license_id uuid,
  p_actor       text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status license_status;
  v_now    timestamptz := now();
begin
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_expire_license: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select l.status into v_status
  from licenses l
  where l.id = p_license_id
  for update;

  if not found then
    raise exception 'fn_expire_license: Lizenz % existiert nicht', p_license_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_status <> 'aktiv' then
    raise exception 'fn_expire_license: Lizenz % hat Status % — nur aus ''aktiv'' möglich (kein Zurück)',
      p_license_id, v_status
      using errcode = 'check_violation';
  end if;

  update licenses
  set status     = 'abgelaufen',
      updated_at = v_now
  where id = p_license_id;

  perform fn_write_audit('license', p_license_id, 'status_change', 'status',
                         'aktiv', 'abgelaufen', null, p_actor);
end;
$$;

revoke all on function fn_expire_license(uuid, text) from public;
revoke all on function fn_expire_license(uuid, text) from anon;
grant execute on function fn_expire_license(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_revoke_license(p_license_id, p_reason, p_actor) → void
-- ---------------------------------------------------------------------------
-- status aktiv → widerrufen, p_reason Pflicht (landet in audit_log.reason).
-- Kein Zurück nach 'aktiv' — Aufruf auf einer nicht-aktiven Lizenz → Exception.
create or replace function fn_revoke_license(
  p_license_id uuid,
  p_reason      text,
  p_actor       text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status license_status;
  v_reason text := nullif(trim(p_reason), '');
  v_now    timestamptz := now();
begin
  if v_reason is null then
    raise exception 'fn_revoke_license: reason ist Pflicht'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_revoke_license: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select l.status into v_status
  from licenses l
  where l.id = p_license_id
  for update;

  if not found then
    raise exception 'fn_revoke_license: Lizenz % existiert nicht', p_license_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_status <> 'aktiv' then
    raise exception 'fn_revoke_license: Lizenz % hat Status % — nur aus ''aktiv'' möglich (kein Zurück)',
      p_license_id, v_status
      using errcode = 'check_violation';
  end if;

  update licenses
  set status     = 'widerrufen',
      updated_at = v_now
  where id = p_license_id;

  perform fn_write_audit('license', p_license_id, 'status_change', 'status',
                         'aktiv', 'widerrufen', v_reason, p_actor);
end;
$$;

revoke all on function fn_revoke_license(uuid, text, text) from public;
revoke all on function fn_revoke_license(uuid, text, text) from anon;
grant execute on function fn_revoke_license(uuid, text, text) to authenticated;

-- ===========================================================================
-- ANFRAGEN & ANGEBOTE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_reject_custom_request(p_custom_request_id, p_reason, p_actor) → void
-- ---------------------------------------------------------------------------
-- status neu/geprueft → abgelehnt (angebote-individuelle-anfragen.md §4). Aus
-- 'angebot_erstellt' nicht erlaubt (kein Zurück). p_reason Pflicht.
create or replace function fn_reject_custom_request(
  p_custom_request_id uuid,
  p_reason              text,
  p_actor               text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status custom_request_status;
  v_reason text := nullif(trim(p_reason), '');
  v_now    timestamptz := now();
begin
  if v_reason is null then
    raise exception 'fn_reject_custom_request: reason ist Pflicht'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_reject_custom_request: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select cr.status into v_status
  from custom_requests cr
  where cr.id = p_custom_request_id
  for update;

  if not found then
    raise exception 'fn_reject_custom_request: Anfrage % existiert nicht', p_custom_request_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_status not in ('neu', 'geprueft') then
    raise exception 'fn_reject_custom_request: Anfrage % hat Status % — Ablehnung ist nur aus ''neu'' oder ''geprueft'' möglich (kein Zurück aus ''angebot_erstellt'')',
      p_custom_request_id, v_status
      using errcode = 'check_violation';
  end if;

  update custom_requests
  set status     = 'abgelehnt',
      updated_at = v_now
  where id = p_custom_request_id;

  perform fn_write_audit('custom_request', p_custom_request_id, 'status_change', 'status',
                         v_status::text, 'abgelehnt', v_reason, p_actor);
end;
$$;

revoke all on function fn_reject_custom_request(uuid, text, text) from public;
revoke all on function fn_reject_custom_request(uuid, text, text) from anon;
grant execute on function fn_reject_custom_request(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_reject_offer(p_offer_id, p_rejection_reason, p_actor) → void
-- ---------------------------------------------------------------------------
-- status offen → abgelehnt, schreibt rejection_reason (Pflichtfeld laut §4).
-- Muster identisch zu fn_revoke_offer (00153, Befund 5): zwei Audit-Zeilen
-- (Feldänderung + Statuswechsel).
create or replace function fn_reject_offer(
  p_offer_id           uuid,
  p_rejection_reason    text,
  p_actor                text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer offers%rowtype;
  v_reason text := nullif(trim(p_rejection_reason), '');
  v_now    timestamptz := now();
begin
  if v_reason is null then
    raise exception 'fn_reject_offer: rejection_reason ist Pflicht'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_reject_offer: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_offer
  from offers
  where id = p_offer_id
  for update;

  if not found then
    raise exception 'fn_reject_offer: Angebot % existiert nicht', p_offer_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_offer.status <> 'offen' then
    raise exception 'fn_reject_offer: Angebot % hat Status % — Ablehnung ist nur aus ''offen'' möglich', p_offer_id, v_offer.status
      using errcode = 'check_violation';
  end if;

  update offers
  set status            = 'abgelehnt',
      rejection_reason  = v_reason,
      updated_at        = v_now
  where id = p_offer_id;

  perform fn_write_audit('offer', p_offer_id, 'update', 'rejection_reason',
                         null, v_reason, null, p_actor);
  perform fn_write_audit('offer', p_offer_id, 'status_change', 'status',
                         'offen', 'abgelehnt', null, p_actor);
end;
$$;

revoke all on function fn_reject_offer(uuid, text, text) from public;
revoke all on function fn_reject_offer(uuid, text, text) from anon;
grant execute on function fn_reject_offer(uuid, text, text) to authenticated;
