-- Migration 00184: Doppelte Weiß-/Schwarz-Farben zusammenfassen
-- specs/produkte-varianten-farben.md §2, specs/filament-material.md §2
--
-- Aus Migration 00183 entstanden zwei separate Weiß-Farben ("Jade-Weiß",
-- glänzend/PLA Basic, und "Elfenbeinweiß", matt/PLA Matte -- beide
-- #FFFFFF) sowie zwei separate Schwarz-Farben ("Schwarz", glänzend, und
-- "Kohlschwarz", matt -- beide #000000). Im Storefront-Farbwähler
-- erschien dadurch "Weiß" zweimal (je einmal pro Oberfläche), statt
-- einmal mit beiden Oberflächen wählbar (Kundenmeldung, Chat vom
-- 2026-09-24).
--
-- Farbe (colors) und Oberfläche (finishes) sind laut
-- produkte-varianten-farben.md zwei unabhängige Achsen -- color_id soll
-- die visuell gleiche Farbe repräsentieren, unabhängig vom Finish. Fix:
-- filament_products, die auf "Jade-Weiß"/"Elfenbeinweiß" zeigten, zeigen
-- jetzt auf die schon existierende generische Farbe "Weiß"; analog
-- "Kohlschwarz" auf "Schwarz". product_name (z. B. "PLA Basic
-- Jade-Weiß") bleibt unverändert -- das ist die interne Bezeichnung der
-- konkreten Bambu-Lab-SKU, nicht die kundenseitige Farbe.
--
-- Die jetzt ungenutzten Farbeinträge werden laut Prinzip #2 nicht
-- gelöscht, sondern deaktiviert (active = false) -- dadurch fallen sie
-- automatisch aus fn_get_public_stock_options (00171 filtert auf
-- c.active), ohne dass Frontend/View-Code angefasst werden muss.

update filament_products fp
set color_id = w.id
from colors w
where w.name = 'Weiß'
  and fp.color_id in (
    select id from colors where name in ('Jade-Weiß', 'Elfenbeinweiß')
  );

update filament_products fp
set color_id = b.id
from colors b
where b.name = 'Schwarz'
  and fp.color_id in (
    select id from colors where name = 'Kohlschwarz'
  );

update colors
set active = false
where name in ('Jade-Weiß', 'Elfenbeinweiß', 'Kohlschwarz');
