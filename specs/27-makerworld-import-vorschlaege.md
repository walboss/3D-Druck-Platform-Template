# Spec 27 — MakerWorld-Massenimport und Modellvorschläge

Status: ENTWURF (2026-09-19), noch nicht freigegeben.

Baut auf `produktdaten-import-3mf.md` (Einzel-Import Gewicht/Druckzeit) und
dem bestehenden Worker-Endpoint `POST /api/admin/import-makerworld` auf, der
seit dem Task „Titel und Bilder" bereits `title`, `images`, `estimatedPrintMinutes`,
`estimatedWeightG` liefert.

---

## 1. Zweck

1. **Massenimport (Admin):** Viele MakerWorld-Links auf einmal einfügen, daraus
   je Link ein Produkt mit Standard-Variante anlegen. Ersetzt das Anlegen von
   Hand für die Startbefüllung des Katalogs (ca. 200 Modelle).
2. **Modellvorschläge (Kunde, ohne Login):** Kunden können im Shop einen
   MakerWorld-Link als Wunsch einreichen. Der Vorschlag landet in einer
   Admin-Liste; der Admin importiert per Klick. **Ohne Admin entsteht kein
   Produkt** (Prinzip: keine automatische Übernahme ohne Bestätigung).

---

## 2. Entscheidungen (getroffen am 2026-09-19)

