# Specs — 00 Overview

Zentrale Referenz für alle Spec-Dateien in diesem Verzeichnis. Jede Domänen-Spec verweist hierher statt Inhalte zu wiederholen — bei einer Coding-Aufgabe genügt diese Datei plus die eine relevante Domänen-Spec als Kontext.

---

## 1. Die 32 Architekturprinzipien (zentral, einmalig)

1. Historische Daten niemals zerstören.
2. Produkte deaktivieren statt löschen.
3. Planung, Reservierung und Realität strikt trennen.
4. Tatsächlichen Verbrauch immer nachvollziehbar speichern.
5. Reservierungen müssen concurrency-safe sein.
6. Kunde darf niemals interne Kosten sehen.
7. Interne Notizen niemals öffentlich machen.
8. Kalkulationen versionieren.
9. Alte Bestellungen dürfen sich durch neue Preise nicht verändern.
10. Farbe und konkretes Filament trennen.
11. Lizenzrecht und Lizenzkosten trennen.
12. Fertigwaren- und Filamentbestand trennen.
13. Bestellung und Produktionsfortschritt trennen.
14. Ein Warenkorb reserviert keinen Bestand.
15. Bestellannahme mit mehreren Positionen muss atomar sein.
16. E-Mail darf nicht kritisch für die Geschäftslogik sein.
17. MVP einfach halten, aber Erweiterbarkeit ermöglichen.
18. Keine automatische Filamentauswahl ohne Adminentscheidung.
19. Keine automatische Stornierung nicht abgeholter Bestellungen im MVP.
20. Keine Teilabholung im MVP.
21. Keine Kundenkonten im MVP.
22. Keine Onlinezahlung im MVP.
23. Kein Versand im MVP.
24. Produktteile eigene Entität.
25. Produktionsauftrag bündelt mehrere Positionen.
26. Bundles rein organisatorisch.
27. Jede Angebotsänderung neue Kalkulationsversion.
28. Reklamationsersatzproduktion getrennt von Ausschuss.
29. Verkaufspreise immer aufgerundet (.49/.99).
30. Fertigware sofort, Material erst bei Produktionsstart reserviert.
31. Statuswechsel + Folgeaktionen atomar, Rollback bei Fehlschlag.
32. Stornierungsgrund Pflicht auf Positions- und Bestellungsebene.

Domänen-Specs referenzieren diese Liste nur mit der Nummer (z. B. "Prinzip #5"), ohne den Text zu wiederholen.

**Zusatzprinzip aus Schritt 9 (Coding-Review), kein eigenes #: Ein Betreiber = eine Instanz.** Das gesamte Datenmodell geht bewusst von genau einem Betreiber aus (eine `settings`-Zeile, `admins` ohne Mandantentrennung, kein `tenant_id` auf irgendeiner Tabelle). Ein zweiter Betreiber (z. B. ein Bekannter, der die Plattform selbst als Admin führen will) bekommt eine **komplett separate Instanz** — eigenes Supabase-Projekt, eigener Cloudflare-Worker, eigenes Repo/eigene Secrets, identischer Code. Das ist bewusst der vorgesehene Skalierungsweg, keine Notlösung — Multi-Tenancy innerhalb einer gemeinsamen Datenbank ist **nicht** Teil dieses Datenmodells und sollte auch später nicht nachgerüstet werden, ohne das gesamte RLS-/Schema-Konzept neu zu durchdenken.

---

## 2. Datei-Zuordnung — welche Entität steht wo

