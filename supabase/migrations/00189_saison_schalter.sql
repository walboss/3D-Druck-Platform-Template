-- Migration 00189: Saison-Funktion per Admin-Setting an/aus (2026-09-24)
--
-- Explizite Adminentscheidung (Betreiber, 2026-09-24, per Chat): globaler
-- Schalter in den Settings. Aus = kein Saison-Banner, keine Saison-Kategorie
-- oben im Filter, keine Saison-Sortierung im Katalog (00187/00188). Die
-- gepflegten Zeiträume bleiben gespeichert. Default an (Funktion ist neu
-- und gewollt).
--
-- fn_get_public_settings() (00163/00164/00165) um dieses vierte Flag erweitert.

alter table settings
  add column storefront_seasons_enabled boolean not null default true;

create or replace function fn_get_public_settings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
           'storefront_prices_visible',         s.storefront_prices_visible,
           'storefront_shop_enabled',            s.storefront_shop_enabled,
           'storefront_custom_request_enabled',  s.storefront_custom_request_enabled,
           'storefront_seasons_enabled',         s.storefront_seasons_enabled
         )
    into v_result
  from settings s
  limit 1;

  return coalesce(
    v_result,
    jsonb_build_object(
      'storefront_prices_visible', false,
      'storefront_shop_enabled', false,
      'storefront_custom_request_enabled', false,
      'storefront_seasons_enabled', false
    )
  );
end;
$$;

revoke all on function fn_get_public_settings() from public;
grant execute on function fn_get_public_settings() to anon, authenticated;