| Frage | Entscheidung |
|---|---|
| Welche Felder aus MakerWorld übernehmen | Alles außer Beschreibung: `title` → `products.name`, alle Bilder (Cover + Galerie) → `products.images` als `extern_link`, `tags` → `products.tags`, erste MakerWorld-Kategorie (`categories[0].name`) → `products.category` |
| Beschreibung | Nie übernehmen. `products.description` bleibt leer. |
| Variante | Genau eine Variante je Produkt: `size_label = 'Standard'`, `weight_g`/`print_time_min` aus MakerWorld (0 wenn fehlend), `work_time_min = 0`, `material_need_g = weight_g`, `min_qty = 1`, `max_qty = 10`, `step_qty = 1`, `active = true`. Keine Kalkulation — Produkt bleibt ohne Preis, bis der Admin kalkuliert. |
| Aktiv-Status | `products.active = false`. Admin schaltet nach Prüfung frei. |
| Duplikat-Schutz | Neue Spalte `products.makerworld_model_id text null unique`. Import mit bereits vorhandener ID wird übersprungen (kein Fehler, Zeile im Ergebnis als „bereits vorhanden"). |
| Quell-Link | Neue Spalte `products.makerworld_url text null`. Wird beim Import gesetzt; im Editor sichtbar (nur Anzeige + Link). |
| Lizenz | Nicht automatisch übernommen (`license_id` bleibt null). MakerWorld-Lizenzstring wird nicht gespeichert. Mapping auf `licenses` ist Admin-Arbeit. |
| Kundenvorschläge ohne Login | Ja, über neue Tabelle `product_suggestions`. Turnstile-geschützt wie Checkout/Individualanfrage. |
| Übersetzung Englisch → Deutsch | Ja, im Worker über Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` mit Übersetzer-Systemprompt, Free-Tier, kein Zusatzkonto; das reine Übersetzungsmodell `m2m100` wurde getestet und verworfen: „hedgehog" → „Hecke"). Übersetzt werden `title` und `tags`. Ergebnis ist nur Vorschlag: Vorschau zeigt Original und Übersetzung, Admin kann vor dem Anlegen editieren. Originaltitel wird zusätzlich in `products.makerworld_title` gespeichert. Schlägt die Übersetzung fehl (Quota, Fehler): Original verwenden, kein Abbruch. MakerWorld liefert selbst keine deutsche Übersetzung (`titleTranslated` bleibt leer, geprüft am 2026-09-19). |

---

## 3. Datenmodell (Ergänzung zu `datenmodell-v1.md`)

### `products` (Erweiterung)
| Feld | Typ | Hinweis |
|---|---|---|
| makerworld_model_id | text, nullable, unique | numerische ID aus dem Link, z. B. `1725279` |
| makerworld_url | text, nullable | Originallink, wie eingegeben |
| makerworld_title | text, nullable | englischer Originaltitel von MakerWorld, unverändert |

### `product_suggestions` (neu)
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK uuid | |
| makerworld_url | text not null | eingereichter Link |
| makerworld_model_id | text not null | aus dem Link extrahiert |
| note | text, nullable | optionale Kundennotiz, max. 500 Zeichen |
| status | enum `neu`, `importiert`, `abgelehnt` | |
| product_id | FK → products, nullable | gesetzt bei `importiert` |
| created_at | timestamptz | |
| decided_at | timestamptz, nullable | |
| decided_by | FK → admins, nullable | |

Regeln:
- Ein offener Vorschlag je `makerworld_model_id` (Unique-Index auf
  `makerworld_model_id where status = 'neu'`). Zweite Einreichung derselben ID
  ist kein Fehler, wird still gezählt (kein Insert) — Kunde sieht „Danke".
- Liegt zur ID bereits ein Produkt vor, wird der Vorschlag gar nicht angelegt;
  Kunde bekommt „Modell ist bereits im Katalog".
- Keine Kundendaten (kein Name, keine E-Mail) — nichts zu anonymisieren.
- Nie löschen, nur Status (Prinzip #2).

---

## 4. Worker-Endpoints

### `POST /api/admin/import-makerworld` (bestehend, erweitert)
Liefert Vorschau je Link. Wird vom Massenimport im Frontend je Link aufgerufen.
Erweiterung: Antwort zusätzlich mit `titleDe: string | null`, `tags: string[]`,
`tagsDe: string[]`, `category: string | null`, `modelId: string`. `titleDe` /
`tagsDe` kommen aus Workers AI (§2); bei Fehler `null` bzw. leeres Array,
restliche Antwort bleibt nutzbar. Der Einzel-Import im Produkt-Editor
(Stammdaten-Tab) nutzt dann `titleDe` als Namensvorschlag und zeigt den
Originaltitel als Hinweis.

### `POST /api/vorschlag` (neu, anon)
Body: `{ turnstileToken, makerworldUrl, note? }`.
Ablauf: Turnstile prüfen → Link validieren (nur `makerworld.com/.../models/<id>`,
gleiche Prüfung wie Einzel-Import) → RPC `fn_submit_product_suggestion`
(service_role, wie `fn_submit_custom_request`). Antwort: `{ status: 'angelegt'
| 'bereits_vorgeschlagen' | 'bereits_im_katalog' }`.
Kein MakerWorld-Abruf in diesem Endpoint (kein Titel für den Kunden) — hält
den anonymen Pfad billig und nicht missbrauchbar für Fremdabrufe.

---

## 5. Datenbank-Funktionen

- `fn_submit_product_suggestion(p_makerworld_url, p_makerworld_model_id, p_note)`
  → text (`angelegt` | `bereits_vorgeschlagen` | `bereits_im_katalog`).
  SECURITY DEFINER, nur service_role (Worker). Setzt Regeln aus §3 um.
- `fn_import_makerworld_product(p_model_id, p_url, p_original_title, p_name,
  p_images jsonb, p_tags text[], p_category, p_weight_g, p_print_time_min,
  p_actor, p_suggestion_id null, p_admin_id null)` → uuid
  authenticated (Admin). Legt Produkt + Standard-Variante in einer Transaktion
  an, setzt bei `p_suggestion_id` den Vorschlag auf `importiert`. Gibt
  `product_id` zurück; bei vorhandener `makerworld_model_id` gibt sie die
  bestehende `product_id` zurück und legt nichts an (Vorschlag wird trotzdem
  auf `importiert` mit dem bestehenden Produkt gesetzt). `p_actor` für das
  Audit-Log (Konvention wie 00154), `p_admin_id` optional für `decided_by`.
- `fn_reject_product_suggestion(p_id, p_actor, p_reason null, p_admin_id null)`
  authenticated (Admin). Nur aus `neu`.
- RLS: `authenticated` darf `product_suggestions` lesen (Liste im Admin);
  alle Schreibzugriffe nur über die Funktionen. `anon` hat keinen Zugriff.

Umgesetzt in Migration 00161.

---

## 6. Frontend

### Admin: Katalogpflege → „MakerWorld-Import" (neue Seite `/admin/katalog/import`)
1. Textarea, ein Link je Zeile. Button „Vorschau laden".
2. Frontend ruft je Link `/api/admin/import-makerworld` (sequenziell, max. 3
   parallel), zeigt Tabelle: Cover, Titel (deutsch, editierbar; Original als
   Hinweis darunter), Gewicht, Druckzeit, Tags (deutsch, editierbar), Status
   (`neu` / `bereits vorhanden` / `Fehler: <Meldung>`).
3. Checkbox je Zeile (vorausgewählt für `neu`). Button „N Produkte anlegen".
4. Je Zeile `fn_import_makerworld_product`. Ergebnisspalte: „angelegt“ mit Link
   zum Editor, oder Fehler. Keine Abbrüche bei Einzel-Fehlern.

### Admin: Katalogpflege → „Vorschläge" (Liste, Route `/admin/katalog/vorschlaege`)
- Tabelle offener Vorschläge: Link, Notiz, Datum. Buttons „Importieren"
  (öffnet dieselbe Vorschau wie oben, vorbefüllt mit dem einen Link) und
  „Ablehnen". Badge mit Anzahl offener Vorschläge in der Admin-Navigation.

### Storefront: „Modell vorschlagen" (Route `/vorschlagen`, Link im Footer und
in der Katalog-Leerseite)
- Felder: MakerWorld-Link (Pflicht), Notiz (optional), Turnstile.
- Antworttexte je Status aus §4. Kein Login, keine Kundendaten.

### Produkt-Editor
- Anzeige `makerworld_url` als Link (nur lesen) im Stammdaten-Tab, wenn gesetzt.

---

## 7. Nicht-Ziele

- Kein automatischer Abruf der MakerWorld-Likes-Liste (braucht Login-Token,
  inoffizielle API, fragil).
- Kein Download / eigenes Hosting der Bilder (bleibt `extern_link`).
- Keine Kalkulation beim Import. Ohne Kalkulationsversion bleibt das Produkt
  im Shop ohne Preis und wird nicht gekauft.
- Keine Übernahme von Beschreibung, Lizenz, Creator-Daten.

---

## 8. Umsetzungsreihenfolge (je ein Task)

1. Migration: `products.makerworld_model_id`, `products.makerworld_url`,
   `products.makerworld_title`, Tabelle `product_suggestions`, Enum, Indizes.
2. Migration: `fn_import_makerworld_product`, `fn_submit_product_suggestion`,
   `fn_reject_product_suggestion`, Grants, RLS.
3. Worker: Workers-AI-Binding, Übersetzung, `import-makerworld`-Antwort
   erweitern (`titleDe`, `tags`, `tagsDe`, `category`, `modelId`); Produkt-Editor
   nutzt `titleDe`.
4. Worker: `POST /api/vorschlag`.
5. Frontend Admin: Massenimport-Seite.
6. Frontend Admin: Vorschläge-Liste + Badge.
7. Frontend Storefront: „Modell vorschlagen".
8. Produkt-Editor: Quell-Link und Originaltitel anzeigen.
