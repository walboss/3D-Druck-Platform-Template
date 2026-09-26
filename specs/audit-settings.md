# Spec: Audit Log & Settings

Siehe `00-overview.md` für Architekturprinzipien (referenziert als #-Nummer) und FK-Reihenfolge.

---

## 1. Zweck

Zentrale, entitätsübergreifende Protokollierung aller relevanten Statuswechsel und Feldänderungen (#1) — ersetzt parallele Status-Historientabellen pro Entität. Dazu globale Einstellungen und der/die Admin-Account(s).

---

## 2. Tabellen

### `audit_log`
| Feld | Typ | Hinweis |
|---|---|---|
| id | PK | |
| entity_type | text | z. B. `order`, `order_item`, `filament_reservation` |
| entity_id | uuid | |
| action | text | z. B. `status_change`, `field_update` |
| field_name | text nullable | |
| old_value, new_value | text nullable | |
| reason | text nullable | |
| actor | text | Admin-ID oder `'system'` |
| created_at | timestamp | |

Wird **nie** überschrieben oder gelöscht — einzige Ausnahme im gesamten Datenmodell von "kein Löschen" ist nicht dieser Fall; hier gilt die Regel uneingeschränkt.

### `settings`
Key-Value oder Spaltentabelle, je nach Umsetzung in Schritt 9/10:
- `email_system_enabled` (Default: aus)
- `email_required_at_order` (Default: aus)
- `electricity_price_per_kwh`
- `default_labor_rate_per_hour`
- `min_order_value` (falls später aktiviert)
- `customer_data_retention_days` (int, **Neu**, Default z. B. 730) — steuert, wie lange nach Bestellabschluss (`orders.status → HandedOver`) bis zur automatischen DSGVO-Anonymisierung eines Kunden vergeht, siehe `kunden-warenkorb-tracking.md`.

### `admins`
| id PK | email (unique) | password_hash | active |

Nur ein Account laut aktueller Spezifikation, aber als Tabelle modelliert (nicht hart codiert) — spätere Rollenverwaltung ohne Umbau möglich (#17). 2FA wird über Supabase Auth aktiviert (siehe `architektur-technologie-v1.md`), kein Zusatzfeld hier nötig.

---

## 3. Geschäftsregeln

- Jeder Statuswechsel in jeder anderen Domäne erzeugt einen `audit_log`-Eintrag — kein isolierter Statuswert-Update ohne begleitenden Log-Eintrag (#31).
- E-Mail ist über `settings.email_system_enabled` global an-/abschaltbar und darf an keiner Stelle Voraussetzung für einen Kernprozess sein (#16) — Statuswechsel, Reservierungen, Bestellabwicklung funktionieren unabhängig davon.
- Keine parallelen Status-Historientabellen pro Entität — Ausnahme sind die wenigen denormalisierten Bequemlichkeits-Zeitstempel direkt auf `orders` (siehe `bestellungen.md`), die für schnelle Abfragen existieren, aber `audit_log` als vollständige Quelle nicht ersetzen.
- Interne Felder (z. B. `orders.internal_note`, alle Kostenfelder in `calculation_versions`) sind nur für Admins lesbar — Zugriffskontrolle (RLS) wird hier als Anforderung festgehalten, die konkrete Policy-Definition gehört zur technischen Umsetzung (Schritt 9/10, siehe `implementierungsplan-schritt9.md`).
- Zeitgesteuerte Systemprozesse (Angebots-Ablauf, DSGVO-Anonymisierung, automatischer Reservierungs-Retry) schreiben ihre Änderungen ebenfalls ins `audit_log`, `actor = 'system'` — siehe Randfälle.

---

## 4. Statusübergänge

Kein eigener Status auf `audit_log` selbst (append-only). `admins.active` kann deaktiviert werden (kein Löschen), kein weiterer Übergang vorgesehen im MVP.

---

## 5. Randfälle

- **Massenänderung durch Systemprozess** (z. B. automatischer Ablauf eines Angebots, DSGVO-Anonymisierung, automatischer Reservierungs-Retry bei Materialeingang): `actor = 'system'` statt einer Admin-ID — muss im Log klar von manuellen Admin-Aktionen unterscheidbar sein.
- **Sehr viele Audit-Einträge über Zeit:** Kein Archivierungsmechanismus im MVP vorgesehen (#17, einfach halten) — Skalierungsfrage für später, nicht Teil dieser Spec.
- **`settings`-Änderung selbst:** Wird ebenfalls im `audit_log` erfasst (`entity_type = 'settings'`), damit nachvollziehbar bleibt, wann z. B. `email_system_enabled` oder `customer_data_retention_days` umgeschaltet wurde.

---

## 6. Abhängigkeiten

- Wird von **allen** anderen Kern-Specs referenziert (Statuswechsel-Protokollierung) — selbst aber ohne inhaltliche Abhängigkeit auf sie (rein generische FK-lose Verknüpfung über `entity_type`/`entity_id`).
- `orders.handed_over_by` (siehe `bestellungen.md`) referenziert `admins`.
- `kunden-warenkorb-tracking.md` — nutzt `settings.customer_data_retention_days`.

---

## 7. Nicht Teil dieser Spec

- Konkrete RLS-Policy-Definitionen (wer darf was lesen) — technische Umsetzung, siehe `architektur-technologie-v1.md`/`implementierungsplan-schritt9.md`.
- E-Mail-Versandlogik selbst — siehe die separate, noch nicht umgesetzte E-Mail-Anbindung (Resend, vorbereitet in `architektur-technologie-v1.md`).
- Rollen-/Rechteverwaltung über einen einzelnen Admin-Account hinaus — nicht im MVP. Mehrere unabhängige Betreiber laufen als komplett separate Instanzen, siehe `00-overview.md` §1.
- 2FA-Umsetzung im Detail, Backup-Verschlüsselung, Bot-/Spam-Schutz, Token-Entropie — siehe `architektur-technologie-v1.md`.
