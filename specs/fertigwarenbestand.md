# Spec: Fertigwarenbestand

Siehe `00-overview.md` für Architekturprinzipien (referenziert als #-Nummer) und FK-Reihenfolge.

---

## 1. Zweck

Bestand an bereits fertig produzierten, verkaufsfertigen Teilen — getrennt nach normaler Ware und B-Ware. Strikt getrennt vom Filamentbestand (#12) und von der Produktionsplanung (#3): Fertigwarenbestand ist "Realität", nicht "Plan".

---

## 2. Tabellen

### `finished_goods_movements`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| variant_configuration_id | FK → `variant_configurations` *(Definition: `produkte-varianten-farben.md`)* | |
| stock_type | enum | `normal`, `b_ware` |
| movement_type | enum | `produktion_erfolgreich`, `uebergabe`, `korrektur`, `ausschuss_umbuchung`, `sonstige` |
| qty_delta | int | signed (±) |
| reference_type / reference_id | text/uuid nullable | z. B. `order_item`, `production_batch_item` |
| created_by | text | |
| created_at | timestamp | |

### `finished_goods_reservations`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| variant_configuration_id | FK → `variant_configurations` | |
| stock_type | enum | `normal`, `b_ware` |
| order_item_id | FK → `order_items` *(Definition: `bestellungen.md`)* | |
| qty | int | |
| status | enum | `aktiv`, `freigegeben`, `verbraucht_bei_uebergabe` |
| created_at | timestamp | |
| released_at | timestamp nullable | |

Aktueller Bestand je Konfiguration/Typ = `Σ(finished_goods_movements.qty_delta)`. Verfügbar = Bestand − `Σ(reservations WHERE status='aktiv')`. Beides abgeleitet, keine eigenständigen Zählerfelder.

---

## 3. Geschäftsregeln

- Reservierung erfolgt **sofort bei Bestellbestätigung** (`orders.status = Confirmed`), nicht erst bei Produktionsstart — im Unterschied zu Filament (#30, siehe `filament-material.md`).
- Bei `Handed Over`: Reservierung wechselt zu `verbraucht_bei_uebergabe`, gleichzeitig entsteht ein `finished_goods_movements`-Eintrag `uebergabe` (negativ) — endgültige Entnahme, beide Schritte atomar (#31).
- B-Ware entsteht ausschließlich durch eine `ausschuss_umbuchung` (positiv, `stock_type='b_ware'`), deren Quelle ein Ausschuss-Eintrag in `production_batch_items` ist (siehe `produktion.md`) — getrennter, eigenständig verkaufbarer Bestandstyp.
- Fertigwaren- und Filamentbestand sind vollständig getrennte Tabellenpaare (#12) — keine gemeinsame "Lager"-Tabelle.

---

## 4. Statusübergänge

`finished_goods_reservations.status`:

| Von | Nach | Auslöser | Pflichtfelder |
|---|---|---|---|
| — | `aktiv` | `orders.status → Confirmed`, sofern Bestand verfügbar | `qty`, `variant_configuration_id`, `order_item_id` |
| `aktiv` | `verbraucht_bei_uebergabe` | `orders.status → HandedOver` | zugehöriger `finished_goods_movements`-Eintrag `uebergabe` |
| `aktiv` | `freigegeben` | Position storniert, bevor übergeben | `released_at` |

Jeder Übergang mit Audit-Log-Eintrag (`audit-settings.md`), nie isoliert (#31).

---

## 5. Randfälle

- **Nicht genug Bestand bei Bestellbestätigung:** Reservierung ist alles-oder-nichts (analog Filament) — reicht der Bestand nicht, wird die Position nicht auf `Confirmed` gesetzt, sondern bleibt in einem wartenden Zustand (siehe `bestellungen.md` für den genauen Positions-Status in diesem Fall).
- **Storno nach Produktion, vor Übergabe:** Reservierung wird `freigegeben`, die real produzierte Ware bleibt im Bestand (kein Movement rückgängig gemacht) — steht für andere Bestellungen wieder zur Verfügung.
- **B-Ware wird nachträglich wieder zu normaler Ware erklärt:** nicht vorgesehen im MVP — B-Ware-Umbuchung ist einseitig (normal/Ausschuss → B-Ware), keine Rückbuchung.

---

## 6. Abhängigkeiten

- `produkte-varianten-farben.md` — für `variant_configurations`.
- `bestellungen.md` — für `order_items` (Ziel der Reservierung).
- `produktion.md` — für die Quelle der `produktion_erfolgreich`- und `ausschuss_umbuchung`-Bewegungen.
- `audit-settings.md` — für Protokollierung aller Statusübergänge.

---

## 7. Nicht Teil dieser Spec

- Filamentbestand — siehe `filament-material.md`.
- Wie eine Produktion zu `produktion_erfolgreich`-Einträgen führt (Batch-Logik, Ausschussquote) — siehe `produktion.md`.
- Preisberechnung — siehe `kalkulation.md`.
