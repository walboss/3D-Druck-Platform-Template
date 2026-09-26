# Spec: Produkte, Varianten, Farben

Siehe `00-overview.md` für Architekturprinzipien (referenziert als #-Nummer) und FK-Reihenfolge.

---

## 1. Zweck

Der Produktkatalog: was verkauft wird (Produkte, Größenvarianten, Teile), in welchen Farb-/Finish-Kombinationen, und wie eine konkrete verkaufbare Konfiguration (Variante + Farbe/Finish je Teil) einheitlich abgebildet wird — als Grundlage sowohl für Bestellpositionen als auch für Fertigwarenbestand.

---

## 2. Tabellen

### `products`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| name, description, category | text | |
| tags | text[] | **Neu.** Freie Schlagwörter für Suche/Filterung — z. B. übernommen aus MakerWorld-Tags (unproblematisch, reine funktionale Metadaten, kein Urheberrecht, siehe Klärung zur Bildnutzung) oder frei vom Admin vergeben |
| images | JSON/Array oder eigene `product_images` — je Bild: `url`, `source_type` (**Neu**, s. u.) | |
| active | bool | nie löschen (#2) |
| is_multicolor | bool | steuert, ob Farbwahl pro Teil oder pro Position erfolgt |
| license_id | FK nullable → `licenses` *(Definition: `lizenzen.md`)* | |
| source_custom_request_id | FK nullable → `custom_requests` *(Definition: `angebote-individuelle-anfragen.md`)* | falls aus individueller Anfrage entstanden |

### `product_variants`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| product_id | FK → `products` | |
| size_label | text | z. B. "15 cm" |
| weight_g, print_time_min, work_time_min, material_need_g | numeric | Summe aus `variant_parts`, bei Produkten ohne Teile direkt gepflegt |
| min_qty, max_qty, step_qty | int | Mengenregeln |
| active | bool | |

### `product_parts` (Teil-Definition, z. B. "Kopf", "Body")
| id PK | product_id FK | name | sort_order |

### `variant_parts` (Teil-Werte je Variante — Größe beeinflusst Teilwerte)
| id PK | variant_id FK | product_part_id FK | weight_g | print_time_min | material_need_g |

`product_variants.weight_g` etc. sind bei Produkten mit Teilen **berechnete Summen**, keine unabhängige Wahrheit.

### `colors` / `finishes`
| id PK | name | hex (nullable, nur colors) | active |

`hex` ist bewusst vorgesehen, um Farben später automatisiert (z. B. gegen Drucker-/AMS-Daten oder 3mf-Slice-Daten) abgleichen zu können.

### `product_color_finish_options` (historisch, seit 2026-09-20 ungenutzt)
| id PK | product_id FK | color_id FK | finish_id FK | active |

**Entscheidung 2026-09-20 (Betreiber), Migration 00170:** Ursprünglich "erlaubte
Kombinationen pro Produkt" — bedeutete doppelte Pflege (Farbe/Finish global
anlegen UND zusätzlich pro Produkt freischalten), das war nicht gewünscht.
Jede aktive Farbe + jedes aktive Finish ist seither für **jedes** Produkt
wählbar, ohne weiteren Freigabeschritt. Tabelle bleibt bestehen (#2, keine
bestehende Struktur rückstandslos entfernen), wird aber von keiner Funktion
mehr zur Validierung herangezogen — `fn_create_variant_configuration_if_missing`
(00141, per 00170 angepasst) prüft stattdessen nur noch, dass `color_id` in
`colors` und `finish_id` in `finishes` jeweils mit `active = true` existiert,
ohne Produktbezug.

### `variant_configurations` (verkaufbare/lagerbare Ausprägung)
| id PK | variant_id FK |

### `variant_configuration_colors`
| id PK | variant_configuration_id FK | product_part_id FK **nullable** (NULL = gilt für die ganze Position) | color_id FK | finish_id FK |

Eine Konfiguration mit einer Zeile ohne `product_part_id` = einfarbiges Produkt. Mehrere Zeilen mit gesetztem `product_part_id` = mehrfarbiges Produkt. Wird von `order_items` (`bestellungen.md`) und `finished_goods_stock` (`fertigwarenbestand.md`) referenziert — keine doppelte Farblogik.

### `product_bundles` / `bundle_items`
| `product_bundles`: id PK, name, fixed_price, active |
| `bundle_items`: id PK, bundle_id FK, product_id FK | *(Variante/Farbe wählt der Kunde je enthaltenem Produkt frei zum Bestellzeitpunkt)*

---

## 3. Geschäftsregeln

- Produkte, Varianten, Farben und Finishes werden bei Nichtgebrauch deaktiviert (`active = false`), nie gelöscht (#2) — auch historische Bestellungen referenzieren sie weiter.
- Mengenregeln sind produktindividuell: jedes Produkt definiert Mindestmenge, Höchstmenge, Schrittweite (`min_qty`/`max_qty`/`step_qty`) — z. B. große Figur 1–5/Schritt 1, Schlüsselanhänger 1–50/Schritt 1, Sonderprodukt 5–50/Schritt 5.
- Alle aktiven Farben × alle aktiven Finishes sind für jedes Produkt frei kombinierbar (seit 2026-09-20, Migration 00170 — vorher pro Produkt freizugeben, siehe `product_color_finish_options` oben), auch für jedes Teil eines mehrfarbigen Produkts aus derselben globalen Liste.
- Ein Produktteil (`product_parts`) ist eine eigene Entität (#24) — Gewicht/Druckzeit/Materialbedarf werden je Teil **und** je Variante geführt (`variant_parts`), da die Größe die Teilwerte beeinflusst.
- Bundles sind rein organisatorisch (#26): Der Bundle-Preis ist fix, aber Variante/Farbe der enthaltenen Produkte wählt der Kunde weiterhin frei bei Bestellung — ein Bundle erzeugt keine eigene Lager- oder Produktionslogik, nur normale `order_items` mit gemeinsamer Gruppierung (siehe `bestellungen.md`).
- **Durchsuchbarer Katalog (löst frühere Entscheidung "nur direkt geteilte Links" ab):** Kunden können den öffentlichen Katalog durchsuchen/durchstöbern, nicht nur über individuell geteilte Produktlinks zugreifen — UX-Entscheidung für einen einfacheren Bestellweg. Suche erfolgt über `name`, `description`, `tags` (einfache `ILIKE`-/Volltextsuche reicht für die erwartete Katalog- und Nutzerzahl, kein Such-Index-Overhead nötig). Nur `active = true`-Produkte sind auffindbar. **Zusammenhang mit Bildquelle (`images[].source_type`, s. o.):** Da jetzt der ganze Katalog durchstöberbar ist statt nur einzeln verschickter Links, sehen potenziell mehr Personen als der ursprünglich adressierte Empfänger ein Produkt — bei `extern_link`-Bildern sollte das bei der Priorisierung, welche Produkte zuerst auf `eigenes_hosting` umgestellt werden, berücksichtigt werden.
- **Bildquelle je Bild (`images[].source_type`):** `extern_link` (Hotlink auf ein fremd gehostetes Bild, z. B. MakerWorld-Showcase-Foto) oder `eigenes_hosting` (Datei in Supabase Storage). `extern_link` ist bewusst nur für die frühe Phase gedacht, in der die Plattform ausschließlich einem geschlossenen, persönlich bekannten Kreis über nicht-öffentliche Links zugänglich ist (kein Suchmaschinen-Index, kein durchsuchbarer öffentlicher Katalog, kein Geldfluss über reine Materialkostenerstattung hinaus) — sobald daraus echter, öffentlicherer Verkauf wird, sollten Produkte schrittweise auf `eigenes_hosting` (eigene Fotos der eigenen Drucke) umgestellt werden. Beide Werte können im Katalog nebeneinander existieren, keine Migration aller Produkte auf einmal nötig — die Umstellung erfolgt Produkt für Produkt.
- **Automatische Anlage von `variant_configurations` beim Checkout:** Existiert die vom Kunden im Warenkorb gewählte Farb-/Finish-Kombination (`cart_items.configuration_draft`) noch nicht als `variant_configuration`/`variant_configuration_colors`-Zeilen, werden sie beim Checkout **automatisch angelegt** — vorausgesetzt, `color_id` und `finish_id` existieren jeweils aktiv in `colors`/`finishes` (sonst schlägt der Checkout fehl, keine automatische Anlage ungültiger Kombinationen; seit Migration 00170 kein Produktbezug mehr, siehe oben). Kein manueller Admin-Schritt vorab nötig, um alle theoretisch möglichen Kombinationen vorab zu kuratieren.

---

## 4. Statusübergänge

Keine mehrstufigen Status in dieser Domäne — nur `active`/`inactive` auf `products`, `product_variants`, `colors`, `finishes`. Übergang `active → inactive` jederzeit durch Admin, kein Übergang zurück ausgeschlossen (Reaktivierung möglich). Jeder Wechsel wird im Audit Log erfasst (`audit-settings.md`).

---

## 5. Randfälle

- **Mehrfarbige Produkte mit geteilten Farben:** Zwei Teile können dieselbe Farbe haben — das ist eine gültige Konfiguration, keine Sonderbehandlung nötig, da `variant_configuration_colors` pro Teil unabhängig ist.
- **Produkt ohne Teile:** Wenn ein Produkt keine `product_parts` hat, werden Gewicht/Druckzeit/Materialbedarf direkt auf `product_variants` gepflegt, nicht über eine leere Teile-Summe.
- **Deaktiviertes Produkt mit offenen Bestellungen:** `active = false` verhindert nur neue Bestellungen; bestehende `order_items`, die bereits auf diese Variante/Konfiguration verweisen, bleiben unverändert gültig (#9).
- **Checkout mit ungültiger/inaktiver Farbe oder Finish** (z. B. durch manipulierten Client-Request oder nachträglich deaktivierte Farbe): automatische Anlage wird abgelehnt, Checkout schlägt mit Fehler fehl — keine stille Fallback-Konfiguration.
- **`extern_link`-Bild wird beim externen Anbieter entfernt/blockiert (Hotlink-Schutz):** kein automatischer Fallback im Datenmodell — Frontend zeigt einen Platzhalter, wenn das Bild nicht lädt. Erkennung/Behebung ist Admin-Aufgabe (Bild manuell austauschen), keine automatisierte Prüfung im MVP.

---

## 6. Abhängigkeiten

- `lizenzen.md` — für `license_id` auf `products`.
- `angebote-individuelle-anfragen.md` — für `source_custom_request_id`.
- Wird selbst von praktisch allen anderen Kern-Specs referenziert (`bestellungen.md`, `fertigwarenbestand.md`, `kalkulation.md`, `filament-material.md` teilweise über Farben) — daher in FK-Reihenfolge früh (Ebene 2–5).

---

## 7. Nicht Teil dieser Spec

- Filamentbestand/konkrete Materialrollen — siehe `filament-material.md`. Farbe (Kundensicht) und konkretes Filament (interne Realisierung) sind strikt getrennt (#10).
- Fertigwarenbestand (wie viele Stück einer Konfiguration real auf Lager sind) — siehe `fertigwarenbestand.md`.
- Preisberechnung/Kalkulation — siehe `kalkulation.md`.
- Lizenzrecht/-kosten im Detail — siehe `lizenzen.md`, hier nur die Verknüpfung über `license_id`.