| Spec-Datei | Tabellen |
|---|---|
| `produkte-varianten-farben.md` | `products`, `product_variants`, `product_parts`, `variant_parts`, `colors`, `finishes`, `product_color_finish_options`, `variant_configurations`, `variant_configuration_colors`, `product_bundles`, `bundle_items` |
| `filament-material.md` | `filament_products`, `filament_spools`, `filament_movements`, `filament_reservations` |
| `fertigwarenbestand.md` | `finished_goods_movements`, `finished_goods_reservations` |
| `kunden-warenkorb-tracking.md` | `customers`, `cart_sessions`, `cart_items`, `order_tracking_tokens` |
| `angebote-individuelle-anfragen.md` | `custom_requests`, `custom_request_colors`, `offers`, `offer_items` |
| `bestellungen.md` | `orders`, `order_items`, `order_bundle_groups` |
| `produktion.md` | `production_orders`, `production_batch_items`, `production_material_usage`, `printers`, `complaints` |
| `kalkulation.md` | `calculation_versions` |
| `lizenzen.md` | `creators`, `licenses`, `license_product_links`, `license_cost_models`, `license_recurring_charges` |
| `audit-settings.md` | `audit_log`, `settings`, `admins` |
| `produktdaten-import-3mf.md` (geplant, unabhängig) | `product_slice_imports` |
| `drucker-integration-bambu.md` (verschoben) | `printer_connections`, `ams_color_mappings` |
| `16-admin-dashboard.md` | keine eigenen Tabellen — Views auf bestehenden Tabellen (`v_dashboard_orders_open`, `v_dashboard_stock_low`, `v_dashboard_production_running`, …) |
| `17-storefront-katalog-checkout.md` | keine eigenen Tabellen — Frontend-Spezifikation (Katalog, Produktdetail, Warenkorb, Checkout, Bestätigung) auf `v_catalog`, `cart_sessions`, `cart_items`, `fn_customer_search`, `fn_place_order`, `fn_get_order_by_token` |
| `18-storefront-anfrage-angebot-tracking.md` | keine eigenen Tabellen — Frontend-Spezifikation (Individualanfrage, Angebotsansicht, Bestell-Tracking) auf `fn_submit_custom_request`, `fn_accept_offer`, `fn_reject_offer`, `fn_get_order_by_token` |
| `19-admin-dashboard-bestellverwaltung.md` | keine eigenen Tabellen — Frontend-Spezifikation (Dashboard, Bestellübersicht/-verwaltung) auf `v_dashboard_orders_open`, `v_dashboard_stock_low`, `v_dashboard_production_running`, `fn_confirm_order`, `fn_assign_to_production`, `fn_start_production_order`, `fn_add_position_to_running_order`, `fn_ready_for_pickup`, `fn_hand_over_order`, `fn_cancel_order_item`, `fn_cancel_order` |
| `20-admin-produktionsverwaltung.md` | keine eigenen Tabellen — Frontend-Spezifikation (Produktionsverwaltung) auf `fn_create_production_order`, `fn_assign_to_production`, `fn_start_production_order`, `fn_complete_order_item`, `fn_complete_production_order`, `fn_fail_production_order` |
| `21-admin-katalogpflege.md` | keine eigenen Tabellen — Frontend-Spezifikation (Katalogpflege) auf `products`, `product_variants`, `colors`, `finishes`, `fn_create_calculation_version`, `fn_round_up_to_49_99` |
| `22-admin-angebote-anfragen.md` | keine eigenen Tabellen — Frontend-Spezifikation (Angebote & Individualanfragen-Postfach) auf `custom_requests`, `fn_create_offer_from_request`, `fn_reject_custom_request`, `fn_revoke_offer`, `fn_reject_offer`, `fn_expire_offers` |
| `23-admin-lager-filament.md` | keine eigenen Tabellen — Frontend-Spezifikation (Lager/Filament) auf den Filamentbestand-/Bewegungstabellen, `fn_book_b_ware` |
| `24-admin-reklamationen.md` | keine eigenen Tabellen — Frontend-Spezifikation (Reklamationen) auf `fn_report_complaint`, `fn_resolve_complaint` |
| `25-admin-settings.md` | keine eigenen Tabellen — Frontend-Spezifikation (Settings) auf `settings` |

---

## 3. FK-Abhängigkeitsreihenfolge (Bau-Reihenfolge für Schritt 9)

