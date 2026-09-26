-- Migration 00148: RPC-Funktionen Teil 5d
-- (fn_confirm_order [erweitert], fn_retry_pending_reservations,
--  trg_retry_on_material_inflow, fn_expire_offers, fn_anonymize_customers)
-- Siehe specs/bestellungen.md §3 ("Automatischer Retry bei Materialeingang",
-- FIFO nach orders.created_at), §4 (Statusübergänge);
-- specs/angebote-individuelle-anfragen.md §4 (offen → abgelaufen, zeitbasiert);
-- specs/kunden-warenkorb-tracking.md §3 (DSGVO-Anonymisierung, Stufe 2);
-- specs/audit-settings.md §3/§5 (Systemprozesse schreiben actor='system');
-- specs/fertigwarenbestand.md §3 (Reservierung bei Bestellbestätigung).
--
-- Kein Scheduling (Cron/GitHub Actions) hier — nur die SQL-Funktionen.
-- Keine RLS-Policies hier.
--
-- ===========================================================================
-- ABSCHNITT A: Änderung an fn_confirm_order (aus 00142)
-- ===========================================================================
-- Entscheidung (Task-Rückfrage, Option A): fn_confirm_order wird für den
-- automatischen Retry wiederverwendet statt eine zweite Reservierungslogik zu
-- bauen. Dafür drei Ergänzungen — sonst keine Änderung an der Logik
-- (Sperrreihenfolge, FOR UPDATE, Order-Status-Entscheidung bleiben identisch):
--
--   1. Schleife über status in ('Offen','WartetAufMaterial') statt nur 'Offen'
--      — bisher wurden wartende Positionen übersprungen, ein erneuter Aufruf
--      konnte sie nie reservieren.
--   2. Neuer optionaler Parameter p_actor (default null):
--      v_actor := coalesce(p_actor, auth.uid()::text, 'system'). Der Retry
--      übergibt explizit 'system', damit auch ein durch den Trigger in einer
--      Admin-Session ausgelöster Retry als Systemprozess auditiert wird
--      (audit-settings.md §5). Bestehende Aufrufer ohne p_actor
--      (fn_accept_offer, Frontend) verhalten sich wie bisher.
--   3. Erfolgreiche Reservierung einer Position, die auf 'WartetAufMaterial'
--      stand → status 'Offen' (identisch zu einer regulär reservierten
--      Position), mit Audit-Eintrag WartetAufMaterial → Offen.
--      Spiegelbildlich wird der Übergang Offen → WartetAufMaterial (inkl.
--      Audit) nur noch geschrieben, wenn die Position tatsächlich auf 'Offen'
--      stand — eine bereits wartende Position, für die der Bestand weiterhin
--      nicht reicht, bleibt unverändert (kein WartetAufMaterial →
--      WartetAufMaterial-Audit, kein updated_at-Bump).
--
-- Signaturwechsel: CREATE OR REPLACE kann keine Parameter hinzufügen — es
-- entstünde eine zweite Überladung fn_confirm_order(uuid, text) neben
-- fn_confirm_order(uuid), und der Aufruf fn_confirm_order(x) wäre für
-- PostgreSQL mehrdeutig ("function is not unique"). Deshalb DROP + CREATE;
-- die Grants werden anschließend neu gesetzt (identisch zu 00142).
-- fn_accept_offer (00147) ruft fn_confirm_order(v_order_id) auf — plpgsql
-- löst den Aufruf zur Laufzeit auf, der Aufruf bleibt gültig.

drop function if exists fn_confirm_order(uuid);

