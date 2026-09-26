-- Migration 00186: Druckerverwaltung — Standard-Drucker statt fest 'X2D'
-- (2026-09-24)
--
-- Explizite Adminentscheidung (Betreiber, 2026-09-24, per Chat):
--   - Mehrere Drucker pflegbar (neue Admin-Seite "Drucker"), genau ein
--     Drucker ist "Standard" (Stern-Button). Startwert: X2D.
--   - Die automatische Produktionszuordnung in fn_confirm_order (00180/
--     00181/00185) nutzt den Standard-Drucker statt fest name = 'X2D'.
--     Manuelle Auftragsanlage mit beliebigem aktivem Drucker bleibt.
--   - Kalkulation bleibt unverändert (globaler settings.machine_hourly_rate).
--   - Kein Löschen von Druckern, nur deaktivieren. Der Standard-Drucker kann
--     nicht deaktiviert werden (erst anderen Drucker zum Standard machen).

-- ABSCHNITT A: printers.is_default ----------------------------------------
alter table printers add column is_default boolean not null default false;

-- höchstens ein Standard-Drucker
create unique index printers_one_default_idx on printers (is_default) where is_default;

update printers
set is_default = true, updated_at = now()
where id = (
  select id from printers
  where name = 'X2D' and active
  order by created_at
  limit 1
);

-- Standard-Drucker muss aktiv sein
alter table printers
  add constraint printers_default_must_be_active check (not is_default or active);

