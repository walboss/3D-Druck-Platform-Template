# Spec: Produktdaten-Import aus 3mf-Dateien

**Status: geplant.** Unabhängig von `drucker-integration-bambu.md` (verschoben) — braucht keinen Live-Zugriff auf den Drucker, nur das Einlesen einer lokalen Datei. Kann umgesetzt werden, ohne auf die Live-Integration zu warten.

---

## 1. Zweck

Beim Anlegen eines neuen Produkts/einer neuen Variante das manuelle Wiegen/Stoppen teilweise ersetzen: Die von MakerWorld heruntergeladene bzw. in Bambu Studio erzeugte `.gcode.3mf`-Projektdatei enthält bereits Gewichts- und Druckzeitschätzungen, die sich auslesen lassen.

---

## 2. Technische Grundlage

Eine geslicte `.gcode.3mf`-Datei ist ein ZIP-Archiv und enthält in `Metadata/slice_info.config` (XML) den vom Slicer berechneten Filamentverbrauch je Farbe/AMS-Fach in Gramm sowie die geschätzte Druckzeit je Plattform. Da laut Ausgangslage 99 % der Modelle von MakerWorld stammen und dort meist ein fertiges Bambu-Studio-Projekt mitgeliefert wird, deckt das die meisten Fälle ab.

Reines Datei-Parsing — kein Netzwerkzugriff auf den Drucker, keine Abhängigkeit von der inoffiziellen MQTT-Umgehung, kein Firmware-Risiko.

---

## 3. Ablauf

1. Admin lädt beim Anlegen eines Produkts/einer Variante die zugehörige `.gcode.3mf`-Datei hoch.
2. System liest `slice_info.config` aus: Gewicht je Farbe/Filament-Slot, geschätzte Gesamtdruckzeit der Plattform.
3. Werte werden dem Admin als **Vorschlag** angezeigt, nicht automatisch übernommen — Admin bestätigt oder korrigiert, dann wird ganz normal in `variant_parts`/`product_variants` geschrieben (`produkte-varianten-farben.md`), exakt wie bei manueller Eingabe. **Keine Schema-Änderung an Kern-Tabellen nötig.**

---

## 4. Tabelle

### `product_slice_imports` (Herkunftsnachweis, optional)
| Feld | Hinweis |
|---|---|
| id PK | |
| product_variant_id | FK → `product_variants` *(Definition: `produkte-varianten-farben.md`)* |
| source_filename | |
| imported_at | |
| raw_filament_usage | JSON, unveränderte Rohwerte aus `slice_info.config` — Nachvollziehbarkeit, falls sich der Admin-Wert später von der Slice-Datei unterscheidet |

---

## 5. Randfälle

- Der Filamentverbrauch aus `slice_info.config` ist **je Farbe/Slot**, nicht zwingend je benanntem Produktteil (`product_parts`). Teilen sich zwei Teile dieselbe Farbe auf derselben Plattform, liefert die Datei nur die Summe — die Aufteilung auf einzelne Teile bleibt in dem Fall manuelle Admin-Arbeit.
- Die Gesamtdruckzeit ist ebenfalls nur pro Plattform verfügbar, nicht je Teil — passt aber direkt zu `product_variants.print_time_min` als Summenwert.
- Nicht jedes MakerWorld-Modell liefert eine fertige `.gcode.3mf` (manche nur STL) — für diese Fälle bleibt die manuelle Eingabe der reguläre Weg, dieses Feature ist eine Erleichterung, keine Voraussetzung.

---

## 6. Nicht-Ziele

- Keine Live-Verbindung zum Drucker, kein AMS-Abgleich, keine automatische Verbrauchserfassung während/nach einem Druck — das bleibt in `drucker-integration-bambu.md` (verschoben).
- Kein automatisches Übernehmen der Werte ohne Admin-Bestätigung.

---

## 7. Abhängigkeiten

- Setzt `product_variants`, `product_parts`, `variant_parts` aus `produkte-varianten-farben.md` voraus (Ziel der importierten Werte).
- Keine Abhängigkeit von `filament-material.md`, `produktion.md` oder `drucker-integration-bambu.md`.
