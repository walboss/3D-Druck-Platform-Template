-- Migration 00194: Privatmodus — Preise auch in der API ausblenden
--
-- Befund Security-Check 2026-09-25 (Entscheidung Betreiber 2026-09-25: "sperren"):
-- Bei settings.storefront_prices_visible = false (Privatmodus,
-- specs/privatmodus-schalter.md) waren Preise nur im Frontend ausgeblendet.
-- v_catalog, fn_get_order_by_token und fn_get_offer_by_token lieferten
-- final_price trotzdem an anon aus (mit dem öffentlichen Anon-Key von außen
-- abfragbar).
--
-- Neu: fn_prices_visible_to_caller() = Schalter an ODER Aufrufer ist Admin.
-- v_catalog und beide Token-Funktionen liefern final_price sonst als NULL.
-- Spalten/Rückgabeformat bleiben gleich (Frontend blendet Preise im
-- Privatmodus ohnehin aus). Funktionskörper sonst unverändert aus 00149,
-- View unverändert aus 00150; Grants bleiben bei create or replace erhalten.

create or replace function public.fn_prices_visible_to_caller()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select s.storefront_prices_visible from settings s limit 1), false)
      or public.fn_is_admin();
$$;

comment on function public.fn_prices_visible_to_caller() is
  'true, wenn Preise für den Aufrufer sichtbar sein dürfen: storefront_prices_visible oder Admin (Migration 00194).';

revoke execute on function public.fn_prices_visible_to_caller() from public;
grant execute on function public.fn_prices_visible_to_caller() to anon, authenticated, service_role;

create or replace view v_catalog as
select
  p.id          as product_id,
  p.name,
  p.description,
  p.category,
  p.tags,
  p.images,
  pv.id         as variant_id,
  pv.size_label,
  pv.min_qty,
  pv.max_qty,
  pv.step_qty,
  case when (select public.fn_prices_visible_to_caller()) then cv.final_price end as final_price
from products p
join product_variants pv
  on pv.product_id = p.id
 and pv.active = true
left join calculation_versions cv
  on cv.scope_type = 'product_variant'
 and cv.scope_id   = pv.id
 and cv.is_current = true
where p.active = true;

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
  v_show_prices boolean := fn_prices_visible_to_caller();
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
             'final_price',                 case when v_show_prices then cv.final_price end
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
