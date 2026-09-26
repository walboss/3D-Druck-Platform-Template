-- Migration 00163: Preisanzeige im Storefront per Admin-Setting steuerbar
-- specs/audit-settings.md §2 (settings), §3 (#16 — globaler Schalter, an
-- keiner Stelle Voraussetzung für einen Kernprozess), specs/25-admin-settings.md.
--
-- Neues Feld settings.storefront_prices_visible, Default false (passend zum
-- aktuellen Zustand: Preisanzeige im Storefront ist vorläufig ausgeblendet,
-- bis die automatische Kalkulation fertig ist).
--
-- settings bleibt admin-only (00149: admin_select_settings/admin_update_settings
-- nur für authenticated) — für den anonymen Storefront-Zugriff daher eine
-- eigene, schmale SECURITY DEFINER Funktion, die ausschließlich dieses eine
-- Flag zurückgibt, keine internen Kostenfelder (audit-settings.md §3: interne
-- Felder nur für Admins lesbar).

alter table settings
  add column storefront_prices_visible boolean not null default false;

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
           'storefront_prices_visible', s.storefront_prices_visible
         )
    into v_result
  from settings s
  limit 1;

  return coalesce(v_result, jsonb_build_object('storefront_prices_visible', false));
end;
$$;

revoke all on function fn_get_public_settings() from public;
grant execute on function fn_get_public_settings() to anon, authenticated;
