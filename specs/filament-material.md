# Spec: Filament / Material

Siehe `00-overview.md` für Architekturprinzipien (referenziert als #-Nummer) und FK-Reihenfolge.

---

## 1. Zweck

Verwaltung des Filamentbestands als konkrete, einzeln geführte Materialrollen — inklusive Referenzkatalog (Filamenttyp), Bewegungsprotokoll (tatsächlicher Verbrauch) und Reservierungen (geplanter Verbrauch bei laufender Produktion). Trennt strikt Filament-Kaufeinheit (Rolle) von Kunden-Farbwahl (siehe `produkte-varianten-farben.md`) — Prinzip #10.

---

## 2. Tabellen

### `filament_products` (Referenz-/Typkatalog)
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| manufacturer | text | |
| product_name | text | |
| material | text | z. B. PLA, PETG, ABS |
| color_id | FK → `colors` *(Definition: `produkte-varianten-farben.md`)* | |
| finish_id | FK → `finishes` *(Definition: `produkte-varianten-farben.md`)* | |
| diameter_mm | numeric | i. d. R. 1.75 |
| manufacturer_color_code | text nullable | Hersteller-eigener Farbcode (z. B. Bambu-Lab-Code), seit Migration 00183 |
| active | bool | nie löschen, Prinzip #2 |

Hinweis: `print_temp_c`, `bed_temp_c`, `print_profile` wurden mit Migration 00166 entfernt (Druck-/Betttemperatur und Druckprofil liegen im Slicer, nicht in der Filament-Neuanlage).

### `filament_spools` (konkrete Rolle = eigenes Inventarobjekt)
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| filament_product_id | FK → `filament_products` | |
| purchase_price | numeric | |
| initial_weight_g | numeric | **gewogen**, nicht Herstellerangabe |
| tare_weight_g | numeric | |
| purchase_date | date | |
| location | text nullable | Lagerort der Spule (z. B. "AMS", "Lager"), seit Migration 00183 |
| active | bool | |

### `filament_movements` (Bewegungsprotokoll)
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| spool_id | FK → `filament_spools` | |
| movement_type | enum | `einkauf`, `produktion`, `fehldruck`, `korrektur`, `sonstige` |
| amount_g | numeric | signed (± ) |
| reference_type | text nullable | z. B. `production_batch_item` |
| reference_id | uuid nullable | |
| note | text nullable | |
| created_by | text | Admin-ID oder `system:bambu_mqtt` (siehe `drucker-integration-bambu.md`, optional) |
| created_at | timestamp | |

Restbestand einer Spule = `initial_weight_g + Σ(movements.amount_g)`. Diese Summe ist die einzige Quelle der Wahrheit — kein zusätzliches `current_weight`-Feld auf `filament_spools`, um Divergenz zu vermeiden.

### `filament_reservations`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| spool_id | FK → `filament_spools` | |
| order_item_id | FK → `order_items` *(Definition: `bestellungen.md`)* | |
| production_batch_item_id | FK nullable → `production_batch_items` *(Definition: `produktion.md`)* | |
| amount_g | numeric | |
| status | enum | `aktiv`, `freigegeben`, `verbraucht` |
| created_at | timestamp | |
| released_at | timestamp nullable | |

Verfügbare Menge je Spule = Restbestand − `Σ(amount_g WHERE status='aktiv')`.

---

## 3. Geschäftsregeln

- Jede Filamentrolle ist ein eigenes Inventarobjekt mit eigener ID — keine Zusammenfassung "50 Rollen Rot PLA" als ein Datensatz.
- Anbruchgewicht wird **gewogen**, nicht aus Herstellerangaben übernommen — `initial_weight_g` ist der reale Nullpunkt für alle folgenden Bewegungen.
- Reservierung von Filament erfolgt **erst bei Produktionsstart**, nicht bei Bestellannahme (Prinzip #30) — im Gegensatz zu Fertigwarenbestand, der sofort bei Bestellbestätigung reserviert wird (siehe `fertigwarenbestand.md`).
- Reservierung ist alles-oder-nichts: keine Teilreservierung, wenn die verfügbare Menge nicht reicht.
- Die Auswahl **welche** Spule für eine Produktion verwendet wird, trifft immer der Admin manuell — kein automatischer Vorschlag/keine automatische Zuweisung (Prinzip #18).
- Korrekturbuchungen (`movement_type = 'korrektur'`) gleichen Messdrift aus (z. B. Waage ungenau, Schwund) — mit Pflichtangabe `note`, warum korrigiert wurde.
- Filamenttypen werden bei Nichtgebrauch deaktiviert (`active = false`), nie gelöscht (Prinzip #2) — auch wenn alle zugehörigen Spulen aufgebraucht sind.

---

## 4. Statusübergänge

`filament_reservations.status`:

| Von | Nach | Auslöser | Pflichtfelder |
|---|---|---|---|
| — | `aktiv` | Admin startet Produktion, wählt Spule | `amount_g`, `spool_id`, `order_item_id` |
| `aktiv` | `verbraucht` | Produktion abgeschlossen, tatsächlicher Verbrauch als `filament_movements`-Eintrag gebucht | — |
| `aktiv` | `freigegeben` | Bestellposition storniert, bevor produziert wurde | `released_at` |

Jeder Übergang erzeugt einen Audit-Log-Eintrag (siehe `audit-settings.md`) — kein isolierter Statuswert-Update (Prinzip #31).

---

## 5. Randfälle

- **Batch-Produktion über mehrere Positionen:** Verbrauch wird auf Ebene `production_batch_item` erfasst, nicht direkt auf `order_item` — eine Spule kann in einer Produktion mehrere Bestellpositionen gleichzeitig bedienen (siehe `produktion.md`).
- **Fehldruck/Totalausfall:** Der tatsächlich verbrauchte Materialanteil wird trotzdem als `filament_movements`-Eintrag gebucht (`movement_type = 'fehldruck'`) — Material ist real verbraucht, auch wenn kein verkaufbares Teil entstanden ist. Nicht zu verwechseln mit der Reservierung, die bei `verbraucht` endet.
- **Reservierte Menge übersteigt Restbestand knapp** (z. B. durch parallele Admin-Aktionen): siehe Prinzip #5 — die Prüfung "reicht die verfügbare Menge" muss transaktional/gesperrt erfolgen, nicht als zwei getrennte Schritte (erst lesen, dann schreiben).
- **Spule wird nie ganz leer gebraucht, sondern vorzeitig aussortiert** (z. B. Rolle verklebt): Restwert wird per Korrekturbuchung auf 0 gesetzt, Spule auf `active = false`.

---

## 6. Abhängigkeiten

- `produkte-varianten-farben.md` — für `colors`, `finishes` (Referenzen in `filament_products`).
- `bestellungen.md` — für `order_items` (Ziel der Reservierung).
- `produktion.md` — für `production_batch_items` (Ziel der tatsächlichen Verbrauchsbuchung).
- `audit-settings.md` — für die Protokollierung aller Statusübergänge.

---

## 7. Nicht Teil dieser Spec

- Fertigwarenbestand (fertig produzierte, verkaufsfertige Teile) — siehe `fertigwarenbestand.md`. Filament und Fertigware sind strikt getrennte Bestände (Prinzip #12).
- Kalkulation der Materialkosten (welcher Preis pro Gramm in die Preisberechnung einfließt) — siehe `kalkulation.md`. Diese Spec liefert nur die Mengen-/Bestandsseite, keine Kostenlogik.
- Automatisierte Verbrauchserfassung per Drucker-Anbindung — optional, siehe `drucker-integration-bambu.md`. Diese Spec beschreibt den manuellen Grundprozess, der davon unabhängig funktionieren muss.
- Lizenzkosten, die auf Filament- oder Produktebene anfallen — siehe `lizenzen.md`.
