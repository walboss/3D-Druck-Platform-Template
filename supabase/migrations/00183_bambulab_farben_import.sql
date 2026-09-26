-- Migration 00183: Bambu Lab Filamentfarben-Import (bambulab_filamentfarben_v3.csv)
-- specs/filament-material.md §2
--
-- Import von 11 tatsächlich vorhandenen Bambu-Lab-Spulen (Farbe, Material,
-- Oberfläche, gewogenes Restgewicht, Lagerort) aus einer vom Nutzer
-- gelieferten CSV. Rückfragen dazu wurden im Chat geklärt:
--
-- 1. Standort (AMS/Lager) existierte in keiner Tabelle -- neue Spalte
--    filament_spools.location (Nutzer-Entscheidung: Spalte anlegen statt
--    Info zu verwerfen).
-- 2. Bambu-eigener Farbcode (z. B. 10301) existierte in keiner Tabelle --
--    neue Spalte filament_products.manufacturer_color_code (Nutzer-
--    Entscheidung: eigene Spalte statt in product_name zu quetschen oder
--    zu verwerfen).
-- 3. CSV-Zeile "Lila" (#5E43B7) kollidierte im Namen mit der generischen
--    Platzhalterfarbe "Lila" (#8E44AD) aus Migration 00166 -- Nutzer-
--    Entscheidung: bestehenden Datensatz auf den neuen Hex-Wert anpassen.
-- 4. purchase_price, purchase_date, tare_weight_g sind laut
--    specs/filament-material.md §2 Pflichtfelder auf filament_spools,
--    standen aber nicht in der CSV -- Nutzer-Entscheidung: Platzhalter
--    setzen (purchase_price = 0, purchase_date = heute,
--    tare_weight_g = angenommene Bambu-Standardspule), echte Werte
--    liefert der Nutzer später nach. ACHTUNG: tare_weight_g = 250 ist
--    KEIN verifizierter Herstellerwert, sondern eine grobe Annahme.
--
-- CSV-Farbnamen wurden für Umlaute normalisiert (z. B. "Jade-Weiss" ->
-- "Jade-Weiß"), sonst unverändert übernommen.

alter table filament_products
  add column manufacturer_color_code text;

alter table filament_spools
  add column location text;

-- Nutzer-Entscheidung 3: bestehende Platzhalterfarbe "Lila" auf den
-- tatsächlichen Bambu-Lab-Hexwert anpassen.
update colors
set hex = '#5E43B7'
where name = 'Lila';

insert into colors (name, hex)
select v.name, v.hex
from (values
  ('Kürbis-Orange',      '#FF9016'),
  ('Jade-Weiß',          '#FFFFFF'),
  ('Marineblau',         '#0078BF'),
  ('Kohlschwarz',        '#000000'),
  ('Elfenbeinweiß',      '#FFFFFF'),
  ('Sakura-Pink',        '#E8AFCF'),
  ('Nardo-Grau',         '#757575'),
  ('Milchkaffee-Braun',  '#D3B7A7'),
  ('Dunkelgrün',         '#68724D')
) as v(name, hex)
where not exists (
  select 1 from colors c where c.name = v.name
);

with csv (material, farbname, farbcode, finish_name) as (
  values
    ('PLA Basic', 'Kürbis-Orange',     '10301', 'Glänzend'),
    ('PLA Basic', 'Jade-Weiß',         '10100', 'Glänzend'),
    ('PLA Basic', 'Lila',              '10700', 'Glänzend'),
    ('PLA Basic', 'Schwarz',           '10101', 'Glänzend'),
    ('PLA Matte', 'Marineblau',        '11600', 'Matt'),
    ('PLA Matte', 'Kohlschwarz',       '11101', 'Matt'),
    ('PLA Matte', 'Elfenbeinweiß',     '11100', 'Matt'),
    ('PLA Matte', 'Sakura-Pink',       '11201', 'Matt'),
    ('PLA Matte', 'Nardo-Grau',        '11104', 'Matt'),
    ('PLA Matte', 'Milchkaffee-Braun', '11800', 'Matt'),
    ('PLA Matte', 'Dunkelgrün',        '11501', 'Matt')
)
insert into filament_products
  (manufacturer, product_name, material, color_id, finish_id, diameter_mm, manufacturer_color_code)
select
  'Bambu Lab',
  csv.material || ' ' || csv.farbname,
  csv.material,
  col.id,
  fin.id,
  1.75,
  csv.farbcode
from csv
join colors col on col.name = csv.farbname
join finishes fin on fin.name = csv.finish_name
where not exists (
  select 1 from filament_products fp
  where fp.manufacturer = 'Bambu Lab'
    and fp.manufacturer_color_code = csv.farbcode
);

with csv (farbcode, weight_g, location) as (
  values
    ('10301', 620,  'AMS'),
    ('10100', 67,   'AMS'),
    ('10700', 1000, 'AMS'),
    ('10101', 1000, 'Lager'),
    ('11600', 50,   'AMS'),
    ('11101', 660,  'AMS'),
    ('11100', 590,  'AMS'),
    ('11201', 850,  'AMS'),
    ('11104', 1000, 'Lager'),
    ('11800', 1000, 'Lager'),
    ('11501', 1000, 'Lager')
)
insert into filament_spools
  (filament_product_id, purchase_price, initial_weight_g, tare_weight_g, purchase_date, location)
select
  fp.id,
  0,
  csv.weight_g,
  250,
  current_date,
  csv.location
from csv
join filament_products fp
  on fp.manufacturer = 'Bambu Lab'
 and fp.manufacturer_color_code = csv.farbcode
where not exists (
  select 1 from filament_spools fs
  where fs.filament_product_id = fp.id
);
