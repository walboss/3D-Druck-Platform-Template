-- Migration 00182: Automatische Spulenwahl bei eindeutiger Farbe
--
-- Explizite Adminentscheidung (Betreiber, 2026-09-21, per Chat) — teilweise
-- Rücknahme von Prinzip #18 ("keine automatische Filamentauswahl ohne
-- Adminentscheidung", specs/00-overview.md, spec-seitig bisher zwingend
-- manuell, siehe fn_start_production_order-Kommentar in 00143). Begründung:
-- aktuell existiert praktisch nur ein Hersteller/Spule je Farbe, Auswahl ist
-- dann keine echte Entscheidung mehr. Bewusst eng begrenzt:
--
--   - NUR Positionen mit GENAU EINER Farbanforderung (variant_configuration_
--     colors hat genau 1 Zeile für die variant_configuration_id — einfarbige
--     Position, ob mit product_part_id NULL oder mit genau einem Teil).
--     Mehrfarbige Positionen (mehrere Zeilen) bleiben vollständig manuell —
--     die Zuordnungs-API (p_spool_assignments) trägt keine product_part_id,
--     ein automatisches Aufteilen auf mehrere Teile wäre nicht sicher
--     nachvollziehbar.
--   - Ausnahmepfad-Positionen (variant_configuration_id IS NULL, keine
--     Farbe bekannt) bleiben vollständig manuell.
--   - Automatisch gewählt wird NUR, wenn GENAU EINE aktive Spule mit
--     passender Farbe (filament_products.color_id) genug Restbestand für
--     den Bedarf hat. Bei 0 oder ≥2 Kandidaten: keine automatische
--     Entscheidung, Position bleibt in der bestehenden
--     "Ohne Spulenzuordnung"-Fehlermeldung stehen — Admin wählt manuell wie
--     bisher (auch weiterhin per p_spool_assignments möglich, gilt für
--     ALLE Produktionsaufträge/Drucker, nicht nur X2D).
--   - Menge = material_need_g × order_items.qty — derselbe Bedarfswert wie
--     die Kalkulation nutzt (product_variants.material_need_g bei
--     product_part_id NULL, sonst variant_parts.material_need_g für das
--     betroffene Teil). Kein Sicherheitsaufschlag.
--   - Bereits vom Admin für eine Position explizit übergebene Zuordnungen
--     (p_spool_assignments) haben Vorrang — für sie wird nichts automatisch
--     ergänzt oder überschrieben.
--   - Verfügbarkeitsprüfung/Sperre bleibt unverändert Aufgabe des
--     bestehenden Reservierungs-Loops (Schritt 5) — die automatische Auswahl
--     hier ist nur eine Vorauswahl ohne Sperre; ein zwischenzeitlicher
--     Verbrauch führt dort wie bei jeder manuellen Zuordnung zum
--     Fehlschlag/Rollback der gesamten Funktion (#31), nicht zu einer
--     falschen Buchung.
--
-- p_spool_assignments darf jetzt leer/NULL sein (bisher Pflicht,
-- nicht-leeres Array) — vollständig automatisch auflösbare Aufträge starten
-- damit ganz ohne manuelle Eingabe.
create or replace function fn_start_production_order(
  p_production_order_id uuid,
  p_spool_assignments   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor          text := coalesce(auth.uid()::text, 'system');
  v_po_status      production_order_status;
  v_item           record;
  v_assign         record;
  v_item_ids       uuid[] := '{}';   -- zugeordnete order_items (Index i)
  v_batch_ids      uuid[] := '{}';   -- zugehörige production_batch_items (Index i)
  v_idx            int;
  v_batch_id       uuid;
  v_spool_active   boolean;
  v_rest           numeric;
  v_reserved       numeric;
  v_available      numeric;
  v_reservation    uuid;
  v_now            timestamptz := now();
  v_missing        text;
  v_batch_json     jsonb := '[]'::jsonb;
  v_res_json       jsonb := '[]'::jsonb;
  v_assignments    jsonb;
  v_auto_item      record;
  v_config_rows    int;
  v_part_id        uuid;
  v_color_id       uuid;
  v_need_g         numeric;
  v_candidate      record;
  v_candidate_id   uuid;
  v_candidate_n    int;
begin
  -- 1. Auftrag sperren und prüfen -------------------------------------------
  select po.status into v_po_status
  from production_orders po
  where po.id = p_production_order_id
  for update;

  if not found then
    raise exception 'Produktionsauftrag % existiert nicht', p_production_order_id
      using errcode = 'invalid_parameter_value';
  end if;

  if v_po_status <> 'Geplant' then
    raise exception 'Produktionsauftrag % hat Status % — Start ist nur aus ''Geplant'' möglich',
      p_production_order_id, v_po_status
      using errcode = 'check_violation';
  end if;

  -- 2. Zugeordnete Positionen (Schritt 1 muss erfolgt sein) ------------------
  for v_item in
    select oi.id
    from order_items oi
    where oi.production_order_id = p_production_order_id
      and oi.status = 'InProduktion'
    order by oi.created_at, oi.id
    for update
  loop
    v_item_ids := v_item_ids || v_item.id;
  end loop;

  if coalesce(array_length(v_item_ids, 1), 0) = 0 then
    raise exception 'Produktionsauftrag % hat keine zugeordneten Positionen (status ''InProduktion'')',
      p_production_order_id
      using errcode = 'check_violation';
  end if;

  -- 3. Parameter validieren (00182: leer/NULL jetzt erlaubt) -----------------
  v_assignments := coalesce(p_spool_assignments, '[]'::jsonb);

  if jsonb_typeof(v_assignments) <> 'array' then
    raise exception 'p_spool_assignments muss ein JSON-Array [{order_item_id, spool_id, amount_g}, ...] sein (Spulenwahl durch den Admin, #18)'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_assign in
    select a.ord,
           nullif(a.e->>'order_item_id', '') as order_item_id_txt,
           nullif(a.e->>'spool_id', '')      as spool_id_txt,
           nullif(a.e->>'amount_g', '')      as amount_g_txt
    from jsonb_array_elements(v_assignments) with ordinality as a(e, ord)
  loop
    if v_assign.order_item_id_txt is null
       or v_assign.spool_id_txt is null
       or v_assign.amount_g_txt is null then
      raise exception 'Zuordnung #%: order_item_id, spool_id und amount_g sind Pflicht', v_assign.ord
        using errcode = 'invalid_parameter_value';
    end if;

    if v_assign.amount_g_txt::numeric <= 0 then
      raise exception 'Zuordnung #%: amount_g muss > 0 sein (ist %)', v_assign.ord, v_assign.amount_g_txt
        using errcode = 'invalid_parameter_value';
    end if;

    if array_position(v_item_ids, v_assign.order_item_id_txt::uuid) is null then
      raise exception 'Zuordnung #%: Bestellposition % ist dem Produktionsauftrag % nicht (mehr) zugeordnet',
        v_assign.ord, v_assign.order_item_id_txt, p_production_order_id
        using errcode = 'invalid_parameter_value';
    end if;

    -- Nur Validierung der vom Admin genannten Spule — keine Auswahl (#18).
    select s.active into v_spool_active
    from filament_spools s
    where s.id = v_assign.spool_id_txt::uuid;

    if not found then
      raise exception 'Zuordnung #%: Spule % existiert nicht', v_assign.ord, v_assign.spool_id_txt
        using errcode = 'invalid_parameter_value';
    end if;

    if not v_spool_active then
      raise exception 'Zuordnung #%: Spule % ist deaktiviert', v_assign.ord, v_assign.spool_id_txt
        using errcode = 'check_violation';
    end if;
  end loop;

  -- 3b. Automatische Spulenwahl für Positionen ohne explizite Zuordnung
  --     (00182) — nur bei genau einer Farbanforderung und genau einem
  --     passenden aktiven Spulen-Kandidaten mit ausreichendem Restbestand.
  for v_auto_item in
    select oi.id, oi.qty, oi.variant_id, oi.variant_configuration_id
    from order_items oi
    where oi.id = any(v_item_ids)
      and oi.variant_configuration_id is not null
      and not exists (
        select 1 from jsonb_array_elements(v_assignments) e
        where (e->>'order_item_id')::uuid = oi.id
      )
  loop
    select count(*) into v_config_rows
    from variant_configuration_colors c
    where c.variant_configuration_id = v_auto_item.variant_configuration_id;

    if v_config_rows <> 1 then
      continue;   -- mehrfarbig oder unerwartet leer: manuell, keine Auto-Auswahl
    end if;

    select c.product_part_id, c.color_id into v_part_id, v_color_id
    from variant_configuration_colors c
    where c.variant_configuration_id = v_auto_item.variant_configuration_id;

    if v_part_id is null then
      select pv.material_need_g into v_need_g
      from product_variants pv
      where pv.id = v_auto_item.variant_id;
    else
      select vp.material_need_g into v_need_g
      from variant_parts vp
      where vp.variant_id = v_auto_item.variant_id
        and vp.product_part_id = v_part_id;
    end if;

    if v_need_g is null or v_need_g <= 0 then
      continue;   -- kein sinnvoller Bedarfswert: manuell
    end if;

    v_need_g := v_need_g * v_auto_item.qty;

    v_candidate_id := null;
    v_candidate_n  := 0;

    for v_candidate in
      select s.id,
             s.initial_weight_g + coalesce((
               select sum(m.amount_g) from filament_movements m where m.spool_id = s.id
             ), 0)
             - coalesce((
               select sum(r.amount_g) from filament_reservations r
               where r.spool_id = s.id and r.status = 'aktiv'
             ), 0) as available
      from filament_spools s
      join filament_products fp on fp.id = s.filament_product_id
      where fp.color_id = v_color_id
        and s.active
    loop
      if v_candidate.available >= v_need_g then
        v_candidate_n := v_candidate_n + 1;
        v_candidate_id := v_candidate.id;
      end if;
    end loop;

    if v_candidate_n = 1 then
      v_assignments := v_assignments || jsonb_build_object(
        'order_item_id', v_auto_item.id,
        'spool_id',      v_candidate_id,
        'amount_g',      v_need_g
      );
    end if;
    -- 0 oder ≥2 Kandidaten: keine Automatik, Position bleibt ggf. in der
    -- folgenden "Ohne Spulenzuordnung"-Prüfung stehen → manuelle Zuordnung.
  end loop;

  -- Jede zugeordnete Position braucht mindestens eine Spulenzuordnung
  -- (explizit ODER automatisch aus 3b).
  select string_agg(i::text, ', ') into v_missing
  from unnest(v_item_ids) as i
  where not exists (
    select 1 from jsonb_array_elements(v_assignments) e
    where (e->>'order_item_id')::uuid = i
  );

  if v_missing is not null then
    raise exception 'Ohne Spulenzuordnung: Bestellposition(en) % — der Auftrag startet nur, wenn jede zugeordnete Position eine Spulenwahl hat (automatisch nur bei eindeutiger Farbe möglich, siehe 00182)',
      v_missing
      using errcode = 'check_violation';
  end if;

  -- 4. production_batch_items je Position -----------------------------------
  for v_idx in 1 .. array_length(v_item_ids, 1) loop
    insert into production_batch_items (production_order_id, order_item_id, qty_planned)
    select p_production_order_id, oi.id, oi.qty
    from order_items oi
    where oi.id = v_item_ids[v_idx]
    returning id into v_batch_id;

    v_batch_ids := v_batch_ids || v_batch_id;

    v_batch_json := v_batch_json || jsonb_build_object(
      'production_batch_item_id', v_batch_id,
      'order_item_id',            v_item_ids[v_idx],
      'qty_planned',              (select oi.qty from order_items oi where oi.id = v_item_ids[v_idx])
    );
  end loop;

  -- 5. Reservierungen (Sperrstrategie siehe Kommentar in 00143) --------------
  for v_assign in
    select (e->>'order_item_id')::uuid as order_item_id,
           (e->>'spool_id')::uuid      as spool_id,
           (e->>'amount_g')::numeric   as amount_g
    from jsonb_array_elements(v_assignments) e
    order by (e->>'spool_id')::uuid, (e->>'order_item_id')::uuid   -- feste Sperrreihenfolge
  loop
    -- Sperre auf die Spule; erst danach summieren (#5) — gilt identisch für
    -- automatisch vorausgewählte Spulen: die Vorauswahl in 3b war ungesperrt,
    -- erst hier wird verbindlich geprüft/gebucht.
    perform 1 from filament_spools s
    where s.id = v_assign.spool_id
    for update;

    -- Restbestand = initial_weight_g + Σ movements.amount_g
    select s.initial_weight_g + coalesce((
             select sum(m.amount_g) from filament_movements m where m.spool_id = s.id
           ), 0)
      into v_rest
    from filament_spools s
    where s.id = v_assign.spool_id;

    -- Verfügbar = Restbestand − Σ aktive Reservierungen
    select coalesce(sum(r.amount_g), 0) into v_reserved
    from filament_reservations r
    where r.spool_id = v_assign.spool_id
      and r.status = 'aktiv';

    v_available := v_rest - v_reserved;

    -- alles-oder-nichts je Zuordnung; Fehlschlag → Gesamt-Rollback
    if v_available < v_assign.amount_g then
      raise exception 'Spule %: nicht genug Filament für Bestellposition % — benötigt % g, verfügbar % g (Restbestand % g, davon % g bereits reserviert). Produktionsauftrag % wurde NICHT gestartet.',
        v_assign.spool_id, v_assign.order_item_id, v_assign.amount_g,
        v_available, v_rest, v_reserved, p_production_order_id
        using errcode = 'check_violation';
    end if;

    v_batch_id := v_batch_ids[array_position(v_item_ids, v_assign.order_item_id)];

    insert into filament_reservations
      (spool_id, order_item_id, production_batch_item_id, amount_g, status)
    values
      (v_assign.spool_id, v_assign.order_item_id, v_batch_id, v_assign.amount_g, 'aktiv')
    returning id into v_reservation;

    -- filament-material.md §4: jeder Reservierungsübergang mit Audit-Eintrag
    insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
    values ('filament_reservation', v_reservation, 'status_change', 'status', null, 'aktiv', v_actor);

    v_res_json := v_res_json || jsonb_build_object(
      'reservation_id',           v_reservation,
      'order_item_id',            v_assign.order_item_id,
      'production_batch_item_id', v_batch_id,
      'spool_id',                 v_assign.spool_id,
      'amount_g',                 v_assign.amount_g
    );
  end loop;

  -- 6. Auftrag: Geplant → Laeuft, Startzeit mit übernehmen (00181) -----------
  update production_orders
  set status        = 'Laeuft',
      actual_start  = v_now,
      planned_start = coalesce(planned_start, v_now),
      updated_at    = v_now
  where id = p_production_order_id;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, actor)
  values ('production_order', p_production_order_id, 'status_change', 'status', 'Geplant', 'Laeuft', v_actor);

  -- 7. Übersicht -------------------------------------------------------------
  return jsonb_build_object(
    'production_order_id', p_production_order_id,
    'status',              'Laeuft',
    'actual_start',        v_now,
    'batch_items',         v_batch_json,
    'reservations',        v_res_json
  );
end;
$$;

revoke all on function fn_start_production_order(uuid, jsonb) from public;
revoke all on function fn_start_production_order(uuid, jsonb) from anon;
grant execute on function fn_start_production_order(uuid, jsonb) to authenticated;