-- ---------------------------------------------------------------------------
-- fn_confirm_order(p_order_id, p_actor default null) → jsonb
--   { "order_status": ..., "items": [ { "order_item_id", "status",
--                                       "reserved": bool }, ... ] }
-- ---------------------------------------------------------------------------
-- Admin-Aktion: Bestellung New → Confirmed inkl. sofortiger Reservierung der
-- Fertigware (fertigwarenbestand.md §3, #30). Reserviert wird ausschließlich
-- stock_type = 'normal' (Katalogbestellung; B-Ware ist ein eigener
-- Bestandstyp und nicht Teil des Katalog-Checkouts — Entscheidung
-- Task-Rückfrage 00142).
--
-- Ablauf (eine Transaktion — die *Versuche* sind atomar, das *Ergebnis*
-- darf gemischt sein, bestellungen.md §5):
--   1. orders-Zeile mit FOR UPDATE sperren, Status muss 'New' sein.
--   2. Je order_item mit status in ('Offen', 'WartetAufMaterial'):
--      - hat es bereits eine aktive Reservierung (z. B. aus einem früheren
--        Aufruf, bei dem eine andere Position gescheitert ist) → zählt als
--        reserviert, nichts tun (keine Doppelreservierung).
--      - ohne Katalogbezug (Ausnahmepfad, variant_configuration_id IS NULL)
--        → es gibt keinen Fertigwarenbestand → 'WartetAufMaterial'
--        (Entscheidung Task-Rückfrage 00142).
--      - sonst: Verfügbarkeit = Σ movements.qty_delta − Σ aktive
--        Reservierungen (fertigwarenbestand.md §2); reicht sie für die volle
--        Menge (alles-oder-nichts je Position) → Reservierung 'aktiv'
--        (+ WartetAufMaterial → Offen, falls die Position wartete),
--        sonst → order_items.status = 'WartetAufMaterial' (falls noch 'Offen').
--   3. orders → 'Confirmed' (+ confirmed_at) nur, wenn JEDE aktive (nicht
--      stornierte) Position eine aktive Reservierung hat; sonst bleibt 'New'.
--   4. Audit-Log je Statuswechsel (orders, order_items, Reservierung).
--
-- Sperrstrategie gegen Race-Conditions (#5) — gewählt: SELECT ... FOR UPDATE
-- auf die variant_configurations-Zeile je Position:
--   Der Bestand ist eine Summe über finished_goods_movements und
--   finished_goods_reservations. Ein FOR UPDATE auf diesen Zeilen selbst
--   würde nichts nützen: Zeilensperren verhindern keine gleichzeitigen
--   INSERTs anderer Transaktionen (Phantome), zwei parallele Bestätigungen
--   könnten also beide "reicht" lesen und beide reservieren. Deshalb wird die
--   eine Zeile gesperrt, die alle Konkurrenten um denselben Bestand zwingend
--   teilen: die variant_configurations-Zeile. Erst NACH Erhalt dieser Sperre
--   werden Bestand und Reservierungen summiert (unter READ COMMITTED bekommt
--   jedes Statement einen frischen Snapshot, sieht also alles, was der
--   vorherige Sperrhalter committed hat) und die Reservierung eingefügt —
--   Prüfen und Anlegen sind damit für eine Konfiguration serialisiert. Die
--   Sperre hält bis Commit/Rollback der aufrufenden Transaktion.
--   Deadlock-Vermeidung: Positionen werden in fester Reihenfolge
--   (variant_configuration_id, id) durchlaufen, sodass zwei Bestellungen mit
--   überlappenden Konfigurationen ihre Sperren in derselben Reihenfolge
--   anfordern. Zusätzlich sperrt FOR UPDATE auf orders die Bestellung selbst
--   gegen doppelte gleichzeitige Bestätigung.
--   FIFO auf Positionsebene innerhalb EINER Order ist laut bestellungen.md §3
--   nicht gefordert (nur nach orders.created_at) — die Sperrreihenfolge
--   bleibt daher unverändert (Entscheidung Task-Rückfrage 00148).
create or replace function fn_confirm_order(
  p_order_id uuid,
  p_actor    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Explizit übergebener actor (Retry: 'system') hat Vorrang; sonst
  -- auth.uid(), Fallback 'system' für Aufrufe ohne JWT-Kontext (CLI/service_role).
  v_actor        text := coalesce(p_actor, auth.uid()::text, 'system');
  v_order_status order_status;
  v_item         record;
  v_stock        int;
  v_reserved     int;
  v_reservation  uuid;
  v_all_reserved boolean;
  v_final_status order_status;
  v_items        jsonb;
begin
  -- 1. Bestellung sperren und prüfen ----------------------------------------
  select o.status into v_order_status
  from orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Bestellung % existiert nicht', p_order_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_order_status <> 'New' then
    raise exception 'Bestellung % hat Status % — bestätigen ist nur aus ''New'' möglich',
      p_order_id, v_order_status
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from order_items oi
    where oi.order_id = p_order_id and oi.status <> 'Storniert'
  ) then
    raise exception 'Bestellung % hat keine aktiven (nicht stornierten) Positionen', p_order_id
      using errcode = 'check_violation';
  end if;

  -- 2. Reservierungsversuch je offener / wartender Position ------------------
  for v_item in
    select oi.id, oi.variant_configuration_id, oi.qty, oi.status
    from order_items oi
    where oi.order_id = p_order_id
      and oi.status in ('Offen', 'WartetAufMaterial')
    order by oi.variant_configuration_id nulls last, oi.id   -- feste Sperrreihenfolge
  loop
    -- bereits reserviert (Wiederholungsaufruf) → nichts tun
    if exists (
      select 1 from finished_goods_reservations r
      where r.order_item_id = v_item.id and r.status = 'aktiv'
    ) then
      continue;
    end if;

    if v_item.variant_configuration_id is not null then
      -- Sperre auf die Konfiguration (siehe Sperrstrategie oben)
      perform 1 from variant_configurations vc
      where vc.id = v_item.variant_configuration_id
      for update;

      -- Bestand = Σ qty_delta, Verfügbar = Bestand − Σ aktive Reservierungen
      select coalesce(sum(m.qty_delta), 0) into v_stock
      from finished_goods_movements m
      where m.variant_configuration_id = v_item.variant_configuration_id
        and m.stock_type = 'normal';

      select coalesce(sum(r.qty), 0) into v_reserved
      from finished_goods_reservations r
      where r.variant_configuration_id = v_item.variant_configuration_id
        and r.stock_type = 'normal'
        and r.status = 'aktiv';
    else
      -- Ausnahmepfad (kein Katalogbezug): kein Fertigwarenbestand vorhanden
      v_stock    := 0;
      v_reserved := 0;
    end if;

    if v_item.variant_configuration_id is not null
       and (v_stock - v_reserved) >= v_item.qty then
      -- alles-oder-nichts je Position: volle Menge reservieren
      insert into finished_goods_reservations
        (variant_configuration_id, stock_type, order_item_id, qty, status)
      values
        (v_item.variant_configuration_id, 'normal', v_item.id, v_item.qty, 'aktiv')
      returning id into v_reservation;

      -- fertigwarenbestand.md §4: jeder Reservierungsübergang mit Audit-Eintrag
      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('finished_goods_reservation', v_reservation, 'status_change', 'status', null, 'aktiv', v_actor);

      -- Retry-Erfolg: wartende Position zurück auf 'Offen' (wie regulär reserviert)
      if v_item.status = 'WartetAufMaterial' then
        update order_items
        set status = 'Offen', updated_at = now()
        where id = v_item.id;

        insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
        values ('order_item', v_item.id, 'status_change', 'status', 'WartetAufMaterial', 'Offen', v_actor);
      end if;
    elsif v_item.status = 'Offen' then
      update order_items
      set status = 'WartetAufMaterial', updated_at = now()
      where id = v_item.id;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('order_item', v_item.id, 'status_change', 'status', 'Offen', 'WartetAufMaterial', v_actor);
    end if;
    -- (bereits wartende Position ohne ausreichenden Bestand: unverändert)
  end loop;

  -- 3. Bestellstatus ---------------------------------------------------------
  -- Confirmed nur, wenn jede aktive Position eine aktive Reservierung hat.
  select not exists (
    select 1 from order_items oi
    where oi.order_id = p_order_id
      and oi.status <> 'Storniert'
      and not exists (
        select 1 from finished_goods_reservations r
        where r.order_item_id = oi.id and r.status = 'aktiv'
      )
  ) into v_all_reserved;

  if v_all_reserved then
    update orders
    set status = 'Confirmed', confirmed_at = now(), updated_at = now()
    where id = p_order_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('order', p_order_id, 'status_change', 'status', 'New', 'Confirmed', v_actor);

    v_final_status := 'Confirmed';
  else
    v_final_status := 'New';
  end if;

  -- 4. Ergebnisübersicht -----------------------------------------------------
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'order_item_id', oi.id,
             'status',        oi.status,
             'reserved',      exists (
                                select 1 from finished_goods_reservations r
                                where r.order_item_id = oi.id and r.status = 'aktiv'
                              )
           ) order by oi.created_at, oi.id
         ), '[]'::jsonb)
    into v_items
  from order_items oi
  where oi.order_id = p_order_id;

  return jsonb_build_object(
    'order_status', v_final_status,
    'items',        v_items
  );
