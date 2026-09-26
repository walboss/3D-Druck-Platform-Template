# Umgesetzt: Privatmodus — Storefront-Sichtbarkeitsschalter

Ergänzt `25-admin-settings.md`. Status: **fertig, keine offene Aufgabe** — diese Datei dokumentiert den Ist-Zustand, damit spätere Tasks (Claude Code oder sonst wer) das nicht erneut bauen oder versehentlich umgehen.

## 1. Zweck

Solange die Plattform ohne Gewinnabsicht/rein privat betrieben wird, sind alle preis- und shopbezogenen Storefront-Bereiche für Außenstehende unsichtbar/unerreichbar — der komplette Code (Warenkorb, Kasse, Individualanfrage) bleibt dabei vollständig erhalten, nur eben ausgeblendet. Reaktivierung jederzeit über die Settings, kein Code-Eingriff nötig.

**Wichtig — Abgrenzung zu Prinzip #6:** Dieser Mechanismus betrifft ausschließlich den **Storefront** (Kundensicht). Der Admin-Bereich (Katalogpflege inkl. Kalkulationsversionen-Dialog, Bestellverwaltung mit Preisen etc.) ist davon **nicht** betroffen und bleibt für den eingeloggten Admin immer vollständig sichtbar — das ist unabhängig von diesen drei Flags und war es schon immer (Prinzip #6 regelt nur "Kunde sieht nie Kosten", nicht "Admin sieht manchmal nichts").

## 2. Datenmodell

Drei neue Boolean-Spalten in `settings` (Migrationen 00163–00165), alle Default `false`:
- `storefront_prices_visible`
- `storefront_shop_enabled`
- `storefront_custom_request_enabled`

Neue Funktion `fn_get_public_settings()`: gibt ausschließlich diese drei Flags an anonyme Besucher zurück — keine internen Kostenfelder, keine anderen `settings`-Spalten. Die eigentliche `settings`-Tabelle bleibt admin-only (siehe `audit-settings.md`).

## 3. Frontend

`pricing.service.ts` lädt die drei Flags einmal beim App-Start als Signals: `showPrices`, `shopEnabled`, `customRequestEnabled`.

- **Nav/Header** (`storefront-layout.ts:54`): Wunschliste- und Individualanfrage-Einträge werden aus der Nav gefiltert, wenn das jeweilige Flag aus ist.
- **Buttons/Preise:** `@if (shopEnabled())` bzw. `@if (showPrices())` um die betroffenen Template-Blöcke (z. B. "In den Warenkorb", Preisanzeige) — bei `false` wird der Block gar nicht gerendert.
- **Routen-Guards** (`shop-enabled.guard.ts`, `custom-request-enabled.guard.ts`): Direkter URL-Aufruf von `/wunschliste` oder `/individualanfrage` wird bei ausgeschaltetem Flag zu `/katalog` umgeleitet.
- **CartService:** schickt Cart-Requests nur noch, wenn `shopEnabled()` true ist (vorher lief das unabhängig vom Schalter im Hintergrund).

## 4. Reaktivierung

Admin-Bereich → Einstellungen → jeweiligen Schalter umlegen. Kein Code-Deploy nötig.

## 5. Relevanz für andere/künftige Tasks

- **Filament-Bibliothek** (`filament-bibliothek-neuanlage.md`): rein admin-seitig, von diesen drei Flags nicht betroffen.
- **Kalkulation manuell auslösen:** admin-seitig, ebenfalls nicht betroffen — war nie Teil dieses Mechanismus.
- Künftige neue Storefront-Features sollten sich an das bestehende Signal-Pattern (`pricing.service.ts`) halten statt eigene Sichtbarkeitslogik zu erfinden.

---

## 6. Erweiterung: Kommerzfreie Sprache im gesamten Storefront — TEILWEISE erledigt

**Bestätigt fertig laut BUILD-LOG.md, Session "2026-09-19/20 — Storefront-Redesign + Preis-/Shop-Sichtbarkeit" (Commits 06f19a1–e2b0f6d):**
- 6.1 Angebotsansicht-Preis
- 6.3a Terminologie-Umbenennung (inkl. gestuftem Produktdetail-CTA, Branding-Bereinigung Seitentitel/Footer)

**Weiterhin offen:**
- 6.2 Bestätigungstexte (Bestellnummer/Order-Framing raus, neutraler Wortlaut)
- 6.3b Terminologie flag-abhängig machen (Rückfall auf "Warenkorb"-Wortlaut bei `shopEnabled=true`)

Über die drei bestehenden Flags hinaus soll an **keiner Stelle** im Storefront noch ein Hinweis auf ein gewinnorientiertes Angebot sichtbar sein — auch nicht implizit über Formulierung (Bestellnummer, "Bestellung", "Kasse" etc.), nicht nur über Preiszahlen. Beide Wege (Warenkorb/Checkout UND Individualanfrage) sind aktuell aktiv und betroffen.

**Grundprinzip für 6.1–6.3, ausdrücklich bestätigt:** Alles hier Beschriebene ist **an `shopEnabled()`/`showPrices()` gekoppelt, nicht dauerhaft fest**. Bei `shopEnabled = true` (späterer gewerblicher Betrieb) soll wieder "Warenkorb"/"Kasse"/"Bestellung" mit Bestellnummer und Preisanzeige erscheinen — bei `false` (aktueller Privatbetrieb) "Wunschliste"/"Anfrage abschicken" ohne Preis/Bestellnummer. Kein Zustand ist der feste Normalfall, beide sind über den Schalter jederzeit reversibel.

