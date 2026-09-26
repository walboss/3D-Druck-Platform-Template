-- Migration 00166: filament_products ohne Temperatur-/Profilfelder, Farben-Seed
-- specs/filament-material.md §2, specs/filament-bibliothek-neuanlage.md
--
-- Druck-/Betttemperatur und Druckprofil sind im Slicer hinterlegt und werden
-- in der Filament-Neuanlage nicht mehr erfasst (Admin-Entscheidung) — Spalten
-- print_temp_c, bed_temp_c, print_profile ersatzlos entfernt.
--
-- Zusätzlich Basis-Set an Farben für die Hersteller-Freitext-Vorschläge
-- (Bambulab/Jayo) in filament_products.color_id — Hex-Werte sind generische
-- Platzhalter, keine verifizierten Hersteller-Farbcodes.

alter table filament_products
  drop column print_temp_c,
  drop column bed_temp_c,
  drop column print_profile;

insert into colors (name, hex)
select v.name, v.hex
from (values
  ('Schwarz', '#000000'),
  ('Weiß',    '#FFFFFF'),
  ('Orange',  '#FF6A00'),
  ('Pink',    '#FF2D7A'),
  ('Braun',   '#7B4A2D'),
  ('Gelb',    '#FFD400'),
  ('Lila',    '#8E44AD')
) as v(name, hex)
where not exists (
  select 1 from colors c where c.name = v.name
);
