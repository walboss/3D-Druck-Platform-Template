-- Migration 00180: Automatische Zuordnung bestätigter Bestellungen zum
-- Drucker X2D
--
-- Explizite Adminentscheidung (Betreiber, 2026-09-21, per Chat), keine Ableitung
-- aus specs/bestellungen.md oder specs/produktion.md — beide beschreiben die
-- "Zwei-Schritte-Trennung Planung vs. tatsächlicher Start" bisher als rein
-- manuellen Admin-Schritt ("Zur Produktion zuordnen"). Diese Migration
-- automatisiert NUR Schritt 1 (Planung/Zuordnung zu einem production_order),
-- nicht Schritt 2 (fn_start_production_order bleibt manuelle Adminaktion mit
-- Spulenwahl, Prinzip #18) — der Produktionsauftrag bleibt nach Autozuordnung
-- im Status 'Geplant', keine Filamentreservierung.
--
-- ABSCHNITT A: planned_start optional
-- -----------------------------------------------------------------------
-- Bisher NOT NULL (0001) und explizit in fn_create_production_order (00154)
-- geprüft. Auf Wunsch (Betreiber): der automatisch angelegte Auftrag soll ohne
-- Startzeit als "wartend" angelegt werden können, der Admin trägt die Zeit
-- später manuell nach. Gilt systemweit, nicht nur für den neuen Auto-Pfad —
-- betrifft auch die manuelle Neuanlage im Admin-Dialog.
alter table production_orders
  alter column planned_start drop not null;

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
  -- planned_start darf jetzt NULL sein ("wartend", Admin trägt Zeit später
  -- nach) — Migration 00180. Vorherige Pflicht-Prüfung entfernt.
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

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('production_order', v_id, 'create', 'status', null, 'Geplant', p_actor);

  return v_id;
end;
$$;

revoke all on function fn_create_production_order(uuid, timestamptz, text) from public;
revoke all on function fn_create_production_order(uuid, timestamptz, text) from anon;
grant execute on function fn_create_production_order(uuid, timestamptz, text) to authenticated;

-- ABSCHNITT B: Drucker X2D anlegen
-- -----------------------------------------------------------------------
-- Werte von Betreiber bestätigt (2026-09-21, per Chat): model als voller
-- Modellname, power_consumption_w/machine_hour_rate grobe, von Betreiber
-- abgenickte Schätzwerte (analog zum bereits bestätigten
-- settings.machine_hourly_rate-Startwert für den X2D, siehe BUILD-LOG
-- 2026-09-2x) — später in den Einstellungen/DB anpassbar.
insert into printers (name, model, power_consumption_w, machine_hour_rate, active)
select 'X2D', 'Bambu Lab X2D', 1000, 0.40, true
where not exists (select 1 from printers where name = 'X2D');

-- ABSCHNITT C: fn_confirm_order — automatische Produktionszuordnung
-- -----------------------------------------------------------------------
-- Unverändert gegenüber 00155 bis auf neuen Schritt 3b: sobald eine
-- Bestellung 'Confirmed' wird, werden alle ihre freien, nicht bereits
-- zugeordneten aktiven Positionen (status 'Offen', production_order_id
-- NULL — WartetAufMaterial ist an dieser Stelle ausgeschlossen, siehe
-- Schritt 3) automatisch einem production_order auf Drucker X2D zugeordnet
-- (fn_assign_to_production, Schritt 1 der Zwei-Schritte-Trennung).
-- Bündelung: existiert bereits ein wartender ('Geplant') X2D-Auftrag, werden
-- die Positionen dort mit reingelegt statt einen weiteren anzulegen — sonst
-- neuer Auftrag ohne Startzeit (planned_start NULL, Abschnitt A).
--
-- Gilt für beide Aufrufer von fn_confirm_order identisch: den direkten
-- Admin-Klick "Bestätigen" UND den automatischen Retry bei Materialeingang
-- (fn_retry_pending_reservations, 00148) — beide setzen orders.status auf
-- 'Confirmed' ausschließlich über diese Funktion.
--
-- Ausnahmepfad-Positionen (variant_configuration_id IS NULL) sind hier
-- eingeschlossen: sie sind ab fn_accept_offer immer 'Offen' und blockieren
-- Confirmed nie (00155) — auch sie sollen automatisch in Produktion gehen.
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
  v_actor              text := coalesce(p_actor, auth.uid()::text, 'system');
  v_order_status       order_status;
  v_item               record;
  v_stock              int;
  v_reserved           int;
  v_reservation        uuid;
  v_all_reserved       boolean;
  v_final_status       order_status;
  v_items              jsonb;
  v_x2d_printer_id     uuid;
  v_production_order_id uuid;
  v_unassigned_item    record;
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

  -- 2. Reservierungsversuch je offener / wartender Position -------------------
  -- Ausnahmepfad-Positionen (variant_configuration_id IS NULL) nehmen NICHT
  -- teil: es gibt für sie strukturell nie Fertigwarenbestand (individuell
  -- gefertigte Einzelstücke ohne Katalogbezug, angebote-individuelle-
  -- anfragen.md §3) — kein Reservierungsversuch, kein Statuswechsel, sie
  -- bleiben auf ihrem aktuellen Status stehen.
  for v_item in
    select oi.id, oi.variant_configuration_id, oi.qty, oi.status
    from order_items oi
    where oi.order_id = p_order_id
      and oi.status in ('Offen', 'WartetAufMaterial')
      and oi.variant_configuration_id is not null
    order by oi.variant_configuration_id, oi.id   -- feste Sperrreihenfolge
  loop
    -- bereits reserviert (Wiederholungsaufruf) → nichts tun
    if exists (
      select 1 from finished_goods_reservations r
      where r.order_item_id = v_item.id and r.status = 'aktiv'
    ) then
      continue;
    end if;

    -- Sperre auf die Konfiguration (siehe Sperrstrategie in 00142/00148)
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

    if (v_stock - v_reserved) >= v_item.qty then
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

  -- 3. Bestellstatus -----------------------------------------------------------
  -- Confirmed, wenn JEDE aktive (nicht stornierte) Position entweder eine
  -- aktive Reservierung hat ODER eine Ausnahmepfad-Position ist (s. o.) —
  -- Ausnahmepfad-Positionen blockieren Confirmed nicht.
  select not exists (
    select 1 from order_items oi
    where oi.order_id = p_order_id
      and oi.status <> 'Storniert'
      and oi.variant_configuration_id is not null
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

    -- 3b. Automatische Produktionszuordnung auf Drucker X2D (Migration 00180) --
    select p.id into v_x2d_printer_id
    from printers p
    where p.name = 'X2D'
    limit 1;

    if v_x2d_printer_id is not null then
      -- Bündeln: bestehenden wartenden ('Geplant') X2D-Auftrag wiederverwenden.
      select po.id into v_production_order_id
      from production_orders po
      where po.printer_id = v_x2d_printer_id
        and po.status = 'Geplant'
      order by po.created_at
      limit 1
      for update;

      if v_production_order_id is null then
        v_production_order_id := fn_create_production_order(v_x2d_printer_id, null, v_actor);
      end if;

      for v_unassigned_item in
        select oi.id
        from order_items oi
        where oi.order_id = p_order_id
          and oi.status = 'Offen'
          and oi.production_order_id is null
        order by oi.created_at, oi.id
      loop
        perform fn_assign_to_production(v_unassigned_item.id, v_production_order_id);
      end loop;
    end if;
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

-- Admin-Aktion: nur authenticated, ausdrücklich nicht anon (wie 00142/00148/00155).
revoke all on function fn_confirm_order(uuid, text) from public;
revoke all on function fn_confirm_order(uuid, text) from anon;
grant execute on function fn_confirm_order(uuid, text) to authenticated;
