# Admin: Settings

**Datenquelle:** settings (genau eine Zeile)

**Elemente:**
- Formular mit allen Feldern: Strompreis/kWh, Standard-Stundensatz,
  Kundendaten-Aufbewahrungsfrist, E-Mail-System an/aus, Mindestbestellwert
- Kein Anlegen/Löschen möglich — nur Update der einen Zeile

**Best Practice:** Änderungen an Settings mit Audit-Log-Eintrag versehen
(fn_write_audit bereits vorhanden) — Preisparameter-Änderungen nachvollziehbar
