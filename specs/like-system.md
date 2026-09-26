# Task-Spec: Like-System (Cookie-basiert, anonym)

Ergänzt `17-storefront-katalog-checkout.md` §1 (Katalog-Übersicht) und `produkte-varianten-farben.md`. Neue, eigenständige Entität — betrifft weder Bestell-/Kalkulationslogik noch die Privatmodus-Flags (Likes sind kein kommerzielles Feature, bleiben unabhängig von `storefront_shop_enabled`/`storefront_prices_visible` immer sichtbar).

## 1. Zweck

Besucher können Produkte "liken" (Herz/Daumen-Icon), ohne einen Account zu brauchen — passt zu Prinzip #21 (keine Kundenkonten im MVP). Identifikation über eine anonyme, langlebige Cookie-ID pro Browser, analog zum bereits bestehenden `cart_sessions`-Muster (dort `localStorage`, hier ein Cookie — funktional gleiches Prinzip: ein zufälliger Identifier ohne Personenbezug).

## 2. Tabelle

### `product_likes` (neu)
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| product_id | FK → `products` | |
| visitor_token | text | aus dem Cookie, zufällig generiert, kein Personenbezug |
| created_at | timestamp | |

**Constraint:** `UNIQUE(product_id, visitor_token)` — ein Visitor kann ein Produkt nur einmal liken, erneutes Antippen entfernt den Like wieder (Toggle), kein zweiter Insert.

Aktuelle Like-Anzahl je Produkt = `COUNT(*) FROM product_likes WHERE product_id = ...` — kein zusätzliches Zählerfeld auf `products`, um Divergenz zu vermeiden (gleiches Muster wie Fertigwarenbestand: abgeleitet, nicht mitgeführt).

## 3. Cookie

- Name z. B. `mw_visitor_id`, zufällige UUID, beim ersten Seitenaufruf gesetzt (falls noch nicht vorhanden), Laufzeit z. B. 1 Jahr.
- Rein funktional (keine Analyse-/Tracking-Cookies, kein Fingerprinting) — vergleichbar mit einer Session-ID, kein Consent-Banner-pflichtiges Tracking. Trotzdem kurz mit dir abklären, ob eine Datenschutzhinweis-Zeile im Footer ergänzt werden soll ("Für die Like-Funktion wird ein technisch notwendiges Cookie gesetzt") — kann ich nicht rechtlich verbindlich beurteilen, nur technisch umsetzen.

## 4. Backend

- `fn_toggle_like(product_id, visitor_token)`: Insert falls noch kein Like von diesem Visitor auf dieses Produkt existiert, sonst Delete (Toggle in einer Funktion, atomar). Gibt neue Like-Anzahl + eigenen Like-Status zurück.
- Kein RLS-Zwang auf "echten" Besitz nötig (kein Login vorhanden) — `visitor_token` kommt vom Client mit, minimales Missbrauchsrisiko (Cookie löschen + erneut liken) wird bewusst in Kauf genommen, MVP einfach halten (#17), kein Rate-Limiting hier vorgesehen (anders als bei den öffentlichen Formularen mit Turnstile — Like ist kein Spam-/Missbrauchsvektor mit Geschäftsrelevanz).

## 5. Frontend

- **Katalog-Karte:** Herz-/Daumen-Icon + Like-Anzahl, antippbar (Toggle), optimistisches UI-Update.
- **Produktdetail:** gleiches Icon + Anzahl, prominenter.
- **Sortierung im Katalog** (`17-storefront-katalog-checkout.md` §1): neue Option "Beliebteste zuerst" neben den bestehenden (Preis auf-/absteigend, Neu zuerst) — sortiert nach `COUNT(product_likes)` absteigend. Hinweis: "Preis auf-/absteigend" bleibt nur relevant, wenn `storefront_prices_visible=true` — unabhängig von dieser Aufgabe, nur zur Einordnung.
- **Neuer Nav-Punkt "Likes"** (Route z. B. `/likes`): zeigt alle Produkte, die dieser Visitor (per Cookie) geliked hat, im gleichen Karten-Grid-Layout wie der Katalog. Leerzustand ("Noch keine Likes") analog zu leerem Suchergebnis im Katalog. Kein eigener Guard/Flag nötig — wie der Rest des Like-Systems unabhängig vom Privatmodus immer erreichbar.

## 5a. Backend-Ergänzung für den Likes-Tab

- `fn_get_liked_products(visitor_token)`: liefert alle `products` (inkl. der für die Karte nötigen Felder wie `v_catalog`) zurück, zu denen eine `product_likes`-Zeile mit diesem `visitor_token` existiert. Gleiche Sicherheitsüberlegung wie beim Like-Toggle selbst (§4): kein Auth-Zwang, `visitor_token` kommt vom Client — Konsistent mit dem bereits akzeptierten Risiko, bewusst kein zusätzlicher Schutz (#17, niedrige Sensitivität: zeigt nur, welche Produkte jemand geliked hat, keine personenbezogenen Daten).

## 6. Randfälle

- **Produkt wird deaktiviert, hatte aber Likes:** Likes bleiben in der Tabelle erhalten (#1, historische Daten nicht zerstören), zählen aber nirgends mehr mit, da deaktivierte Produkte nicht im Katalog erscheinen.
- **Gleicher Besucher, mehrere Geräte/Browser:** zählt als mehrere Likes — kein Cross-Device-Dedup ohne Account möglich, bewusst akzeptiert (#21).

## 7. Nicht Teil dieser Aufgabe

- Kein Login/Account-System.
- Kein Missbrauchsschutz/Rate-Limiting auf die Like-Funktion.
- Keine Likes auf Varianten-/Farbebene — ausschließlich pro `products`.
