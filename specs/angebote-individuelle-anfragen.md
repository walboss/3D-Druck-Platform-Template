# Spec: Angebote & Individuelle Anfragen

Siehe `00-overview.md` für Architekturprinzipien (referenziert als #-Nummer) und FK-Reihenfolge.

---

## 1. Zweck

Kunden können individuelle Wünsche einreichen (eigenes Modell/Link, Wunschgröße/-farbe), aus denen der Admin ein verbindliches, befristetes Angebot erstellt — mehrfach nutzbar, bis es abläuft oder abgelehnt wird.

---

## 2. Tabellen

### `custom_requests`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| customer_id | FK → `customers` *(Definition: `kunden-warenkorb-tracking.md`)* | |
| makerworld_link | text nullable | |
| own_image | text nullable | |
| slice_file_upload | text nullable | **Neu.** Referenz auf hochgeladene `.gcode.3mf`-Datei, optional |
| desired_size | text | |
| color_id | FK nullable → `colors` *(Definition: `produkte-varianten-farben.md`)* | **Fallback für den einfarbigen Fall** — bleibt bestehen, siehe `custom_request_colors` für den mehrfarbigen Fall |
| finish_id | FK nullable → `finishes` | s. o., Fallback |
| qty | int | |
| message | text | |
| status | enum | `neu`, `geprueft`, `angebot_erstellt`, `abgelehnt` |

**Regel zur Farbwahl:** Ist die Anfrage einfarbig, reichen `color_id`/`finish_id` auf `custom_requests` selbst — das ist der einfache, abgesicherte Standardfall. Ist die Anfrage mehrfarbig (mehrere Teile/Slots mit unterschiedlicher Farbe), werden zusätzlich Zeilen in `custom_request_colors` angelegt; `custom_requests.color_id`/`finish_id` bleiben in diesem Fall leer. Beide Wege schließen sich gegenseitig aus (Anwendungslogik: entweder Einzelfeld gesetzt, oder `custom_request_colors`-Zeilen vorhanden, nie beides gleichzeitig befüllt) — so sind sowohl der einfache Fall als auch mehrfarbige Sonderfälle abgesichert, ohne dass eine Seite je zur Pflicht wird.

### `custom_request_colors` *(Neu — nur bei mehrfarbigen Anfragen befüllt)*
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| custom_request_id | FK → `custom_requests` | |
| slot_label | text | z. B. „Slot 1" — aus 3mf-Datei übernommen oder manuell vom Admin vergeben. **Keine** semantische Teile-Bezeichnung wie „Kopf"/„Sockel", da eine Slice-Datei nur Slot/Farbe-Zuordnungen liefert, keine Teilnamen |
| color_id | FK nullable → `colors` | |
| finish_id | FK nullable → `finishes` | |

Wird ein `slice_file_upload` mitgegeben, liest das System `Metadata/slice_info.config` aus (analog `produktdaten-import-3mf.md`) und legt `custom_request_colors`-Zeilen je Slot automatisch vorbefüllt an (Farbe nach bestmöglichem Hex-Abgleich, Admin/Kunde kann korrigieren) — reine Erleichterung, kein Zwang. Ohne Upload bleibt manuelle Eingabe der reguläre Weg, sowohl für den einfarbigen Fallback als auch für `custom_request_colors`.

### `offers`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| custom_request_id | FK → `custom_requests` | |
| valid_from, valid_until | timestamp | |
| status | enum | `offen`, `akzeptiert`, `abgelehnt`, `abgelaufen`, `widerrufen` |
| secure_token | text, unique | mehrfach nutzbarer Link, mind. 128 Bit Entropie (siehe `architektur-technologie-v1.md`) |
| rejection_reason | text nullable | |
| revoked_at | timestamp nullable | **Neu.** Sperrt einen geleakten Link, ohne das Angebot fachlich abzulehnen |
| revoke_reason | text nullable | **Neu.** Pflicht, wenn `revoked_at` gesetzt wird |

### `offer_items`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| offer_id | FK → `offers` | |
| product_id | FK nullable → `products` *(Definition: `produkte-varianten-farben.md`)* | ggf. noch kein Katalogprodukt |
| desired_variant_description | text | |
| qty | int | |
| calculation_version_id | FK → `calculation_versions` *(Definition: `kalkulation.md`)* | |

---

## 3. Geschäftsregeln

- Ein Angebotslink ist **mehrfach nutzbar** bis `valid_until` — jede Nutzung prüft Verfügbarkeit (Fertigware/Filament) zum Zeitpunkt der jeweiligen Bestellauslösung neu, nicht nur einmal beim Erstellen (Anwendungslogik gegen `filament-material.md`/`fertigwarenbestand.md`, keine zusätzliche Tabelle).
- Jede Änderung an einem Angebot erzeugt eine **neue** `calculation_versions`-Zeile (#8, #27) — nie ein Update der bestehenden Kalkulation. Die alte Version bleibt an vergangene Nutzungen/Historie verknüpft.
- Ein akzeptiertes Angebot führt zu einer regulären `orders`/`order_items`-Anlage (siehe `bestellungen.md`) — das Angebot selbst ist kein Ersatz für die Bestellung, sondern deren Auslöser. **Alle** aus einem angenommenen Angebot entstehenden `order_items` laufen über den Ausnahmepfad aus `bestellungen.md` (`desired_description` statt Katalogbezug) — unabhängig davon, ob `offer_items.product_id` gesetzt ist: `offer_items` führt kein `variant_id`/`variant_configuration_id` und kann die Katalog-Trippel-Pflicht auf `order_items` (`product_id` **und** `variant_id` **und** `variant_configuration_id`) strukturell nie erfüllen. `offer_items.product_id` bleibt daher rein informativ auf Angebotsebene und wird nicht auf die `order_item` übertragen.
- **Neues Angebot zu bestehender Anfrage:** Aus einer abgelaufenen oder abgelehnten `offer` kann jederzeit ein **neues** Angebot zur selben `custom_request` erstellt werden. `custom_requests.status` bleibt dabei `angebot_erstellt` — das "kein Zurück"-Verhalten bezieht sich nur auf den Status der Anfrage selbst, nicht auf die Anzahl möglicher `offers` dazu (die Beziehung `offers.custom_request_id → custom_requests` ist strukturell bereits 1:n, keine Schemaänderung nötig).
- **Widerruf eines Angebotslinks:** Besteht Missbrauchsverdacht bei einem geteilten Link, kann der Admin ihn über `revoked_at`/`revoke_reason` sperren, ohne den fachlichen Angebotsstatus zu verändern — ein widerrufenes Angebot ist trotzdem noch "eigentlich gültig" gewesen, nur der Zugriffsweg ist gesperrt (analog `order_tracking_tokens` in `kunden-warenkorb-tracking.md`).

---

## 4. Statusübergänge

`custom_requests.status`: `neu → geprueft → angebot_erstellt` (oder `neu/geprueft → abgelehnt`). Kein Zurück von `angebot_erstellt` — bleibt dort auch dann, wenn das zugehörige Angebot abläuft/abgelehnt wird und ein neues erstellt wird (s. o.).

`offers.status`:

| Von | Nach | Auslöser | Pflichtfelder |
|---|---|---|---|
| — | `offen` | Admin erstellt Angebot aus `custom_request` | `valid_from`, `valid_until` |
| `offen` | `akzeptiert` | Kunde nutzt den Link, löst Bestellung aus | |
| `offen` | `abgelehnt` | Kunde/Admin lehnt ab | `rejection_reason` |
| `offen` | `abgelaufen` | `valid_until` erreicht | — (Zeit-basiert, keine manuelle Admin-Aktion) |
| `offen` | `widerrufen` | Admin sperrt Link bei Missbrauchsverdacht | `revoke_reason` |

---

## 5. Randfälle

- **Angebot wird nach `akzeptiert` erneut über denselben Link aufgerufen:** Muss vom Frontend abgefangen werden (Angebot zeigt sich als bereits verwendet) — Anwendungslogik, kein zusätzlicher Datenbankzustand nötig, da `status = 'akzeptiert'` bereits eindeutig ist.
- **Verfügbarkeit ändert sich zwischen Angebotserstellung und Nutzung:** Das Angebot bleibt preislich gültig (Kalkulationsversion ist fix), aber die Bestellung kann bei fehlender Verfügbarkeit nicht sofort auf `Confirmed` gehen — Verhalten identisch zu einer regulären Bestellung ohne verfügbaren Bestand (siehe `bestellungen.md`/`fertigwarenbestand.md`).
- **Angebot mit mehreren Positionen:** `offer_items` erlaubt das strukturell, auch wenn der Regelfall vermutlich eine Position ist.
- **3mf-Upload liefert Slot ohne eindeutigen Hex-Treffer in `colors`:** Zeile wird trotzdem mit `slot_label` angelegt, `color_id`/`finish_id` bleiben `NULL` bis zur manuellen Zuordnung — kein Blocker für die restliche Anfrage.
- **Anfrage wechselt nachträglich von einfarbig zu mehrfarbig (oder umgekehrt):** Anwendungslogik muss beim Wechsel das jeweils andere Feld leeren (Einzelfeld vs. `custom_request_colors`), damit die gegenseitige Ausschlussregel aus §2 erhalten bleibt.

---

## 6. Abhängigkeiten

- `kunden-warenkorb-tracking.md` — für `customers`.
- `produkte-varianten-farben.md` — für `colors`, `finishes`, `products`.
- `kalkulation.md` — für `calculation_versions`.
- `bestellungen.md` — Zielprozess bei Angebotsannahme (in umgekehrter Richtung referenziert `bestellungen.md` optional `offer_id`); liefert außerdem den Ausnahmepfad für nicht-katalogisierte `offer_items`.
- `produktdaten-import-3mf.md` — für das Auslesen von `slice_info.config` bei optionalem 3mf-Upload.

---

## 7. Nicht Teil dieser Spec

- Der eigentliche Bestellprozess nach Angebotsannahme — siehe `bestellungen.md`.
- Berechnung des Angebotspreises selbst (Kostenkomponenten, Marge, Rundung) — siehe `kalkulation.md`.
- Prüfung der Modell-Lizenz vor Angebotserstellung — siehe `lizenzen.md`.
- Token-Entropie-Vorgaben und Rate-Limiting im Detail — siehe `architektur-technologie-v1.md`.
