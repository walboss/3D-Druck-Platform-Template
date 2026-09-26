-- Migration 00172: Wunschliste (Warenkorb/Kasse-Flow) aktivieren, Preise bleiben aus
-- Entscheidung 2026-09-20 (Betreiber): storefront_shop_enabled und
-- storefront_prices_visible sind zwei unabhängige Spalten (specs/
-- privatmodus-schalter.md §2) -- die Admin-Oberfläche fasst sie seit
-- Commit ff00db1 versehentlich zu einem einzigen Schalter zusammen
-- (immer gemeinsam gesetzt), wodurch der eigentlich gewünschte Zustand
-- "Wunschliste an, Preise aus" über die UI gar nicht mehr erreichbar war.
-- Diese Migration setzt den Zustand direkt (kein Admin-Login/2FA nötig),
-- derselbe Commit trennt die beiden Schalter in der Admin-UI wieder
-- (admin-settings.ts/.html, kein Schema-Change, daher keine eigene
-- Migration dafür).

do $$
declare
  v_settings_id uuid;
  v_old         boolean;
begin
  select id, storefront_shop_enabled into v_settings_id, v_old from settings limit 1;

  update settings set storefront_shop_enabled = true where id = v_settings_id;

  if v_old is distinct from true then
    perform fn_write_audit(
      'settings', v_settings_id, 'update', 'storefront_shop_enabled',
      v_old::text, 'true', 'Migration 00172 (Betreiber-Entscheidung 2026-09-20)', 'system'
    );
  end if;
end;
$$;
