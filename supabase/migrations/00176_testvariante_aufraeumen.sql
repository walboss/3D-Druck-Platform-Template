-- Migration 00176: Testvariante aus Verifikation von Migration 00175 entfernen
-- Beim Live-Test des Auto-Kalkulation-Triggers (00175) wurde am Produkt
-- "Deko Pilz Herbst" testweise eine Variante "Test-Auto" angelegt, um den
-- Trigger zu pruefen. Reine Aufraeumung der Testdaten, keine Schema-Aenderung.

delete from calculation_versions cv
using product_variants pv, products p
where cv.scope_type = 'product_variant'
  and cv.scope_id = pv.id
  and pv.product_id = p.id
  and p.name = 'Deko Pilz Herbst'
  and pv.size_label = 'Test-Auto';

delete from product_variants pv
using products p
where pv.product_id = p.id
  and p.name = 'Deko Pilz Herbst'
  and pv.size_label = 'Test-Auto';
