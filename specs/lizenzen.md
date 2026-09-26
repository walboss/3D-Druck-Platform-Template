# Spec: Lizenzen

Siehe `00-overview.md` für Architekturprinzipien (referenziert als #-Nummer) und FK-Reihenfolge.

---

## 1. Zweck

Lizenzrecht (darf ein Modell kommerziell genutzt werden) und Lizenzkosten (was kostet das) strikt getrennt verwalten (#11) — eine Lizenz/Mitgliedschaft kann mehrere Modelle desselben Creators abdecken.

---

## 2. Tabellen

### `creators`
| id PK | name | profile_url (unique) |

### `licenses` (Lizenzrecht)
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| creator_id | FK → `creators` | |
| commercial_use_allowed | bool | |
| valid_from, valid_until | date, nullable | |
| status | enum | `aktiv`, `abgelaufen`, `widerrufen` |
| proof_note | text | |
| source | text | |

### `license_product_links` (eine Lizenz kann mehrere Modelle abdecken)
| id PK | license_id FK | product_id FK → `products` *(Definition: `produkte-varianten-farben.md`)* |

### `license_cost_models` (Lizenzkosten — getrennt vom Recht)
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| license_id | FK → `licenses` | |
| cost_type | enum | `kostenlos`, `pro_stueck`, `einmalig`, `wiederkehrend`, `sonstige` |
| amount | numeric | |
| period | text nullable | z. B. `monatlich` |

### `license_recurring_charges` (tatsächliche Zahlung vs. kalkulatorische Umlage getrennt)
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| license_id | FK → `licenses` | |
| period_start, period_end | date | |
| amount_paid | numeric | tatsächlich gezahlt |
| allocated_qty | int | auf wie viele produzierte Stück umgelegt |
| per_unit_allocated_cost | numeric | daraus abgeleiteter Stückkosten-Anteil, zum Zeitpunkt der Umlage |

---

## 3. Geschäftsregeln

- Lizenzrecht und Lizenzkosten sind getrennte Tabellen (#11) — ein Modell kann kommerziell erlaubt sein, ohne dass daraus automatisch ein Kostenmodell folgt (z. B. `kostenlos`), und umgekehrt ändert eine Preisänderung nie rückwirkend das Recht.
- Eine Lizenz/Mitgliedschaft kann mehrere Modelle desselben Creators abdecken — `license_product_links` ist eine n:m-Verbindung, keine 1:1-Zuordnung Lizenz↔Produkt.
- Tatsächliche Zahlung und kalkulatorische Umlage bleiben getrennt: `license_recurring_charges.amount_paid` (real gezahlt) vs. `per_unit_allocated_cost` (rechnerisch pro Stück verteilt, zum Zeitpunkt der Umlage) — beide werden gespeichert, nicht nur das Ergebnis.
- Lizenzen werden bei Ablauf/Widerruf auf `status` gesetzt, nie gelöscht (#2, #1) — betroffene Produkte bleiben nachvollziehbar mit ihrer damaligen Lizenzgrundlage verknüpft.

---

## 4. Statusübergänge

`licenses.status`: `aktiv → abgelaufen` (durch `valid_until` erreicht) oder `aktiv → widerrufen` (Admin-Aktion, z. B. Creator zieht Erlaubnis zurück). Kein Zurück zu `aktiv` — bei erneuter Erlaubnis entsteht eine neue `licenses`-Zeile.

---

## 5. Randfälle

- **Produkt ohne hinterlegte Lizenz:** `products.license_id` ist nullable — nicht jedes Produkt braucht zwingend eine Lizenzzuordnung (z. B. eigene Designs).
- **Lizenz läuft ab, während Bestellungen offen sind:** Bestehende `order_items`/`calculation_versions` bleiben unverändert gültig (#9) — der Ablauf betrifft nur neue Bestellungen/Kalkulationen ab diesem Zeitpunkt.
- **Wiederkehrende Lizenzkosten ohne genaue Stückzahl im Abrechnungszeitraum:** `allocated_qty` wird zum Zeitpunkt der Umlage geschätzt/festgelegt — keine nachträgliche Korrektur bestehender `license_recurring_charges`-Zeilen, stattdessen ggf. eine neue Zeile für denselben Zeitraum mit Korrekturvermerk (analog zu Kalkulationsversionen, #8).

---

## 6. Abhängigkeiten

- `produkte-varianten-farben.md` — für `products` (`license_id`, `license_product_links`).
- Wird inhaltlich, aber nicht per FK, von `kalkulation.md` referenziert (Lizenzkosten als kopierter Wert in `calculation_versions.license_cost`).

---

## 7. Nicht Teil dieser Spec

- Wie Lizenzkosten in die Preisberechnung einfließen — siehe `kalkulation.md`.
- Prüfprozess, ob ein Modell überhaupt kommerziell nutzbar ist (Admin-Workflow) — hier nur die Datenstruktur, kein Ablauf.
