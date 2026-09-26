-- Migration 00155: fn_confirm_order — Ausnahmepfad-Positionen korrigiert
-- Siehe specs/bestellungen.md §2 (Ausnahmepfad-Constraint: Katalog-Trippel XOR
-- desired_description), §3 (Ausnahmepfad "verhält sich identisch"), §4
-- (Statusübergänge New → Confirmed); specs/angebote-individuelle-anfragen.md
-- §3 (alle aus einem Angebot entstehenden order_items laufen über den
-- Ausnahmepfad, variant_configuration_id strukturell immer NULL);
-- specs/fertigwarenbestand.md §3 (Reservierung nur für Fertigwarenbestand,
-- den es für individuell gefertigte Einzelstücke ohne Katalogbezug nie gibt).
--
-- Befund aus der Abschlussprüfung (Durchlauf 3): fn_confirm_order (00142,
-- erweitert in 00148) behandelte eine Ausnahmepfad-Position wie eine
-- Katalogposition ohne Bestand (variant_configuration_id IS NULL → v_stock=0)
-- und setzte sie auf 'WartetAufMaterial'. Da für den Ausnahmepfad strukturell
-- nie ein finished_goods_reservations-Eintrag entstehen kann (es gibt keine
-- variant_configuration_id, auf die reserviert werden könnte), blieb jede rein
-- aus einem Angebot angenommene Bestellung für immer auf 'New' stehen und
-- konnte nie Confirmed/InProduction/Finished/ReadyForPickup/HandedOver
-- erreichen.
--
-- Korrektur: Ausnahmepfad-Positionen (variant_configuration_id IS NULL)
-- nehmen nicht mehr am Reservierungsversuch teil — kein Statuswechsel, sie
-- bleiben auf ihrem aktuellen Status (i. d. R. 'Offen' aus fn_accept_offer).
-- Für die Confirmed-Entscheidung zählen sie automatisch als "erledigt": eine
-- Bestellung wird Confirmed, wenn JEDE aktive (nicht stornierte) Position
-- entweder eine aktive finished_goods_reservation hat ODER eine
-- Ausnahmepfad-Position ist. Eine Bestellung ausschließlich mit
-- Ausnahmepfad-Positionen wird damit beim ersten fn_confirm_order-Aufruf
-- sofort vollständig Confirmed, ohne dass irgendetwas reserviert wurde.
--
-- Geprüft, nicht verändert (Task-Vorgabe): fn_assign_to_production (00143)
-- liest/schreibt ausschließlich order_items.id/order_id/status/
-- production_order_id und orders.status — an keiner Stelle variant_id oder
-- variant_configuration_id. Der Übergang Confirmed → InProduction (nur aus
-- 'Confirmed' definiert, bestellungen.md §3/§4) greift für eine nach dieser
-- Korrektur regulär Confirmed gewordene Angebots-Bestellung identisch zu
-- einer Katalogbestellung — kein Anpassungsbedarf, kein STOPP nötig.
-- fn_complete_order_item (00153) prüft variant_configuration_id bereits
-- korrekt nur an der Stelle, wo Fertigwarenbestand gebucht wird (Schritt 5),
-- und bleibt unverändert.
--
-- Gemischte Bestellungen (Katalog- und Ausnahmepfad-Positionen in derselben
-- Order) geprüft: fn_place_order (00142/00153) legt ausschließlich
-- Katalogpositionen an (aus cart_items, immer mit variant_configuration_id),
-- fn_accept_offer (00147/00153) ausschließlich Ausnahmepfad-Positionen (aus
-- offer_items, immer ohne Katalogbezug). Es existiert keine Funktion, die
-- order_items nachträglich zu einer bestehenden orders-Zeile hinzufügt. Eine
-- gemischte Bestellung kann unter der bestehenden Logik strukturell nicht
-- entstehen — kein Sonderpfad dafür nötig.
--
-- Kein DROP nötig: Parameterliste (p_order_id uuid, p_actor text default
-- null) und Rückgabetyp jsonb bleiben unverändert gegenüber 00148, nur der
-- Funktionskörper ändert sich (reines CREATE OR REPLACE).
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

-- Admin-Aktion: nur authenticated, ausdrücklich nicht anon (wie 00142/00148).
revoke all on function fn_confirm_order(uuid, text) from public;
revoke all on function fn_confirm_order(uuid, text) from anon;
grant execute on function fn_confirm_order(uuid, text) to authenticated;
