-- 00201: fn_get_order_by_token liefert zusätzlich das Bestelldatum
-- (orders.created_at) für die Sendungsverfolgung im Storefront.
-- Entscheidung 2026-11-14 (Review B19, specs/18 §8).
-- Funktion sonst unverändert gegenüber 00194 (gleiche Prüfungen,
-- Preis-Sichtbarkeit über fn_prices_visible_to_caller, gleiche Positionen).

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
  v_show_prices boolean := fn_prices_visible_to_caller();
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
           'created_at',          o.created_at,
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
             'final_price', case when v_show_prices then cv.final_price end
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
