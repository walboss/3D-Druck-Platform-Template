# Implementierungsplan (Schritt 9)

Siehe `00-overview.md` für Architekturprinzipien (#-Nummern) und die FK-Ebenen aus §3, auf die dieser Plan direkt aufbaut. Ziel dieser Datei: aus den zehn Kern-Domänen-Specs + `audit-settings.md` eine tatsächlich ausführbare Supabase-Migration machen — Reihenfolge, RLS-Konzept, die kritischen atomaren Postgres-Funktionen (#31), Seed-Daten und Betriebsautomatisierung (Keepalive/Backup/Security aus `architektur-technologie-v1.md`).

**Aktualisiert nach der Spec-Gesamtprüfung** — alle Änderungen aus `bestellungen.md`, `angebote-individuelle-anfragen.md`, `produktion.md`, `kunden-warenkorb-tracking.md`, `produkte-varianten-farben.md`, `audit-settings.md`, `architektur-technologie-v1.md` und `00-overview.md` (Stand Schritt 9, zweite Runde) sind hier eingearbeitet.

`drucker-integration-bambu.md` (verschoben) und `produktdaten-import-3mf.md` (geplant, aber unabhängig umsetzbar für den Katalog-Import) sind **nicht** Teil dieses Plans. Das Parsing der `.gcode.3mf`-Datei für den optionalen Upload in `custom_requests` erfolgt ebenfalls auf Anwendungsebene (Angular/Edge Function, nicht Teil dieses Plans) — `fn_submit_custom_request` (§4) erhält bereits geparste Slot-Daten als `jsonb`-Parameter.

---

## 1. Migrations-Struktur

Eine Migration-Datei **je FK-Ebene** aus `00-overview.md` §3, plus eine Ebene 0 für globale Typen.

| # | Datei | Inhalt |
|---|---|---|
| 0000 | `enums_and_extensions` | alle ENUM-Typen zentral (siehe §2), `pgcrypto` für `gen_random_bytes`/`gen_random_uuid` |
| 0001 | `ebene1_stammdaten` | `colors`, `finishes`, `creators`, `admins`, `printers`, `customers`, `settings` |
| 0002 | `ebene2` | `products`, `filament_products`, `licenses` |
| 0003 | `ebene3` | `product_parts`, `product_variants`, `product_color_finish_options`, `filament_spools`, `license_product_links`, `license_cost_models`, `custom_requests` |
| 0004 | `ebene4` | `variant_parts`, `variant_configurations`, `product_bundles`, `custom_request_colors` |
| 0005 | `ebene5` | `variant_configuration_colors`, `bundle_items`, `offers`, `filament_movements` |
| 0006 | `ebene6` | `offer_items`, `calculation_versions` |
| 0007 | `ebene7` | `orders` |
| 0008 | `ebene8` | `order_items` (inkl. `desired_description`, `production_order_id` **ohne** FK-Constraint vorerst), `order_bundle_groups` |
| 0009 | `ebene9` | `finished_goods_movements`, `finished_goods_reservations`, `filament_reservations`, `cart_sessions`, `order_tracking_tokens` |
| 0010 | `ebene10` | `cart_items`, `production_orders` |
| 0011 | `ebene11` | `production_batch_items`, danach `ALTER TABLE order_items ADD CONSTRAINT fk_production_order FOREIGN KEY (production_order_id) REFERENCES production_orders(id)` |
| 0012 | `ebene12` | `production_material_usage`, `complaints`, `license_recurring_charges` |
| 0013 | `ebene13_audit` | `audit_log` |
| 00141–00148 | `fn_*` (mehrere Dateien, Teil 1–5d) | alle Postgres-Funktionen aus §4 — real als `00141`–`00148` statt der ursprünglich geplanten einzelnen `0014`: die Supabase-CLI verlangt `<Ziffern>_name.sql`, `0014a` ist keine gültige Nummer. `00141`–`00148` sortieren zwischen `0013` und den Folgemigrationen |
| 00149 | `rls_policies` | RLS-Aktivierung + Policies aus §3 |
| 00150 | `views` | Views aus §5 |
| 00151 | `seed` | Startdaten aus §6 |
| 00152 | `constraints_nachtrag` | Bundle-Gruppen-Konsistenz-Constraint, Katalogbezug-XOR-Constraint auf `order_items` (siehe §2) |

Die Folgemigrationen heißen `00149`–`00152`, **nicht** `0015`–`0018`: Diese kürzeren Nummern sortieren vor den real existierenden `00141`–`00148`, wodurch ein Neuaufbau der Migrationskette gegen eine frische Datenbank (relevant für die in `00-overview.md` §1 vorgesehene separate zweite Instanz) in falscher Reihenfolge liefe und abbräche.

Jede Ebenen-Migration enthält direkt `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **ohne** Policy — keine Tabelle geht je ungeschützt live, auch nicht kurzzeitig zwischen zwei Migrationen. Die eigentlichen Policies kommen erst in 00149.

---

## 2. Zentrale ENUM-Typen

- `order_status`: New, Confirmed, InProduction, Finished, ReadyForPickup, HandedOver, Cancelled
- `order_item_status`: Offen, WartetAufMaterial, InProduktion, Fertig, Storniert
- `production_order_status`: Geplant, Laeuft, Abgeschlossen, Fehlgeschlagen
- `reservation_status`: aktiv, freigegeben, verbraucht *(Filament)*
- `fg_reservation_status`: aktiv, freigegeben, verbraucht_bei_uebergabe *(Fertigware)*
- `license_status`: aktiv, abgelaufen, widerrufen
- `custom_request_status`: neu, geprueft, angebot_erstellt, abgelehnt
- `offer_status`: offen, akzeptiert, abgelehnt, abgelaufen, **widerrufen** *(neu)*
- `stock_type`: normal, b_ware
- `fg_movement_type`: produktion_erfolgreich, uebergabe, korrektur, ausschuss_umbuchung, sonstige
- `filament_movement_type`: einkauf, produktion, fehldruck, korrektur, sonstige
- `calc_scope_type`: product_variant, offer_item
- `calc_reason`: kundenwunsch, admin_korrektur, falsche_variante, sonstiger_grund
- `license_cost_type`: kostenlos, pro_stueck, einmalig, wiederkehrend, sonstige
- `complaint_decision`: ersatzproduktion, rueckerstattung, sonstige
- `order_source`: catalog, custom_offer

Nicht als Enum: `audit_log.entity_type`/`action` (freies `text`).

**Neue Constraints (Migration 00152, nach Existenz aller referenzierten Tabellen):**
- `order_items`: `CHECK ((product_id IS NOT NULL AND variant_id IS NOT NULL AND variant_configuration_id IS NOT NULL AND desired_description IS NULL) OR (product_id IS NULL AND variant_id IS NULL AND variant_configuration_id IS NULL AND desired_description IS NOT NULL))` — entweder voller Katalogbezug oder Freitext, nie Mischform, nie beides leer.
- `order_items`: Trigger `trg_check_bundle_group_order` — bei INSERT/UPDATE mit gesetztem `bundle_group_id` prüfen, dass `order_bundle_groups.order_id` der referenzierten Zeile mit `order_items.order_id` übereinstimmt.
- `custom_requests`/`custom_request_colors`: Anwendungsseitige Regel (kein harter DB-Constraint, da Wechsel zwischen einfarbig/mehrfarbig möglich sein muss) — entweder `custom_requests.color_id` gesetzt und keine `custom_request_colors`-Zeilen, oder umgekehrt.

---

## 3. RLS-Konzept

Zwei Rollen: `anon` (Storefront + Tracking, kein Login, #21) und der eine `admin`-Account über Supabase Auth (mit 2FA, siehe §7). Alles außer reinem Katalog-Lesen und Warenkorb-Verwaltung läuft über `SECURITY DEFINER`-RPC-Funktionen (§4), nicht über breite RLS-Policies.

**Kataloglesen (`anon` SELECT):** `products` (`active=true`), `product_variants` (`active=true`), `product_parts`, `variant_parts`, `colors`/`finishes` (`active=true`), `product_color_finish_options`, `variant_configurations`, `variant_configuration_colors`, `product_bundles` (`active=true`), `bundle_items`. **Katalogsuche/-durchstöberung** (neu, löst "nur direkt geteilte Links" ab) läuft über dieselbe `anon`-SELECT-Policy auf `products`/`tags` — kein RPC nötig, da reines Lesen ohne Validierungslogik; ein GIN-Index auf `products.tags` (Migration 0002) und ein einfacher B-Tree/Trigram-Index auf `name` genügen für die erwartete Katalog-/Nutzerzahl, kein Elasticsearch o. Ä.

**Nie für `anon` sichtbar:** `internal_note` auf `orders`, alle Kostenfelder in `calculation_versions` (#6/#7) — `calculation_versions` komplett ohne `anon`-SELECT-Policy, stattdessen View `v_order_tracking`/`v_catalog` (§5) mit nur `final_price`.

**Warenkorb (`anon`):** über schlanke `SECURITY DEFINER`-Wrapper-Funktionen (`fn_cart_add_item`, `fn_cart_update_item`, `fn_cart_get(session_token)`), nicht rohes Tabellen-RLS mit Token-Vergleich — verhindert, dass ein erratenes/fremdes `session_token` fremde Warenkörbe offenlegt.

**Tracking (`anon`):** ausschließlich über `fn_get_order_by_token(token)`.

**Individuelle Anfragen (`anon` INSERT):** über `fn_submit_custom_request(...)` — das Parsing der `.gcode.3mf`-Datei erfolgt auf Anwendungsebene (Angular/Edge Function); die Funktion erhält bereits geparste Slot-Daten als `jsonb`-Parameter und befüllt daraus `custom_request_colors`-Zeilen (§4).

**Angebots-Link (`anon`):** über `fn_get_offer_by_token(secure_token)` — prüft zusätzlich zu `valid_until`/`status='offen'` jetzt auch `revoked_at IS NULL`.

**Alles andere:** kein `anon`-Zugriff, weder lesend noch schreibend.

**`admin`-Rolle:** volle Policy auf allen Tabellen, gebunden an `auth.role() = 'authenticated'` (ein Account laut Spec, #17).

**Rate-Limiting/Bot-Schutz (§7):** greift auf Ebene der RPC-Aufrufe (`fn_place_order`, `fn_submit_custom_request`) und der Token-Lookup-Funktionen, nicht auf Ebene roher Tabellen-RLS.

---

## 4. Postgres-Funktionen (RPC) — die atomaren Kernoperationen (#31)

Jede Funktion kapselt Statuswechsel + Folgeaktionen + Audit-Log-Eintrag atomar. `actor` = `auth.uid()` bzw. `'system'` bei zeitgesteuerten Jobs.

### Bestellfluss
- **`fn_customer_search(phone, email)`** → Suche nach bestehendem `customers`-Datensatz für die aktive Kundenauswahl beim Checkout (Treffer bei Telefon **oder** E-Mail — großzügig, damit ein Kunde auch gefunden wird, wenn nur eines der beiden früher hinterlegt wurde, siehe `kunden-warenkorb-tracking.md` §5). **Gibt ausschließlich `boolean` zurück — niemals Namen, IDs oder andere Kundendaten** (siehe Sicherheitsregel in `kunden-warenkorb-tracking.md` §3: sonst wäre Enumeration von Kundendaten über durchprobierte Telefonnummern möglich). Ausführbar für `anon` (Checkout ist ohne Login), Bestätigt der Kunde im Frontend („ja, das bin ich"), löst `fn_place_order` die Zuordnung serverseitig anhand derselben Suchkriterien auf. Rate-Limiting/Bot-Schutz wie bei den anderen öffentlichen RPCs (§7).
- **`fn_create_variant_configuration_if_missing(variant_id, part_color_map jsonb)`** → prüft, ob die Kombination bereits als `variant_configuration`/`variant_configuration_colors` existiert; wenn nicht, legt sie sie an — **nur**, wenn die Kombination gegen `product_color_finish_options` gültig ist, sonst Fehler. Wird von `fn_place_order` intern aufgerufen.
- **`fn_place_order(cart_session_id, customer_id_or_new jsonb)`** → erzeugt ggf. `customers`, `orders` (`status='New'`), `order_items` aus `cart_items` (ruft je Position `fn_create_variant_configuration_if_missing` auf), referenziert die aktuell gültige `calculation_versions`-Zeile. Noch keine Reservierung.
- **`fn_confirm_order(order_id)`** → versucht je Position `SELECT ... FOR UPDATE` + `INSERT finished_goods_reservations`; erfolglose Positionen → `order_items.status = 'WartetAufMaterial'`. `orders.status → 'Confirmed'` nur, wenn alle aktiven Positionen erfolgreich reserviert wurden, sonst bleibt `orders.status = 'New'` (gemischtes Ergebnis laut `bestellungen.md` §5 möglich). Wichtigster `FOR UPDATE`-Kandidat (#5).
- **`fn_assign_to_production(order_item_id, production_order_id)`** → **Neu, Schritt 1 der Zwei-Schritte-Trennung.** Setzt `order_items.status → 'InProduktion'` und `order_items.production_order_id`, unabhängig vom Status des Zielauftrags. Keine Filamentreservierung.
- **`fn_start_production_order(production_order_id)`** → **Neu, Schritt 2.** Wird aufgerufen, wenn `production_orders.status: Geplant → Laeuft`. Iteriert alle zugeordneten `order_items` und löst für jede die Filamentreservierung aus (Spulenwahl kommt vom Admin je Position als Parameter, #18) — ersetzt die frühere `fn_start_production` pro Einzelposition durch eine Batch-Variante auf Auftragsebene, da der Trigger jetzt der Auftragsstatus ist, nicht die Einzelposition.
- **`fn_complete_order_item(order_item_id, qty_success, qty_scrap_normal, qty_scrap_complaint)`** → wie bisher: `production_batch_items`-Zeile, `finished_goods_movements`, `filament_reservations.status = 'verbraucht'`, `order_items.status = 'Fertig'` sobald erreicht. Bei Teilausfall bleibt der zugehörige `production_orders.status = 'Laeuft'` unverändert (kein Auto-Abschluss) — neue `production_batch_items`-Zeilen für Nachproduktion werden **demselben** `production_order` hinzugefügt.
- **`fn_ready_for_pickup(order_id)`** → prüft "keine Teilabholung" (#20) serverseitig.
- **`fn_hand_over_order(order_id, admin_id, handover_note)`** → `orders.status → 'HandedOver'`, Reservierungen → `verbraucht_bei_uebergabe` + `finished_goods_movements`, **und setzt `customers.anonymize_after = now() + settings.customer_data_retention_days`** (neu, DSGVO-Kopplung).
- **`fn_cancel_order_item(order_item_id, reason)`** / **`fn_cancel_order(order_id, reason)`** → wie bisher, Pflichtfeld `reason` (#32).
- **`fn_retry_pending_reservations()`** → **Neu.** Wird per `AFTER INSERT`-Trigger auf `finished_goods_movements` und `filament_movements` angestoßen (sofortiger Retry, nicht auf den nächsten Cron-Lauf warten). Sucht wartende `order_items`/Orders (`WartetAufMaterial` bzw. `orders.status='New'` mit mind. einer wartenden Position), sortiert **FIFO nach `orders.created_at`**, versucht erneut zu reservieren.

### Kalkulation
- **`fn_create_calculation_version(scope_type, scope_id, cost_components jsonb, margin_percent, reason)`** → unverändert: reiner `INSERT`, serverseitige `.49`/`.99`-Rundung (#29).

### Angebote
- **`fn_create_offer_from_request(custom_request_id, valid_from, valid_until, items jsonb)`** → unverändert, plus: kann auch aufgerufen werden, wenn `custom_requests.status` bereits `angebot_erstellt` ist (mehrfache Angebote zur selben Anfrage jetzt zulässig, siehe `angebote-individuelle-anfragen.md`).
- **`fn_accept_offer(secure_token)`** → prüft zusätzlich `revoked_at IS NULL`; ruft **nicht** `fn_place_order` auf — `cart_items.product_id` ist `NOT NULL` und damit strukturell inkompatibel zum Angebots-Fall. `fn_accept_offer` baut `orders`/`order_items` direkt auf (**alle** Positionen über den Ausnahmepfad `desired_description`, siehe `angebote-individuelle-anfragen.md` §3) und ruft danach `fn_confirm_order`.
- **`fn_revoke_offer(offer_id, revoke_reason)`** → **Neu.** Setzt `revoked_at`/`revoke_reason`, ändert `status` nicht.
- **`fn_submit_custom_request(..., slot_colors)`** → **Neu.** Legt `custom_requests` an. Parst die `.gcode.3mf`-Datei **nicht selbst** — das Parsing gehört auf die Anwendungsebene (Angular/Edge Function); der Funktion werden bereits geparste Slot-Daten als `jsonb` (`slot_colors`) übergeben. Legt daraus `custom_request_colors`-Zeilen je Slot an (Farbe per Hex-Bestabgleich, sonst `color_id IS NULL` zur späteren manuellen Zuordnung). `produktdaten-import-3mf.md` (das Parsing-Modul auf Anwendungsebene) bleibt unverändert.

### Zeitgesteuert (Cron, siehe §7)
- **`fn_expire_offers()`** — unverändert.
- **`fn_anonymize_customers()`** → **Neu.** `UPDATE customers SET first_name=…, last_name=…, email=NULL, phone=NULL, anonymized_at=now() WHERE anonymize_after <= now() AND anonymized_at IS NULL`.

### Generisch
- **`fn_write_audit(...)`** → unverändert, intern von allen obigen Funktionen aufgerufen. Zusätzlich AFTER-Trigger `trg_audit_settings` direkt auf `settings`.

---

## 5. Views für kundensichere Projektionen

- **`v_order_tracking`**: wie bisher, ergänzt um den Ausnahmepfad — zeigt `order_items.desired_description` anstelle von Produktname, wenn kein Katalogbezug existiert.
- **`v_catalog`**: unverändert.

---

## 6. Seed-Daten (Migration 00151)

- `settings`: eine Zeile inkl. `customer_data_retention_days = 730`, `electricity_price_per_kwh = 0.37`, `default_labor_rate_per_hour = 20.00` (entschieden).
- `admins`: ein Account, Passwort **und 2FA** über Supabase Auth Dashboard eingerichtet, nicht im Seed-SQL.
- Referenzdaten (`colors`, `finishes`): falls vorhanden, sonst leer starten.

---

## 7. Betriebsautomatisierung & Security-Härtung

Zwei getrennte GitHub-Actions-Workflows, da unterschiedliche Frequenzen sinnvoll sind:

**a) `supabase-keepalive-backup.yml`** (alle 3 Tage):
1. Keepalive: `SELECT 1`.
2. Backup: `pg_dump`, **verschlüsselt** (`gpg --symmetric`, Secret aus GitHub Actions Secrets), Ablage in privatem Repo oder Cloudflare R2.

**b) `scheduled-business-jobs.yml`** (täglich, ggf. stündlich für Angebots-Ablauf):
1. `fn_expire_offers()` — häufiger als Backup nötig.
2. `fn_anonymize_customers()` — täglich reicht.
3. `fn_retry_pending_reservations()` läuft **nicht** hier, sondern trigger-basiert (siehe §4) für sofortige Reaktion — dieser Job ist nur ein Fallback-Sicherheitsnetz, falls der Trigger je fehlschlägt (optional, niedrige Priorität).

**Zusätzliche Security-Maßnahmen (aus `architektur-technologie-v1.md` §4), Umsetzungsort:**
- Cloudflare Turnstile vor `fn_place_order`/`fn_submit_custom_request` im Angular-Frontend integriert, serverseitig über Supabase Edge Function oder direkt in der RPC-Funktion verifiziert.
- Token-Generierung (`order_tracking_tokens.token`, `offers.secure_token`) auf `encode(gen_random_bytes(16), 'hex')` umstellen (Migration 0009/0005) statt `gen_random_uuid()`.
- 2FA für den Admin-Account: Einrichtung im Supabase Auth Dashboard, kein Migrations-Schritt.
- Rate-Limiting auf Token-Lookup-RPCs: Supabase-Projekteinstellungen (PostgREST-Rate-Limits), keine Eigenentwicklung.

---

## 8. Offene Punkte, die noch eine Entscheidung von dir brauchen

1. **Backup-Ablageort:** privates GitHub-Repo vs. Cloudflare R2.
2. **Admin-Dashboard-Datenquelle:** eigene aggregierende View/Funktion oder clientseitige Aggregation aus Einzelabfragen?

Entschieden (nicht mehr offen):
- `customer_data_retention_days = 730`, `electricity_price_per_kwh = 0.37`, `default_labor_rate_per_hour = 20.00` (Seed-Werte, siehe §6).
- `custom_requests.status = 'geprueft'` bleibt im MVP ungenutzt — keine eigene Funktion vorgesehen, der Statuswert existiert im Enum, wird aber von keiner RPC-Funktion gesetzt oder benötigt.

---

## 9. Vorgeschlagene Umsetzungsreihenfolge (Meilensteine)

1. Migrationen 0000–0013 (Schema, noch ohne RLS/Funktionen) gegen ein lokales Supabase-Projekt durchlaufen lassen.
2. Migrationen 00141–00148 (RPC-Funktionen) — beginnend mit `fn_confirm_order`, `fn_place_order`, danach die neuen Zwei-Schritte-Funktionen (`fn_assign_to_production`, `fn_start_production_order`) und `fn_retry_pending_reservations`, da diese die komplexeste/neueste Transaktionslogik enthalten.
3. Migration 00149 (RLS) — erst danach, mit vollem `service_role`-Zugriff beim Testen in Schritt 2.
4. Migration 00150 (Views) + 00151 (Seed) + 00152 (nachträgliche Constraints).
5. Beide GitHub-Actions-Workflows (§7) einrichten, inkl. Backup-Verschlüsselung, bevor echte Daten entstehen.
6. Cloudflare Turnstile und 2FA einrichten, bevor der Storefront-Link erstmals öffentlich geteilt wird.
7. Erst danach Angular-Frontend gegen die fertige, RLS-geschützte API anbinden.

Diese Reihenfolge stellt sicher, dass die concurrency-kritische Logik (#5, #15, #31) getestet ist, bevor RLS eventuelle Fehler in den Funktionen selbst verschleiert, und dass Security-Härtung vor dem ersten öffentlichen Traffic steht, nicht danach nachgerüstet wird.
