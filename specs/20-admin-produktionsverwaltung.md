# Admin: Produktionsverwaltung

**Datenquelle:** fn_create_production_order, fn_assign_to_production,
fn_start_production_order, fn_complete_order_item, fn_complete_production_order,
fn_fail_production_order

**Elemente:**
- Liste laufender/geplanter Produktionsaufträge, Status (Geplant → Läuft →
  Abgeschlossen/Fehlgeschlagen)
- Detailansicht: zugeordnete Bestellpositionen als Batch-Items, Ist-Verbrauch
  erfassen
- Produktionsstart löst Filamentreservierung erst hier aus (Zwei-Schritte-Prinzip:
  Zuordnung ≠ Reservierung)
- Bei Teilausfall: Auftrag bleibt "Läuft", Nachproduktions-Item als weiteres
  Batch-Item im selben Auftrag — kein Auto-Abschluss
- Spulenwahl nur sichtbar, wenn Admin-Parameter #18 das erlaubt

**Best Practice:** fn_fail_production_order mit Pflichtgrund-Feld, analog zur
Stornierung — Nachvollziehbarkeit für spätere Kalkulationsgenauigkeit