### 6.1 Angebotsansicht (Token-Link, `18-storefront-anfrage-angebot-tracking.md` §7) — ERLEDIGT

Laut BUILD-LOG.md bereits Teil der Session vom 19./20.09.: "Preisanzeige komplett ausblendbar (…, Angebotsansicht)". Keine weitere Aktion nötig.

### 6.2 Bestätigungs-/Erfolgsmeldungen — einheitliche neutrale Formulierung

Konkret gewünschter Text: **"Wunschliste/Anfrage wurde übermittelt"** (oder sehr ähnlich) — an allen Stellen, die aktuell wie eine Bestellbestätigung klingen:

- Bestellbestätigung nach Checkout (`17-storefront-katalog-checkout.md` §5): bisher "Bestellnummer, Zusammenfassung" — Bestellnummer-Anzeige (`ORDER-<Jahr>-<5-stellig>`) sowie jede Preis-/Summenzeile entfernen, stattdessen neutrale Bestätigung. Tracking-Link kann bleiben, aber ebenfalls neutral benannt (nicht "Bestellung verfolgen", eher "Status ansehen" o. ä.).
- Individualanfrage-Formular nach Absenden (§6): bereits eine "Bestätigung" vorgesehen — Wortlaut auf "Wunschliste/Anfrage wurde übermittelt" vereinheitlichen.
- Angebot annehmen (§7): Erfolgsmeldung nach `fn_accept_offer` ebenfalls neutral, kein Preis-Rückblick in der Bestätigung.

### 6.3a Terminologie-Audit als solche — ERLEDIGT (Commit e2b0f6d, live deployed)

"Warenkorb" wurde als Konzept komplett zu "Wunschliste" umbenannt. Nur sichtbarer Text/Label geändert — Tabellen/Felder/interne Variablennamen (`CartService`, `cart_session_token`, `storefront_shop_enabled` etc.) unverändert, da für Besucher nicht sichtbar.

**Wichtig — welches Flag steuert was:** `shopEnabled` (`storefront_shop_enabled`) steuert nur, ob die Liste/Kasse überhaupt *erreichbar* ist (Nav-Eintrag, Icon, Guard) — unabhängig davon, ob kommerzielle Sprache erscheint. Die Terminologie/Preise in der Tabelle unten hängen an `showPrices` (`storefront_prices_visible`). Beide Flags sind unabhängig kombinierbar; der normale Privatmodus-Zustand ist `shopEnabled=true, showPrices=false` ("Wunschliste nutzbar, keine Preise/Kasse-Sprache") — nicht `shopEnabled=false`, das würde die Liste komplett verstecken (siehe Abschnitt 1–3).

| Bereich | Privatmodus (`showPrices=false`) | Gewerblich (`showPrices=true`) |
|---|---|---|
| URL | `/wunschliste` | `/warenkorb` |
| URL | `/anfrage-abschicken` | `/checkout` |
| Label (Überschrift/Nav/aria-label) | "Wunschliste" | "Warenkorb" |
| Label | "Anfrage abschicken" | "Kasse" |
| Button | "Anfrage senden" | "Zahlungspflichtig bestellen" |
| Button | "Hinzufügen" | "In den Warenkorb" |
| Button | "Zur Wunschliste" | "Zum Warenkorb" |
| Link | "Weiter stöbern" | "Weiter einkaufen" |
| Fehlermeldungen | "Wunschliste konnte nicht geladen werden" etc. | "Warenkorb konnte nicht geladen werden" etc. |
| Backend-Endpoint (Worker, nur Netzwerk-Tab) | `/api/wunschliste` | `/api/checkout` |
| Header-Icon | `pi-list` (Listen-Icon) | unverändert — war schon vorher kein Einkaufswagen-Symbol, bleibt auch im gewerblichen Modus so |

### 6.3b Terminologie flag-abhängig machen — ERLEDIGT, per Korrektur 2026-09-20

Zentrale Textmap in `pricing.service.ts` (`listLabel`, `checkoutLabel`, `submitOrderLabel`, `addToListLabel`, `goToListLabel`, `continueBrowsingLabel`, `listPath`, `checkoutPath`, `apiEndpointPath`), von allen Storefront-Komponenten referenziert statt eigener Logik. Routen `/wunschliste`+`/warenkorb` bzw. `/anfrage-abschicken`+`/checkout` beide real registriert (zwei parallele Einträge auf dieselbe Komponente), Worker-Endpoint akzeptiert beide Pfadnamen auf denselben Handler.

**Korrektur (Betreiber, 2026-09-20):** Erstversion koppelte die Textmap an `shopEnabled()` statt `showPrices()` — dadurch verschwand die Wunschliste-Sprache genau dann, wenn `shopEnabled` eingeschaltet wurde, um die Liste überhaupt nutzbar zu machen (der eigentlich gewünschte Dauerzustand `shopEnabled=true, showPrices=false` zeigte fälschlich "Warenkorb"/"Kasse"). Auf `showPrices()` umgestellt, siehe Hinweis vor der Tabelle oben. Cloudflare-Worker-Deploy für den Dual-Endpoint (`089f514`) war zudem versehentlich nie nachgeholt worden — nachgeholt in derselben Session.

### 6.4 Nicht Teil dieser Erweiterung

- Keine Änderung an Datenmodell, `orders`/`order_items`/`offers`-Tabellen, Admin-Sprache oder internen Prozessen — diese bleiben exakt wie in den Kern-Specs beschrieben.
- Bereits umgesetzte Flags (Abschnitt 1–5 dieser Datei) bleiben unverändert, werden hier nur erweitert.