end;
$$;

-- Admin-Aktion: nur authenticated, ausdrücklich nicht anon (wie 00142).
revoke all on function fn_confirm_order(uuid, text) from public;
revoke all on function fn_confirm_order(uuid, text) from anon;
grant execute on function fn_confirm_order(uuid, text) to authenticated;

-- ===========================================================================
-- ABSCHNITT B: Automatischer Reservierungs-Retry
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_retry_pending_reservations() → int
--   Anzahl der Positionen, die von 'WartetAufMaterial' auf 'Offen' gewechselt
--   sind (= erfolgreich reserviert).
-- ---------------------------------------------------------------------------
-- bestellungen.md §3: Hängt eine Position wegen fehlendem Bestand auf
-- 'WartetAufMaterial' (Order auf 'New'), löst ein Bestandseingang einen
-- erneuten Reservierungsversuch aus. Konkurrenz um knappen Bestand: FIFO nach
-- orders.created_at (ältere Bestellung zuerst); bei exakt gleichem
-- orders.created_at nach order_items.created_at der ältesten wartenden
-- Position, zuletzt orders.id als deterministischer Tie-Break.
--
-- Die Reservierung selbst erledigt fn_confirm_order(o.id, 'system') je Order
-- (Abschnitt A) — keine zweite Reservierungslogik. Da fn_confirm_order die
-- Orders nacheinander in dieser Reihenfolge bearbeitet und je Konfiguration
-- die variant_configurations-Zeile sperrt, bekommt die ältere Order den
-- Bestand zuerst; die jüngere sieht danach den bereits reservierten Anteil.
--
-- Rekursionsprüfung (gegen 00142): eine Reservierung schreibt ausschließlich
-- in finished_goods_reservations, order_items, orders und audit_log — nie in
-- finished_goods_movements / filament_movements. Der Trigger unten kann sich
-- also nicht selbst erneut auslösen.
--
-- Aufrufer: Cron (service_role) oder Trigger trg_retry_on_material_inflow
-- (dann in der Transaktion des Wareneingangs — schlägt der Retry mit einer
-- Exception fehl, rollt auch der Wareneingang zurück, #31).
create or replace function fn_retry_pending_reservations()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order        record;
  v_waiting_ids  uuid[];
  v_switched     int := 0;
  v_total        int := 0;
begin
  for v_order in
    select o.id,
           o.created_at,
           min(oi.created_at) as first_waiting_at
    from orders o
    join order_items oi on oi.order_id = o.id
    where o.status  = 'New'
      and oi.status = 'WartetAufMaterial'
    group by o.id, o.created_at
    order by o.created_at, min(oi.created_at), o.id      -- FIFO (bestellungen.md §3)
  loop
    -- Zustand vor dem Versuch: alle wartenden Positionen dieser Order
    -- (frischer Snapshot je Order — der Loop-Cursor stammt aus einem älteren
    -- Statement, die Vorgänger-Orders haben inzwischen Bestand reserviert).
    select coalesce(array_agg(oi.id), '{}') into v_waiting_ids
    from order_items oi
    where oi.order_id = v_order.id
      and oi.status = 'WartetAufMaterial';

    if coalesce(array_length(v_waiting_ids, 1), 0) = 0 then
      continue;
    end if;

    -- Reservierungsversuch — Systemprozess, actor = 'system' (audit-settings.md §5)
    perform fn_confirm_order(v_order.id, 'system');

    -- Erfolg = vorher wartend, jetzt 'Offen'
    select count(*) into v_switched
    from order_items oi
    where oi.id = any(v_waiting_ids)
      and oi.status = 'Offen';

    v_total := v_total + v_switched;
  end loop;

  return v_total;
end;
$$;

-- Cron (service_role) und Admin dürfen aufrufen, anon nicht.
revoke all on function fn_retry_pending_reservations() from public;
revoke all on function fn_retry_pending_reservations() from anon;
grant execute on function fn_retry_pending_reservations() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Trigger trg_retry_on_material_inflow
--   AFTER INSERT auf finished_goods_movements und filament_movements,
--   STATEMENT-Level mit Transition-Table: ein Wareneingang mit vielen Zeilen
--   ruft fn_retry_pending_reservations() genau EINMAL auf, nicht je Zeile.
--   Nur bei Bestandszugang (mindestens eine eingefügte Zeile mit
--   qty_delta > 0 bzw. amount_g > 0) — ein reiner Abgang stößt keinen Retry an.
-- ---------------------------------------------------------------------------
-- Der Rückgabewert von fn_retry_pending_reservations wird hier bewusst
-- verworfen; die Reservierungen sind über audit_log (actor='system')
-- nachvollziehbar.
create or replace function trg_retry_on_material_inflow_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_inflow boolean := false;
begin
  if tg_table_name = 'finished_goods_movements' then
    select exists (select 1 from inserted i where i.qty_delta > 0) into v_has_inflow;
  elsif tg_table_name = 'filament_movements' then
    select exists (select 1 from inserted i where i.amount_g > 0) into v_has_inflow;
  end if;

  if v_has_inflow then
    perform fn_retry_pending_reservations();
  end if;

  return null;   -- AFTER-Trigger: Rückgabe wird ignoriert
end;
$$;

revoke all on function trg_retry_on_material_inflow_fn() from public;
revoke all on function trg_retry_on_material_inflow_fn() from anon;

drop trigger if exists trg_retry_on_material_inflow on finished_goods_movements;
create trigger trg_retry_on_material_inflow
  after insert on finished_goods_movements
  referencing new table as inserted
  for each statement execute function trg_retry_on_material_inflow_fn();

drop trigger if exists trg_retry_on_material_inflow on filament_movements;
create trigger trg_retry_on_material_inflow
  after insert on filament_movements
  referencing new table as inserted
  for each statement execute function trg_retry_on_material_inflow_fn();

-- ===========================================================================
-- ABSCHNITT C: Zeitgesteuerte Systemprozesse (actor = 'system')
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_expire_offers() → int   (Anzahl abgelaufener Angebote)
-- ---------------------------------------------------------------------------
-- angebote-individuelle-anfragen.md §4: offen → abgelaufen, wenn valid_until
-- erreicht — zeitbasiert, keine manuelle Admin-Aktion. Ein widerrufenes
-- Angebot (revoked_at gesetzt, status weiterhin 'offen' — Widerruf betrifft
-- nur den Zugriffsweg, fn_revoke_offer in 00146) läuft ebenfalls regulär ab.
-- Bereits akzeptierte/abgelehnte Angebote sind nicht 'offen' und bleiben
-- unberührt. Audit je Angebot, actor = 'system' (audit-settings.md §5).
create or replace function fn_expire_offers()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now   timestamptz := now();
  v_id    uuid;
  v_count int := 0;
begin
  for v_id in
    update offers
    set status     = 'abgelaufen',
        updated_at = v_now
    where status = 'offen'
      and valid_until < v_now
    returning id
  loop
    perform fn_write_audit('offer', v_id, 'status_change', 'status',
                           'offen', 'abgelaufen', null, 'system');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function fn_expire_offers() from public;
revoke all on function fn_expire_offers() from anon;
grant execute on function fn_expire_offers() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- fn_anonymize_customers() → int   (Anzahl anonymisierter Kunden)
-- ---------------------------------------------------------------------------
-- kunden-warenkorb-tracking.md §3, Stufe 2: customers WHERE anonymize_after
-- <= now() AND anonymized_at IS NULL → first_name/last_name auf festen
-- Platzhalter, email/phone NULL, anonymized_at = now(). orders, order_items
-- und order_tracking_tokens bleiben vollständig unberührt (#1) — nur die
-- Kontaktdaten sind betroffen. Bereits anonymisierte Kunden werden nicht
-- erneut angefasst. Audit je Kunde, actor = 'system' (audit-settings.md §5).
create or replace function fn_anonymize_customers()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now   timestamptz := now();
  v_id    uuid;
  v_count int := 0;
begin
  for v_id in
    update customers
    set first_name    = 'Anonymisiert',
        last_name     = 'Anonymisiert',
        email         = null,
        phone         = null,
        anonymized_at = v_now,
        updated_at    = v_now
    where anonymize_after <= v_now
      and anonymized_at is null
    returning id
  loop
    perform fn_write_audit('customer', v_id, 'update', 'anonymized_at',
                           null, v_now::text, 'DSGVO-Anonymisierung', 'system');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function fn_anonymize_customers() from public;
revoke all on function fn_anonymize_customers() from anon;
grant execute on function fn_anonymize_customers() to authenticated, service_role;
