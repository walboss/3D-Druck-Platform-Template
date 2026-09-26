# Spec: Kunden, Warenkorb, Tracking

Siehe `00-overview.md` für Architekturprinzipien (referenziert als #-Nummer) und FK-Reihenfolge.

---

## 1. Zweck

Kundenstammdaten (ohne Kundenkonten, #21), der vor-transaktionale Warenkorb, und der öffentliche Tracking-Zugriff auf eine Bestellung per Link/Token.

---

## 2. Tabellen

### `customers`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | zugleich interne Kundennummer |
| first_name, last_name | text | |
| email | text nullable | optional, kein UNIQUE-Constraint — E-Mail nicht geschäftskritisch (#16) |
| phone | text nullable | |
| pickup_method | text | |
| anonymize_after | date | DSGVO-Löschdatum — wird **automatisch gesetzt** bei `orders.status → HandedOver` (in der entsprechenden Abschluss-Funktion), Wert = `now() + settings.customer_data_retention_days` |
| anonymized_at | timestamp nullable | |

### `cart_sessions` / `cart_items`
**Bewusste Ausnahme von "nie löschen":** Der Warenkorb ist vor-transaktionaler, technischer Zustand ohne Geschäftswert — er reserviert keinen Bestand (#14). Abgelaufene Sessions dürfen technisch aufgeräumt werden.

| `cart_sessions`: id PK, session_token, expires_at |
| `cart_items`: id PK, cart_session_id FK, product_id FK, variant_id FK, configuration_draft (JSON: gewählte Farbe/Finish je Teil, rein clientseitiger Entwurf, noch keine `variant_configuration_id`), qty |

### `order_tracking_tokens`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| order_id | FK → `orders` *(Definition: `bestellungen.md`)* | |
| token | text, unique, secure random | mind. 128 Bit Entropie (siehe `architektur-technologie-v1.md`) |
| expires_at | timestamp | |
| revoked_at | timestamp nullable | |
| revoke_reason | text nullable | z. B. Missbrauchsverdacht |

---

## 3. Geschäftsregeln

- Keine Kundenkonten im MVP (#21) — `customers` hat kein Login/Passwort-Feld, Zuordnung erfolgt über den Bestellprozess selbst.
- E-Mail und Telefon sind optional — kein automatisches, stilles Dedup-Mechanismus über E-Mail/Telefon im Hintergrund.
- **Aktive Kundensuche beim Checkout:** Das System bietet dem Kunden beim Checkout aktiv eine Suche nach einem bestehenden Datensatz an (Abgleich über Telefon **und** E-Mail, beide optional vorhanden — Suche verwendet, was der Kunde eingegeben hat). Der Kunde wählt selbst, ob er sich als bestehend identifiziert (Wiederverwendung des gefundenen `customers`-Datensatzes) oder einen neuen Datensatz anlegt. Kein automatisches Zusammenführen ohne Kundeninteraktion.
- Ein Warenkorb reserviert keinen Bestand (#14) — `cart_items` hat keine Verbindung zu `filament_reservations` oder `finished_goods_reservations`.
- Neugenerierung eines Tracking-Tokens bei Missbrauchsverdacht = **neue Zeile**, alte wird `revoked_at` gesetzt statt gelöscht — Nachvollziehbarkeit bleibt erhalten (#1).
- **DSGVO-Anonymisierung, Ablauf:** zweistufig. (1) Bei Bestellabschluss (`orders.status → HandedOver`) wird `customers.anonymize_after` gesetzt — synchron, kein Cronjob nötig. (2) Ein täglicher Cronjob sucht `customers WHERE anonymize_after <= now() AND anonymized_at IS NULL`, überschreibt `first_name`/`last_name`/`email`/`phone` und setzt `anonymized_at` (Details zum Job siehe `architektur-technologie-v1.md`). Bestellung und Tracking-Token bleiben nach Anonymisierung bestehen (#1), nur die Kontaktdaten sind betroffen.

---

## 4. Statusübergänge

`order_tracking_tokens`: kein mehrstufiger Status, nur `aktiv` (kein `revoked_at`) → `widerrufen` (`revoked_at` gesetzt, Pflichtfeld `revoke_reason`). Kein Zurück — bei erneutem Bedarf entsteht ein neues Token.

---

## 5. Randfälle

- **Kunde bestellt mehrfach:** Dank aktiver Kundensuche beim Checkout (s. o.) entscheidet der Kunde selbst, ob ein bestehender Datensatz wiederverwendet wird. Lehnt er die Zuordnung ab oder findet die Suche nichts (z. B. andere Telefonnummer verwendet), entsteht ein neuer `customers`-Datensatz — kein hartes Dedup-Erzwingen, da E-Mail/Telefon optional sind.
- **Warenkorb-Session läuft während eines laufenden Checkouts ab:** unkritisch, da der Warenkorb ohnehin keine Reservierung hält — im schlimmsten Fall muss der Kunde neu zusammenstellen.
- **Tracking-Link wird nach DSGVO-Anonymisierung des Kunden aufgerufen:** Bestellung und Token bleiben bestehen (#1), nur die Kundenkontaktdaten sind anonymisiert — Tracking zeigt weiterhin Status/Historie der Bestellung.
- **Bestellung wird storniert, bevor sie je `HandedOver` erreicht:** `anonymize_after` wird nie gesetzt über diesen Pfad — eine eigene Regel für stornierte Bestellungen ist hier bewusst nicht vorgesehen (Datenaufbewahrung bei Stornos bleibt unbegrenzt im MVP, da seltener Fall und ggf. für Rückfragen relevant).

---

## 6. Abhängigkeiten

- `bestellungen.md` — für `orders` (Ziel des Tracking-Tokens, Auslöser für `anonymize_after`).
- `audit-settings.md` — für `settings.customer_data_retention_days`.

---

## 7. Nicht Teil dieser Spec

- Der eigentliche Checkout-Ablauf (wie aus einem Warenkorb eine Bestellung wird) — siehe `bestellungen.md`.
- Was die Trackingseite konkret anzeigt (Statushistorie, Produktionsfortschritt) — UI-Detail, nicht Teil der Datenmodell-Spec.
- Der Cronjob zur Anonymisierung selbst (Frequenz, technische Umsetzung) — siehe `architektur-technologie-v1.md`.
