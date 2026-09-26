# Spec: Produktion

Siehe `00-overview.md` für Architekturprinzipien (referenziert als #-Nummer) und FK-Reihenfolge.

---

## 1. Zweck

Bündelung von Bestellpositionen zu Produktionsaufträgen (Batches), Erfassung des tatsächlichen Ergebnisses (Erfolg/Ausschuss, getrennt nach Grund), und Reklamationsbehandlung.

---

## 2. Tabellen

### `production_orders`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| printer_id | FK nullable → `printers` | |
| status | enum | `Geplant`, `Laeuft`, `Abgeschlossen`, `Fehlgeschlagen` |
| planned_start | timestamp | |
| actual_start, actual_end | timestamp nullable | |

### `production_batch_items` (Batch-Zuordnung — ein Produktionsauftrag bündelt mehrere Positionen, #25)
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| production_order_id | FK → `production_orders` | |
| order_item_id | FK → `order_items` *(Definition: `bestellungen.md`)* | |
| qty_planned | int | |
| qty_success | int | zählt als Fortschritt |
| qty_scrap_normal | int | regulärer Ausschuss |
| qty_scrap_complaint | int | reklamationsbedingte Ersatzproduktion — eigener Grund-Typ (#28) |

### `production_material_usage`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| production_batch_item_id | FK → `production_batch_items` | |
| spool_id | FK → `filament_spools` *(Definition: `filament-material.md`)* | |
| amount_g | numeric | |
| filament_movement_id | FK → `filament_movements` | |

### `printers`
| id PK | name | model | power_consumption_w | machine_hour_rate | active |

### `complaints`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| order_item_id | FK → `order_items` | |
| reported_at | timestamp | |
| reason | text | |
| decision | enum | `ersatzproduktion`, `rueckerstattung`, `sonstige` |
| decision_note | text | |
| cost | numeric | |
| resolved_at | timestamp nullable | |
| replacement_production_batch_item_id | FK nullable → `production_batch_items` | |

---

## 3. Geschäftsregeln

- Nur erfolgreich produzierte und verwendbare Teile zählen als Fortschritt (`qty_success`) — Beispiel: benötigt 8, erfolgreich 5, Fehldruck 2, offen 1 → Fortschritt 5/8, **nicht** 7/8.
- Reklamationsbedingte Ersatzproduktion wird strikt getrennt vom regulären Ausschuss ausgewiesen (#28) — eigenes Feld `qty_scrap_complaint`, nicht in `qty_scrap_normal` vermischt.
- Bei Totalausfall eines ganzen Batches wird der Ausschuss anteilig nach geplantem Materialbedarf auf die beteiligten `production_batch_items` verteilt (Anwendungslogik zum Abschlusszeitpunkt, keine zusätzliche Tabelle).
- Keine automatische Filamentauswahl ohne Adminentscheidung (#18) — die Spule wird vom Admin bei Produktionsstart manuell gewählt (siehe `filament-material.md`), diese Spec erfasst nur die Zuordnung/den Verbrauch danach.
- Ein Produktionsauftrag kann mehrere Bestellpositionen bündeln (#25) — `production_batch_items` ist die n:m-Verbindung, nicht eine 1:1-Zuordnung.

### Zwei-Schritte-Trennung Planung vs. tatsächlicher Start (Abstimmung mit `bestellungen.md`)

1. **Planungsschritt** — `order_items.status → 'InProduktion'` und `order_items.production_order_id` wird gesetzt, sobald der Admin eine Position einem `production_order` zuordnet. Das gilt unabhängig davon, ob dieser Auftrag noch `Geplant` oder schon `Laeuft` ist. In diesem Schritt passiert **noch keine** Filamentreservierung.
2. **Tatsächlicher Produktionsstart** — erst wenn der `production_order` selbst von `Geplant` auf `Laeuft` wechselt, löst das für **alle** ihm zugeordneten `order_items` die Filamentreservierung aus (`filament_reservations`, Spulenwahl durch den Admin, siehe `filament-material.md`).

Eine `order_item` mit Status `InProduktion`, aber ohne aktive `filament_reservations`, ist damit der erwartete Normalzustand zwischen Planung und Start — kein Fehlerfall, keine Inkonsistenz.

---

## 4. Statusübergänge

`production_orders.status`: `Geplant → Laeuft → Abgeschlossen` oder `Laeuft → Fehlgeschlagen`. Kein Zurück von `Abgeschlossen`/`Fehlgeschlagen`.

**Teilausfall / Nachproduktion:** Sind nach Abschluss der geplanten `production_batch_items` nicht alle Positionen erfolgreich fertiggestellt (z. B. Ausschuss ohne sofortige Ersatzproduktion), bleibt `production_orders.status = 'Laeuft'` bestehen — **kein** automatischer Abschluss, **kein** separater neuer `production_order` für die Nachproduktion. Die Nachproduktion erhält **weitere `production_batch_items`-Zeilen im selben Auftrag**. Der Auftrag gilt erst dann als `Abgeschlossen`, wenn der Admin ihn manuell so setzt. Eine UI-seitige Kennzeichnung "läuft ungewöhnlich lange" (z. B. Vergleich `planned_start` vs. `now()`) ist ein Dashboard-Detail, kein eigenes Datenmodell-Feld.

Bei `Abgeschlossen`: für jedes `production_batch_item` werden `qty_success`/`qty_scrap_normal`/`qty_scrap_complaint` final gesetzt, was wiederum `order_items.status` beeinflusst (siehe `bestellungen.md`) und `finished_goods_movements`/`filament_movements` erzeugt (atomar, #31).

`complaints`: `reported_at` gesetzt → offen → `resolved_at` gesetzt bei Entscheidung (`decision` Pflichtfeld ab diesem Zeitpunkt).

---

## 5. Randfälle

- **Batch mit gemischtem Ergebnis** (ein Teil erfolgreich, eines Fehldruck, im selben Produktionslauf): normaler Fall, `production_batch_items` erlaubt `qty_success` und `qty_scrap_normal` in derselben Zeile.
- **Reklamation führt zu Ersatzproduktion, die selbst wieder fehlschlägt:** `replacement_production_batch_item_id` verweist auf den (neuen) Batch-Eintrag; falls dieser ebenfalls Ausschuss produziert, gilt für ihn dieselbe Logik wie für jeden anderen `production_batch_item` — keine Sonderverschachtelung nötig.
- **Materialverbrauch übersteigt geplanten Bedarf deutlich:** Wird nicht automatisch verhindert, nur erfasst (`production_material_usage` vs. `variant_parts.material_need_g` aus `filament-material.md`/`produkte-varianten-farben.md`) — Abweichungsanalyse ist Reporting, keine Sperre.
- **Auftrag bleibt wegen Teilausfall sehr lange `Laeuft`:** bewusst kein Auto-Timeout — der Admin entscheidet, wann nachproduziert bzw. der Auftrag manuell abgeschlossen wird.

---

## 6. Abhängigkeiten

- `bestellungen.md` — für `order_items`, insbesondere `production_order_id` und die Zwei-Schritte-Trennung.
- `filament-material.md` — für `filament_spools`, `filament_movements`, `filament_reservations`.
- `fertigwarenbestand.md` — als Ziel der `produktion_erfolgreich`- und `ausschuss_umbuchung`-Bewegungen.

---

## 7. Nicht Teil dieser Spec

- Reservierung von Filament vor Produktionsstart — siehe `filament-material.md`.
- Wie erfolgreiche Produktion den Fertigwarenbestand erhöht — siehe `fertigwarenbestand.md`.
- Kalkulation der tatsächlichen vs. geplanten Kosten — leitet sich aus dieser Spec ab, wird aber in `kalkulation.md` als Reporting-Frage behandelt, nicht hier gespeichert.
