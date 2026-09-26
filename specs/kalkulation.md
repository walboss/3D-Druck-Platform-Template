# Spec: Kalkulation

Siehe `00-overview.md` für Architekturprinzipien (referenziert als #-Nummer) und FK-Reihenfolge.

---

## 1. Zweck

Versionierte Preis-/Kostenberechnung für Produktvarianten und individuelle Angebote — jede Änderung erzeugt eine neue, unveränderliche Version, damit alte Bestellungen sich nie rückwirkend durch neue Preise ändern (#9).

---

## 2. Tabelle

### `calculation_versions`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| scope_type | enum | `product_variant`, `offer_item` |
| scope_id | uuid | worauf sich diese Version bezieht |
| version_no | int | fortlaufend je scope |
| reason | enum | `kundenwunsch`, `admin_korrektur`, `falsche_variante`, `sonstiger_grund` — Pflicht bei Änderung |
| filament_cost, energy_cost, machine_cost, labor_cost, packaging_cost, license_cost, scrap_allowance, other_cost, total_cost | numeric | **kopierte Werte**, keine Live-Referenzen auf aktuelle Preise; kaufmännisch auf 2 Nachkommastellen gerundet. Eingabe als `cost_components`-jsonb: fehlender Schlüssel → 0, unbekannter Schlüssel → Fehler (Tippschutz) |
| margin_percent | numeric | Aufschlag auf die Kosten — kein Anteil am Verkaufspreis |
| min_price | numeric | roh `total_cost * (1 + margin_percent/100)`, kaufmännisch auf 2 Nachkommastellen gerundet |
| calculated_price | numeric | `min_price`, aufgerundet auf nächsten .49-/.99-Endpreis (#29) — dadurch strukturell immer `calculated_price >= min_price` |
| final_price | numeric | ggf. manuell überschrieben — **beide Werte bleiben erhalten** |
| is_current | bool | nur für `product_variant`-Scope, zeigt aktuell gültigen Katalogpreis |
| created_by, created_at | | |

---

## 3. Geschäftsregeln

- Kalkulationen werden versioniert (#8) — jede Änderung ist ein neuer `INSERT`, nie ein `UPDATE` bestehender Zeilen.
- `order_items.calculation_version_id` (siehe `bestellungen.md`) verweist immer auf eine konkrete, unveränderliche Version — Preisänderungen am Produkt erzeugen neue Versionen, alte Bestellungen bleiben unberührt (#9).
- Alle Kostenkomponenten sind **Kopien zum Zeitpunkt der Berechnung**, keine Fremdschlüssel auf aktuelle Filament-/Lizenzpreise — das ist strukturell, nicht nur eine Konvention, entscheidend für #9.
- `margin_percent` ist ein Aufschlag auf die Kosten (`min_price = total_cost * (1 + margin_percent/100)`), kein Anteil am Verkaufspreis.
- `total_cost` und die einzelnen Kostenkomponenten sowie `min_price` werden kaufmännisch auf 2 Nachkommastellen gerundet; nur `calculated_price` bekommt zusätzlich die .49-/.99-Aufrundung.
- Im `cost_components`-jsonb führt ein fehlender Schlüssel zu 0, ein unbekannter Schlüssel (z. B. Tippfehler) zu einem Fehler — eine Kostenkomponente darf nie stillschweigend als 0 verschluckt werden.
- Verkaufspreise werden immer auf den nächsthöheren .49- oder .99-Endpreis aufgerundet, nie abgerundet, damit Mindestpreis/Marge nicht unterschritten werden (#29). Dadurch gilt strukturell `calculated_price >= min_price`.
- `final_price` kann manuell vom `calculated_price` abweichen (Admin-Korrektur) — beide Werte werden dauerhaft gespeichert, nicht überschrieben.
- Jede Änderung an einem Angebot (siehe `angebote-individuelle-anfragen.md`) erzeugt eine neue Version mit Pflichtangabe `reason` (#27).

---

## 4. Statusübergänge

Kein mehrstufiger Status — `is_current` ist das einzige veränderliche Flag, ausschließlich bei `scope_type='product_variant'` relevant: Beim Anlegen einer neuen Version wird die vorherige `is_current`-Zeile desselben `scope_id` auf `false` gesetzt, die neue auf `true`. Beide Zeilen bleiben bestehen (#1).

---

## 5. Randfälle

- **Tatsächliche vs. kalkulierte Kosten:** Kein eigenes Snapshot-Feld für "tatsächliche Kosten" — diese leiten sich zur Auswertungszeit aus `production_material_usage` + `filament_movements` + `production_batch_items.qty_scrap_*` (siehe `produktion.md`) ab. Vermeidet eine zweite Wahrheit neben `calculation_versions`.
- **Mehrere `offer_items` derselben Angebotsänderung:** Jede Position bekommt ihre eigene `calculation_versions`-Zeile, auch wenn mehrere Positionen im selben Änderungsschritt neu berechnet wurden — keine gemeinsame "Änderungs-Transaktion" als Entität.
- **Rundung führt zu Preis unter `min_price`:** Darf laut Regel nicht vorkommen (immer aufrunden) — falls doch, ist das ein Berechnungsfehler in der Anwendungslogik, kein Datenmodellfall.

---

## 6. Abhängigkeiten

- Wird referenziert von `bestellungen.md` (`order_items.calculation_version_id`) und `angebote-individuelle-anfragen.md` (`offer_items.calculation_version_id`).
- Bezieht sich inhaltlich auf `filament-material.md` (Materialkosten), `produktion.md` (Maschinen-/Arbeitszeit), `lizenzen.md` (Lizenzkosten) — jeweils nur als kopierte Werte, keine FK-Abhängigkeit.

---

## 7. Nicht Teil dieser Spec

- Wie der Filamentpreis pro Gramm oder die Maschinenstundensätze aktuell ermittelt werden — Quellwerte kommen aus `filament-material.md`/`produktion.md`, hier nur als Kopie gespeichert.
- Lizenzkosten-Modell im Detail — siehe `lizenzen.md`.
- UI/Formel für die konkrete Berechnung (Marge-Prozentsätze, Rundungsalgorithmus) — Anwendungslogik, hier nur die Datenstruktur.