Je Ebene keine Abhängigkeit auf eine spätere Ebene — Ebene 1 kann komplett ohne jede andere Tabelle angelegt werden, Ebene 2 nur auf Ebene 1 usw.

1. `colors`, `finishes`, `creators`, `admins`, `printers`, `customers`, `settings` *(keine Fremdabhängigkeiten)*
2. `products`, `filament_products`, `licenses` *(→ 1)*
3. `product_parts`, `product_variants`, `product_color_finish_options`, `filament_spools`, `license_product_links`, `license_cost_models`, `custom_requests` *(→ 2)*
4. `variant_parts`, `variant_configurations`, `product_bundles`, `custom_request_colors` *(→ 3)*
5. `variant_configuration_colors`, `bundle_items`, `offers`, `filament_movements` *(→ 4)*
6. `offer_items`, `calculation_versions` *(scope_type kann sich auf 4 oder 5 beziehen)* *(→ 5)*
7. `orders` *(→ 6, referenziert optional `offers`)*
8. `order_items`, `order_bundle_groups` *(→ 7; `order_items.production_order_id` verweist vorwärts auf Ebene 10 — als nullable FK unproblematisch, wird erst beim Zuordnen zur Produktion befüllt)*
9. `finished_goods_movements`, `finished_goods_reservations`, `filament_reservations`, `cart_sessions`, `order_tracking_tokens` *(→ 8)*
10. `cart_items`, `production_orders` *(→ 9)*
11. `production_batch_items` *(→ 10)*
12. `production_material_usage`, `complaints`, `license_recurring_charges` *(→ 11)*
13. `audit_log` *(entity-übergreifend, technisch unabhängig, aber inhaltlich erst sinnvoll, wenn Ebene 1–12 existieren)*

*(`product_slice_imports` → nach Ebene 3 (`product_variants` existiert), sobald `produktdaten-import-3mf.md` umgesetzt wird. `printer_connections`, `ams_color_mappings` → nach Ebene 1, erst wenn `drucker-integration-bambu.md` reaktiviert wird.)*

**Hinweis zur Vorwärtsreferenz `order_items.production_order_id`:** `order_items` (Ebene 8) referenziert `production_orders` (Ebene 10). Das ist technisch nur möglich, weil die Spalte nullable ist und der FK erst per `ALTER TABLE` nach Anlage von Ebene 10 hinzugefügt werden kann — Migration 0008 legt die Spalte ohne FK-Constraint an, Migration 0010/0011 ergänzt den Constraint nachträglich. Alternative: Spalte und Constraint komplett in einer späteren Migration nach Ebene 10 ergänzen (`ALTER TABLE order_items ADD COLUMN ...`), statt sie in Ebene 8 vorzusehen — technische Entscheidung für die Umsetzung, keine fachliche.

---

## 4. Format aller Domänen-Specs

Jede Datei unter `specs/` folgt demselben Aufbau:

1. **Zweck** — was diese Domäne fachlich abdeckt, in 2–3 Sätzen.
2. **Tabellen** — vollständige Feldliste inkl. PK/FK für eigene Tabellen; bei referenzierten Fremd-Tabellen nur Verweis auf die zuständige Spec-Datei, keine Wiederholung der Definition.
3. **Geschäftsregeln** — die relevanten Regeln aus `business-spezifikation-v2.md`, als Fließtext.
4. **Statusübergänge** — falls die Domäne Status-Felder hat: erlaubte Übergänge, Pflichtfelder je Übergang (z. B. Stornierungsgrund).
5. **Randfälle** — bekannte Edge Cases aus der Klärungsrunde, die diese Domäne betreffen.
6. **Abhängigkeiten** — welche anderen Spec-Dateien vorausgesetzt werden.
7. **Nicht Teil dieser Spec** — explizit, was woanders geregelt ist, um Scope-Creep bei Coding-Aufgaben zu vermeiden.