-- ABSCHNITT B: fn_set_default_printer -------------------------------------
-- Tauscht den Standard atomar (zwei Einzel-Updates vom Client würden am
-- Unique-Index scheitern bzw. kurz keinen Standard haben).
create or replace function fn_set_default_printer(p_printer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  text := coalesce(auth.uid()::text, 'system');
  v_active boolean;
  v_old_id uuid;
begin
  select p.active into v_active
  from printers p
  where p.id = p_printer_id
  for update;

  if not found then
    raise exception 'fn_set_default_printer: Drucker % existiert nicht', p_printer_id
      using errcode = 'invalid_parameter_value';
  end if;

  if not v_active then
    raise exception 'fn_set_default_printer: Drucker % ist deaktiviert', p_printer_id
      using errcode = 'check_violation';
  end if;

  select p.id into v_old_id from printers p where p.is_default;

  if v_old_id is not distinct from p_printer_id then
    return;
  end if;

  update printers set is_default = false, updated_at = now() where is_default;
  update printers set is_default = true, updated_at = now() where id = p_printer_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('printer', p_printer_id, 'update', 'is_default', coalesce(v_old_id::text, ''), 'true', v_actor);
end;
$$;

revoke all on function fn_set_default_printer(uuid) from public;
revoke all on function fn_set_default_printer(uuid) from anon;
grant execute on function fn_set_default_printer(uuid) to authenticated;

-- ABSCHNITT C: fn_confirm_order — Standard-Drucker statt 'X2D' -------------
-- Unverändert gegenüber 00185 bis auf die Druckerauswahl in Schritt 4.
create or replace function fn_confirm_order(p_order_id uuid, p_actor text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor               text := coalesce(p_actor, auth.uid()::text, 'system');
  v_order_status        order_status;
  v_item                record;
  v_stock               int;
  v_reserved            int;
  v_reservation         uuid;
  v_final_status        order_status;
  v_items               jsonb;
  v_default_printer_id  uuid;
  v_production_order_id uuid;
  v_config_group        record;
  v_unassigned_item     record;
  v_all_done            boolean;
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

  -- 2. Lagerware reservieren (00185) -----------------------------------------
  -- Katalogpositionen, die noch nicht in Produktion sind und keine aktive
  -- Reservierung haben. Reicht der freie Fertigwarenbestand für die volle
  -- Menge: reservieren und Position direkt 'Fertig' (liegt bereit, KEIN Druck).
  -- Reicht er nicht: Position bleibt/wird 'Offen' und geht unten in die
  -- Produktion. 'Fertig' ohne Reservierung (Altfall vor 00185: produziert,
  -- aber Bestellung hing auf 'New') wird nachträglich aus dem Bestand gedeckt.
  -- Ausnahmepfad-Positionen (variant_configuration_id IS NULL) haben nie
  -- Fertigwarenbestand und nehmen hier nicht teil.
  for v_item in
    select oi.id, oi.variant_configuration_id, oi.qty, oi.status
    from order_items oi
    where oi.order_id = p_order_id
      and oi.status in ('Offen', 'WartetAufMaterial', 'Fertig')
      and oi.variant_configuration_id is not null
      and (oi.status = 'Fertig' or oi.production_order_id is null)
      and not exists (
        select 1 from finished_goods_reservations r
        where r.order_item_id = oi.id and r.status = 'aktiv'
      )
    order by oi.variant_configuration_id, oi.id   -- feste Sperrreihenfolge
  loop
    perform 1 from variant_configurations vc
    where vc.id = v_item.variant_configuration_id
    for update;

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
      insert into finished_goods_reservations
        (variant_configuration_id, stock_type, order_item_id, qty, status)
      values
        (v_item.variant_configuration_id, 'normal', v_item.id, v_item.qty, 'aktiv')
      returning id into v_reservation;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('finished_goods_reservation', v_reservation, 'status_change', 'status', null, 'aktiv', v_actor);

      if v_item.status <> 'Fertig' then
        update order_items
        set status = 'Fertig', updated_at = now()
        where id = v_item.id;

        insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
        values ('order_item', v_item.id, 'status_change', 'status', v_item.status::text, 'Fertig', v_actor);
      end if;
    elsif v_item.status = 'WartetAufMaterial' then
      -- Altfall vor 00185: wartende Position geht jetzt regulär in Produktion.
      update order_items
      set status = 'Offen', updated_at = now()
      where id = v_item.id;

      insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
      values ('order_item', v_item.id, 'status_change', 'status', 'WartetAufMaterial', 'Offen', v_actor);
    end if;
    -- 'Fertig' ohne ausreichenden Bestand: unverändert (Ware wurde bereits
    -- anderweitig verbraucht — Admin klärt manuell).
  end loop;

  -- 3. Bestellung bestätigen --------------------------------------------------
  update orders
  set status = 'Confirmed', confirmed_at = now(), updated_at = now()
  where id = p_order_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('order', p_order_id, 'status_change', 'status', 'New', 'Confirmed', v_actor);

  v_final_status := 'Confirmed';

  -- 4. Automatische Produktionszuordnung auf den Standard-Drucker
  --    (0180/00181, seit 00186 printers.is_default statt fest 'X2D') -----
  --    Nur Positionen OHNE Lagerdeckung ('Offen', nicht zugeordnet). Der
  --    Auftrag bleibt 'Geplant', keine Filamentreservierung — Start bleibt
  --    manuelle Adminaktion (fn_start_production_order).
  --    Bündeln nur bei exakt gleicher variant_configuration_id.
  select p.id into v_default_printer_id
  from printers p
  where p.is_default
    and p.active
  limit 1;

  if v_default_printer_id is not null then
    for v_config_group in
      select distinct oi.variant_configuration_id
      from order_items oi
      where oi.order_id = p_order_id
        and oi.status = 'Offen'
        and oi.production_order_id is null
    loop
      v_production_order_id := null;

      select po.id into v_production_order_id
      from production_orders po
      where po.printer_id = v_default_printer_id
        and po.status = 'Geplant'
        and exists (
          select 1 from order_items oi2
          where oi2.production_order_id = po.id
            and oi2.status <> 'Storniert'
            and oi2.variant_configuration_id is not distinct from v_config_group.variant_configuration_id
        )
      order by po.created_at
      limit 1
      for update;

      if v_production_order_id is null then
        v_production_order_id := fn_create_production_order(v_default_printer_id, null, v_actor);
      end if;

      for v_unassigned_item in
        select oi.id
        from order_items oi
        where oi.order_id = p_order_id
          and oi.status = 'Offen'
          and oi.production_order_id is null
          and oi.variant_configuration_id is not distinct from v_config_group.variant_configuration_id
        order by oi.created_at, oi.id
      loop
        -- setzt die Position auf 'InProduktion' und die Bestellung
        -- Confirmed → InProduction (00143)
        perform fn_assign_to_production(v_unassigned_item.id, v_production_order_id);
      end loop;
    end loop;
  end if;

  -- 4b. Altfall: bereits manuell zugeordnete Positionen (vor 00185 aus
  --     'WartetAufMaterial' heraus) → Bestellung ebenfalls 'InProduction'.
  if exists (
    select 1 from order_items oi
    where oi.order_id = p_order_id and oi.status = 'InProduktion'
  ) and (select o.status from orders o where o.id = p_order_id) = 'Confirmed' then
    update orders
    set status = 'InProduction', updated_at = now()
    where id = p_order_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('order', p_order_id, 'status_change', 'status', 'Confirmed', 'InProduction', v_actor);
  end if;

  -- 5. Alles aus dem Lager gedeckt → direkt 'Finished' ----------------------
  select o.status into v_final_status from orders o where o.id = p_order_id;

  select not exists (
    select 1 from order_items oi
    where oi.order_id = p_order_id
      and oi.status not in ('Fertig', 'Storniert')
  ) into v_all_done;

  if v_all_done and v_final_status = 'Confirmed' then
    update orders
    set status = 'Finished', finished_at = now(), updated_at = now()
    where id = p_order_id;

    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('order', p_order_id, 'status_change', 'status', 'Confirmed', 'Finished', v_actor);

    v_final_status := 'Finished';
  end if;

  -- 6. Ergebnisübersicht -----------------------------------------------------
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
