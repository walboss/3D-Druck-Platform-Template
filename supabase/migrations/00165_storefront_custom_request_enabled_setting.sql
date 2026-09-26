-- Migration 00165: Individualanfrage im Storefront per Admin-Setting steuerbar
-- specs/audit-settings.md §2 (settings), §3 (#16 — globaler Schalter, an
-- keiner Stelle Voraussetzung für einen Kernprozess).
--
-- Neues Feld settings.storefront_custom_request_enabled, Default false: die
-- freiformige Individualanfrage (eigenes/fremdes Modell beschreiben) wird
-- vorerst durch die katalogbasierte Anfrageliste (Warenkorb/Kasse-Flow,
-- Migration 00164) ersetzt. Später unabhängig davon wieder aktivierbar.
--
-- fn_get_public_settings() (00163/00164) um dieses dritte Flag erweitert.

alter table settings
  add column storefront_custom_request_enabled boolean not null default false;

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
           'storefront_custom_request_enabled',  s.storefront_custom_request_enabled
         )
    into v_result
  from settings s
  limit 1;

  return coalesce(
    v_result,
    jsonb_build_object(
      'storefront_prices_visible', false,
      'storefront_shop_enabled', false,
      'storefront_custom_request_enabled', false
    )
  );
end;
$$;

revoke all on function fn_get_public_settings() from public;
grant execute on function fn_get_public_settings() to anon, authenticated;
