-- Migration 00175: Automatische Erstkalkulation beim Anlegen einer Variante
-- Entscheidung 2026-09-20 (Betreiber):
-- - Filamentkosten = Variantengewicht (weight_g) * Durchschnittspreis/Gramm
--   ueber alle aktiven filament_spools/filament_products (kein Standard-
--   Filament pro Produkt -- Farbwahl bleibt Kundensache, Prinzip #10).
-- - Maschinenkosten = Druckzeit (print_time_min) * settings.machine_hourly_rate
--   (neu, Startwert 0,40 EUR/h fuer Bambu Lab X2D -- grobe Kalkulation
--   Abschreibung+Wartung+Strom, vom Nutzer bestaetigt, in Einstellungen
--   spaeter anpassbar).
-- - Ausloeser: AFTER INSERT auf product_variants, ruft
--   fn_create_calculation_version auf (kalkulation.md, Migration 00145) --
--   dieselbe Versionierung/Rundung wie beim manuellen Anlegen im
--   Kalkulations-Dialog. Margin 20% (UI-Default), reason='sonstiger_grund'
--   (System-generiert, kein Admin-Grund aus der Liste passt).
-- - Nur Vorschlag/Startpunkt: Admin kann jederzeit im Kalkulations-Dialog
--   eine neue Version mit korrigierten Werten anlegen (ueberschreibt
--   is_current, alte Version bleibt erhalten, #8/#9).
-- - Nur bei INSERT, nicht bei UPDATE -- "beim Anlegen", nicht bei
--   nachtraeglicher Gewichts-/Druckzeitaenderung.
-- - Keine Energie-/Arbeitskosten hier: settings.electricity_price_per_kwh und
--   default_labor_rate_per_hour existieren zwar schon (Migration 0001), aber
--   nicht Teil dieser Entscheidung -- nur Filament- und Maschinenkosten aus
--   Gewicht/Druckzeit wie bestaetigt.

alter table settings
  add column machine_hourly_rate numeric not null default 0;

update settings set machine_hourly_rate = 0.40;

-- ---------------------------------------------------------------------------
-- fn_auto_calculate_new_variant() -- Trigger-Funktion
-- ---------------------------------------------------------------------------
create or replace function fn_auto_calculate_new_variant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price_per_gram numeric;
  v_machine_rate    numeric;
  v_filament_cost   numeric;
  v_machine_cost    numeric;
  v_actor           text := coalesce(auth.uid()::text, 'system');
begin
  select avg(fs.purchase_price / nullif(fs.initial_weight_g - fs.tare_weight_g, 0))
  into v_price_per_gram
  from filament_spools fs
  join filament_products fp on fp.id = fs.filament_product_id
  where fs.active and fp.active;

  select s.machine_hourly_rate into v_machine_rate from settings s limit 1;

  v_filament_cost := coalesce(v_price_per_gram, 0) * coalesce(new.weight_g, 0);
  v_machine_cost  := coalesce(v_machine_rate, 0) * (coalesce(new.print_time_min, 0) / 60.0);

  perform fn_create_calculation_version(
    'product_variant',
    new.id,
    jsonb_build_object('filament_cost', v_filament_cost, 'machine_cost', v_machine_cost),
    20,
    'sonstiger_grund',
    v_actor
  );

  return new;
end;
$$;

create trigger trg_auto_calculate_new_variant
  after insert on product_variants
  for each row
  execute function fn_auto_calculate_new_variant();
