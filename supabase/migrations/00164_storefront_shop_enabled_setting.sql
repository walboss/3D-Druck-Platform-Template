-- Migration 00164: Warenkorb/Kasse im Storefront per Admin-Setting steuerbar
-- specs/audit-settings.md §2 (settings), §3 (#16 — globaler Schalter, an
-- keiner Stelle Voraussetzung für einen Kernprozess).
--
-- Neues Feld settings.storefront_shop_enabled, Default false: aktuell nur
-- eine Modell-Übersicht mit MakerWorld-Verlinkung + formloser Anfrage
-- (Individualanfrage/Angebot/Tracking bleiben unabhängig davon nutzbar),
-- kein öffentlicher Selbstbedienungs-Checkout. Später bei Bedarf per
-- Admin-Schalter aktivierbar, ohne Code-Änderung.
--
-- fn_get_public_settings() (00163) um dieses zweite Flag erweitert — bleibt
-- die einzige öffentliche, schmale Sicht auf settings.

alter table settings
  add column storefront_shop_enabled boolean not null default false;

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
           'storefront_prices_visible', s.storefront_prices_visible,
           'storefront_shop_enabled',   s.storefront_shop_enabled
         )
    into v_result
  from settings s
  limit 1;

  return coalesce(
    v_result,
    jsonb_build_object('storefront_prices_visible', false, 'storefront_shop_enabled', false)
  );
end;
$$;

revoke all on function fn_get_public_settings() from public;
grant execute on function fn_get_public_settings() to anon, authenticated;
