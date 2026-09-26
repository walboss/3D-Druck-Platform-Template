# Spec: Bestellungen

Siehe `00-overview.md` für Architekturprinzipien (referenziert als #-Nummer) und FK-Reihenfolge.

---

## 1. Zweck

Die eigentliche Bestellung mit ihren Positionen — Kundensicht auf den Status, getrennt von der internen Produktionssicht (#13). Zentrale Stelle, an der Reservierungen (Fertigware sofort, Filament erst bei Produktion) ausgelöst werden.

---

## 2. Tabellen

### `orders`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| order_number | text, unique | z. B. `ORDER-2026-00142` — Katalog-Checkout und Angebotsannahme teilen sich denselben Nummernkreis `ORDER-<Jahr>-<5-stellig>` |
| customer_id | FK → `customers` *(Definition: `kunden-warenkorb-tracking.md`)* | |
| status | enum | `New`, `Confirmed`, `InProduction`, `Finished`, `ReadyForPickup`, `HandedOver`, `Cancelled` |
| source | enum | `catalog`, `custom_offer` |
| offer_id | FK nullable → `offers` *(Definition: `angebote-individuelle-anfragen.md`)* | |
| customer_message | text | strikt getrennt von `internal_note` (#7) |
| internal_note | text | niemals kundenseitig sichtbar |
| cancellation_reason | text nullable | Pflicht bei `Cancelled` (#32) |
| confirmed_at, finished_at, ready_for_pickup_at, handed_over_at | timestamp nullable | Bequemlichkeits-Zeitstempel, volle Historie im Audit Log |
| handed_over_by | FK → `admins` *(Definition: `audit-settings.md`)* | |
| handover_note | text nullable | |

### `order_items`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| order_id | FK → `orders` | |
| product_id | FK **nullable** → `products` *(Definition: `produkte-varianten-farben.md`)* | nullable seit Coding-Review: siehe Ausnahmepfad unten |
| variant_id | FK **nullable** → `product_variants` | s. o. |
| variant_configuration_id | FK **nullable** → `variant_configurations` | Farbe/Finish, keine Freitextfelder — außer im Ausnahmepfad |
| desired_description | text nullable | **Neu.** Freitext-Beschreibung, wenn kein Katalogbezug existiert (s. u.) |
| qty | int | |
| status | enum | `Offen`, `WartetAufMaterial`, `InProduktion`, `Fertig`, `Storniert` |
| cancellation_reason | text nullable | Pflicht bei `Storniert` |
| calculation_version_id | FK → `calculation_versions` *(Definition: `kalkulation.md`)* | Preis-/Kosten-Snapshot |
| bundle_group_id | FK nullable → `order_bundle_groups` | |
| production_order_id | FK nullable → `production_orders` *(Definition: `produktion.md`)* | **Neu.** Gesetzt, sobald die Position einem Produktionsauftrag zugeordnet wird (Planungsschritt, s. u.) |

**Constraint (DB-Ebene, nicht nur Anwendungslogik):** entweder ist der volle Katalogbezug gesetzt (`product_id` **und** `variant_id` **und** `variant_configuration_id`, alle drei) **oder** `desired_description` ist gesetzt — nie beides leer, nie eine Mischform. Umsetzung z. B. als `CHECK`-Constraint oder Trigger in Migration 0008.

**Constraint:** ist `bundle_group_id` gesetzt, muss die referenzierte `order_bundle_groups`-Zeile dieselbe `order_id` haben wie die `order_item` selbst (Trigger oder `CHECK` über Subquery, da reines FK dies nicht abbilden kann).

### `order_bundle_groups`
| id PK | order_id FK | bundle_id FK → `product_bundles` | bundle_price |

---

## 3. Geschäftsregeln

- Bestellung und Produktionsfortschritt sind strikt getrennt (#13): `order_items.status` spiegelt die Kundensicht, der tatsächliche Produktionsstand steht in `production_batch_items` (`produktion.md`).
- Eine Bestellannahme mit mehreren Positionen ist **atomar** (#15): Anlage von `order` + allen `order_items` + zugehörigen `finished_goods_reservations` in einer Transaktion — schlägt eine Position fehl (z. B. kein Bestand), wird die gesamte Bestellung nicht auf `Confirmed` gesetzt, sondern rollt zurück bzw. bleibt in einem Zwischenzustand.
- Interne Notizen sind niemals öffentlich (#7) — `internal_note` wird nie über Tracking/Kunden-API ausgeliefert.
- Stornierungsgrund ist Pflicht auf beiden Ebenen — Bestellung **und** einzelne Position (#32).
- Keine automatische Stornierung nicht abgeholter Bestellungen im MVP (#19) — `ReadyForPickup` bleibt bestehen, bis der Admin manuell eingreift.
- Keine Teilabholung im MVP (#20): `orders.status → ReadyForPickup` erst, wenn **alle** aktiven (nicht stornierten) `order_items` den Status `Fertig` erreicht haben.
- Bundles erzeugen normale `order_items` mit gemeinsamer `bundle_group_id` — keine eigene Lager-/Produktionslogik (#26).

### Ausnahmepfad: nicht-katalogisierte Bestellpositionen

Erwarteter Normalfall bei frisch auf MakerWorld gefundenen Designs, die noch nicht im eigenen Katalog sind — **keine** Ausnahme im Sinne von "selten", sondern ein regulärer, vorgesehener Pfad. Solche `order_items` tragen `desired_description` statt Katalog-FKs, `calculation_version_id` verweist auf eine manuell erstellte, einmalige Kalkulation (`scope_type='offer_item'`-artige Behandlung, s. `kalkulation.md`).

Nimmt der Admin das Design später in den Katalog auf, wird die **bestehende** `order_item` **nicht** rückwirkend mit dem neuen Katalogeintrag verknüpft (#1/#9 — Historie bleibt unverändert, wie beschrieben angelegt). Erst **neue** Bestellungen für dasselbe Design ab dem Zeitpunkt der Katalogaufnahme nutzen den echten Katalogbezug.

### Zwei-Schritte-Produktionsstart

1. **Planungsschritt:** `order_items.status → 'InProduktion'` wird gesetzt, sobald der Admin die Position einem `production_order` zuordnet (`order_items.production_order_id` wird gesetzt) — unabhängig davon, ob dieser Auftrag noch `Geplant` oder schon `Laeuft` ist. Es wird **noch kein** Filament reserviert, keine Spule gewählt.
2. **Produktionsstart:** Erst wenn der zugeordnete `production_order` selbst von `Geplant` auf `Laeuft` wechselt, löst das für alle ihm zugeordneten `order_items` die tatsächliche Filamentreservierung aus (siehe `filament-material.md`, `produktion.md`).

Eine `order_item` kann also `InProduktion` sein, ohne dass bereits Filament reserviert wurde — das ist der erwartete Normalzustand zwischen Planung und tatsächlichem Produktionsstart, kein Fehlerfall.

`WartetAufMaterial` ist ein **optionaler** Zwischenzustand, kein Pflichtdurchgang im Statuspfad — eine Position mit sofort verfügbarem Bestand wechselt direkt von `Offen` zu `InProduktion`, ohne je `WartetAufMaterial` gewesen zu sein.

### Automatischer Retry bei Materialeingang

Hängt eine Position wegen fehlendem Bestand auf `WartetAufMaterial` (bzw. die zugehörige Order auf `New`, siehe Statusübergänge unten), löst ein neuer Bestandseingang (`finished_goods_movements`- oder `filament_movements`-Eintrag) automatisch einen erneuten Reservierungsversuch aus. Bei erfolgreichem Retry wechselt die Position `WartetAufMaterial → Offen`, identisch zu einer regulär reservierten Position (siehe Statusübergänge unten).

Konkurrieren mehrere wartende Positionen um denselben knappen Bestand: **FIFO gilt bewusst nur auf Order-Ebene** (`orders.created_at`, ältere Bestellung zuerst). Innerhalb einer Order gilt zur Deadlock-Vermeidung eine feste Sperrreihenfolge (nach `variant_configuration_id`, `id`), keine Sortierung nach `created_at` auf Positionsebene.

---

## 4. Statusübergänge

`orders.status`: `New → Confirmed → InProduction → Finished → ReadyForPickup → HandedOver`, jederzeit außer nach `HandedOver` auch `→ Cancelled` möglich (Pflichtfeld `cancellation_reason`).

- `New → Confirmed`: löst `finished_goods_reservations` für alle Positionen aus (atomar, #15) — schlägt eine Reservierung fehl, bleibt die Bestellung `New` bzw. die betroffene Position wird auf `WartetAufMaterial` gesetzt.
- `Confirmed → InProduction`: mindestens eine Position wechselt zu `InProduktion` (Planungsschritt, s. o.; Filamentreservierung erfolgt separat beim tatsächlichen Start des zugeordneten `production_order`, siehe `filament-material.md`).
- `→ Finished`: alle Positionen `Fertig`.
- `→ ReadyForPickup`: siehe Regel oben (keine Teilabholung).
- `→ HandedOver`: löst `finished_goods_reservations → verbraucht_bei_uebergabe` aus, Pflichtfeld `handed_over_by`. Setzt außerdem `customers.anonymize_after` (siehe `kunden-warenkorb-tracking.md`).

`order_items.status`: `Offen → (WartetAufMaterial, optional) → InProduktion → Fertig`, jederzeit vor `Fertig` auch `→ Storniert` (Pflichtfeld `cancellation_reason`) — löst Freigabe zugehöriger Reservierungen aus (`filament-material.md`, `fertigwarenbestand.md`). `WartetAufMaterial → Offen` (automatischer Retry bei Materialeingang, s. o.) ist derselbe Übergang wie eine regulär reservierte Position, kein eigener Status.

Jeder Übergang + Folgeaktionen atomar, Rollback bei Fehlschlag (#31), Audit-Log-Eintrag (`audit-settings.md`).

---

## 5. Randfälle

- **Teilweise verfügbare Mehrpositions-Bestellung:** Nicht alles-oder-nichts auf Bestellebene erzwungen im Sinne von "ganze Bestellung ablehnen" — stattdessen wechseln einzelne Positionen zu `WartetAufMaterial`, während andere `Confirmed`-fähig sind. Die *Transaktion der Reservierungsversuche* ist atomar (#15), das *Ergebnis* kann gemischt sein.
- **Stornierung während Produktion:** Bereits produzierte Stück werden vom Admin eingeordnet (normale Fertigware / B-Ware / Ausschuss) statt automatisch verworfen — siehe `fertigwarenbestand.md`/`produktion.md`.
- **Bundle-Position storniert:** Nur die einzelne `order_item`-Zeile wird storniert, nicht automatisch die ganze `order_bundle_groups`-Gruppe — Bundle-Preis-Logik bei Teilstornierung ist eine UI-/Anwendungsfrage, nicht Teil dieses Datenmodells.
- **Nicht-katalogisierte Position wird storniert:** verhält sich identisch zu einer katalogisierten Position — der Ausnahmepfad ändert nichts an Stornierungslogik/Pflichtfeldern.

---

## 6. Abhängigkeiten

- `kunden-warenkorb-tracking.md` — für `customers`.
- `produkte-varianten-farben.md` — für `products`, `product_variants`, `variant_configurations`, `product_bundles`.
- `angebote-individuelle-anfragen.md` — für `offer_id`.
- `kalkulation.md` — für `calculation_version_id`.
- `fertigwarenbestand.md` — für die bei `Confirmed` ausgelösten Reservierungen.
- `filament-material.md` — für die bei tatsächlichem Produktionsstart ausgelösten Reservierungen.
- `produktion.md` — für `production_order_id` und den tatsächlichen Produktionsfortschritt hinter `InProduktion`/`Fertig`.

---

## 7. Nicht Teil dieser Spec

- Produktionsplanung/-durchführung (Batches, Materialverbrauch) — siehe `produktion.md`.
- Reservierungslogik im Detail — siehe `filament-material.md`, `fertigwarenbestand.md`.
- Preisberechnung — siehe `kalkulation.md`.
- Online-Zahlung, Versand — nicht im MVP (#22, #23), keine Felder dafür vorgesehen.
