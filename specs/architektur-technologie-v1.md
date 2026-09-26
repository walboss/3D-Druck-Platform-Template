# 3D-Druck-Bestellplattform — Architektur & Technologie v1 (Schritt 7, ergänzt in Schritt 9)

Prüfung der ursprünglichen Stack-Idee (Angular + Cloudflare Pages + Supabase) gegen die Anforderungen aus dem Datenmodell (`datenmodell-v1.md`). Stand der recherchierten Plattform-Fakten: September 2026 — vor dem finalen Aufsetzen des Projekts noch einmal auf `supabase.com/pricing` und `developers.cloudflare.com` gegenprüfen, Preise/Limits ändern sich.

---

## 1. Hosting: Cloudflare Pages → **Cloudflare Workers (mit Static Assets)**

Ursprüngliche Annahme war Cloudflare Pages. Aktueller Stand:

- Pages funktioniert weiterhin, Cloudflare hat zugesichert, dass bestehende Projekte unterstützt bleiben und Bugfixes erhalten — aber alle neuen Fähigkeiten (Durable Objects, Cron Triggers, Queue-Consumer, gradual deployments, Observability, Tail Workers) gehen ausschließlich an Workers.
- Workers kann inzwischen native statische Assets ausliefern — Assets werden über wrangler.toml definiert und kostenlos über Cloudflares Edge-CDN ausgeliefert, genau wie bei Pages.
- Die klare Trennung "statisch → Pages, dynamisch → Workers" gilt 2026 nicht mehr, weil ein einzelner Worker Frontend und Backend gemeinsam hosten kann — das hat Cloudflares eigene Empfehlung für neue Projekte verändert.

**Entscheidung:** Angular-Build als statische Assets über Cloudflare Workers ausliefern (nicht Pages). Git-Integration/Preview-Deployments, die Pages bot, funktionieren bei Workers inzwischen vergleichbar über die Tooling-Kette (Wrangler + CI). Für euer MVP ohne komplexe Edge-Logik ist das reine Asset-Hosting relevant — Workers-Funktionen kommen später nur ins Spiel, falls ihr echte Edge-Logik (z. B. Preisrundung serverseitig vor Auslieferung) direkt am CDN statt in Supabase haben wollt. Das ist nicht nötig, die komplette Geschäftslogik liegt ohnehin in Supabase (siehe unten) — Cloudflare bleibt reine Auslieferungsschicht.

---

## 2. Backend/Datenbank: Supabase — Eignung gegen die Architekturprinzipien

### RLS (Row Level Security)
Native Postgres-Funktion, von Supabase vollständig unterstützt. Deckt direkt:
- Prinzip #6/#7 (Kunde sieht nie interne Kosten/Notizen): Policies auf `orders`, `order_items`, `calculation_versions` — öffentliche/anonyme Rolle (Tracking-Token) sieht nur einen eingeschränkten View, keine Kostenspalten.
- Admin-Rolle (euer einzelner Account) mit vollem Zugriff über eine eigene Policy.

### Concurrency-sichere Reservierungen (Prinzip #5, #15, #31)
Das ist der wichtigste Fit-Check aus dem Datenmodell — und Postgres (also Supabase) ist dafür gut geeignet:
- `SELECT … FOR UPDATE` oder Serializable-Transaktionen für die Reservierungs-Inserts (`filament_reservations`, `finished_goods_reservations`).
- Die "Alles-oder-nichts"-Regel (§3.17) und die atomare Mehrpositions-Bestellannahme (Prinzip #15) lassen sich sauber als **Postgres-Funktion (PL/pgSQL)** kapseln, aufgerufen per RPC aus Angular — die ganze Transaktion (Statuswechsel + Reservierung + Lagerbewegung + Audit-Log-Eintrag) bleibt dann serverseitig atomar, nicht über mehrere Client-Requests verteilt. Das passt sehr direkt zu Prinzip #31 ("kein Statuswechsel ändert isoliert nur den Statuswert").

### Backups — **wichtigster Preis-Punkt für eure Entscheidung**
- Auf dem Free-Tier gibt es keine Backups, kein SLA, kein SSO.
- Erst der Pro-Plan bringt tägliche Backups; Point-in-Time-Recovery ist dort meist ein separat buchbarer Zusatz (auf der aktuellen Preisseite prüfen, das ändert sich gelegentlich).
- Das ist business-relevant: Sobald echte Kundenbestellungen/-daten im System sind, widerspricht "kein Backup" eurem eigenen Prinzip #1 ("historische Daten nie zerstören") — ein Hardware-/Datenbankausfall ohne Backup wäre ein Totalverlust der Historie, die ihr im Datenmodell so sorgfältig unveränderlich gehalten habt.

### Projekt-Pausierung auf Free-Tier
Free-Projekte pausieren nach 7 Tagen Inaktivität, die Postgres-Instanz wird heruntergefahren. Für euren Fall (Freunde/Bekannte bestellen unregelmäßig, öffentlicher Produktkatalog soll aber jederzeit erreichbar sein) ist das im Echtbetrieb ein Problem — ein Produktlink, der in Woche 2 ohne Aktivität geteilt wird, liefe ins Leere, bis das Projekt manuell reaktiviert wird.

### Aktuelle Preise/Limits im Überblick
| Plan | Preis | DB-Storage | Backups | Bemerkung |
|---|---|---|---|---|
| Free | 0 € | 500 MB, 1 GB File-Storage, 50.000 MAU, unlimitierte API-Requests | keine | pausiert nach 7 Tagen Inaktivität |
| Pro | 25 $/Monat inkl. 10 $ Compute-Credit | 8 GB inkl. | täglich | Compute wird ab Micro-Instanz zusätzlich abgerechnet, sofern Credit nicht reicht |

Für euer MVP (kleiner Datenbestand, wenige Nutzer, kein Compute-intensiver Workload) reicht die günstigste Compute-Stufe locker; euer DB-Volumen (Bestellungen, Filamente, Produkte) bleibt auf absehbare Zeit weit unter 8 GB.

**Finale Entscheidung:** Supabase Free bleibt dauerhaft die Datenbank (Priorität: kostenlos), Postgres-Anforderung ist damit erfüllt — Supabase *ist* PostgreSQL, keine separate Wahl nötig. Die zwei Free-Tier-Schwachstellen werden stattdessen kostenlos selbst geschlossen statt durch einen Plan-Wechsel:

- **Gegen die Pausierung nach 7 Tagen Inaktivität**: ein geplanter GitHub-Actions-Job (im kostenlosen Kontingent, auch bei privatem Repo) schickt alle paar Tage automatisch eine kleine Abfrage gegen die DB.
- **Gegen fehlende Backups**: derselbe Job erstellt zusätzlich regelmäßig einen `pg_dump` und legt ihn kostenlos ab (privates GitHub-Repo oder Cloudflare R2, beides im Free-Kontingent für die zu erwartende Datenmenge) — **verschlüsselt**, siehe §4.

Ein Wechsel auf Supabase Pro (≈25 $/Monat) ist damit nicht mehr Teil der Planung — bewusste Entscheidung gegen Stabilität-durch-Bezahlplan, zugunsten von Stabilität-durch-eigenen-Automatismus bei 0 € laufenden Kosten.

### Auth
Supabase Auth deckt den einzelnen Admin-Account (E-Mail+Passwort, §3.15, sowie optional Google-OAuth — führt zum selben Konto) trivial ab. **2FA wird aktiviert** (siehe §4) — kostenlos inkludiert, bei nur einem Account mit Vollzugriff auf Kunden- und Finanzdaten sinnvoll trotz #17 ("einfach halten").

### Edge Functions / Realtime
Nicht zwingend erforderlich für euer Modell — die zeitkritische Logik gehört in Postgres-Funktionen (Transaktionssicherheit), nicht in Edge Functions. Realtime (z. B. Admin-Dashboard live aktualisieren, wenn eine neue Bestellung reinkommt) ist ein **optionales Nice-to-have**, kein Blocker fürs MVP — Supabase bietet es kostenlos in begrenztem Umfang, falls ihr es später wollt.

---

## 3. Offene Punkte, die noch eine Entscheidung von dir brauchten

1. ~~Backup-Budget~~ — **geklärt:** Supabase Free bleibt, Backup/Keepalive über eigenen kostenlosen GitHub-Actions-Job statt Pro-Plan (siehe oben).
2. ~~Cloudflare Pages vs. Workers~~ — **geklärt:** Start direkt mit Workers (Static Assets), nicht mit Pages.
3. **E-Mail-Technologie (Punkt E aus dem Originaldokument)** — **Provider entschieden: Resend** (3.000 E-Mails/Monat dauerhaft kostenlos, einfache HTTP-API, für die zu erwartende Bestellmenge weit ausreichend). Bewusst **nur vorbereitet, noch nicht implementiert**: kein Versand-Code, keine Templates, keine Trigger-Anbindung an Statuswechsel — das folgt erst, wenn das E-Mail-System aktiv geschaltet wird (`settings.email_system_enabled`). Bis dahin bleibt nur festgehalten, welcher Provider es sein wird.

**Schritt 7 ist damit abgeschlossen.** Finaler Stack: Angular (UI-Komponenten: **PrimeNG**) + Cloudflare Workers (Static Assets) + Supabase Free (Postgres/RLS/Auth) + eigener GitHub-Actions-Job für Keepalive/Backup + Resend (vorbereitet, nicht implementiert).

PrimeNG betrifft ausschließlich die UI/UX-Umsetzung (Punkt P aus dem Originaldokument, dort noch als "Details offen" vermerkt) — hat keinen Einfluss auf Datenmodell oder die Backend-Specs aus Schritt 8.

---

## 4. Security-Ergänzungen (aus der Spec-Gesamtprüfung, Schritt 9)

Fünf Punkte, die bei der Prüfung der zehn Kern-Specs gegen mögliche Sicherheits-/Datenschutzlücken identifiziert wurden und vor dem ersten echten Kundendatensatz umgesetzt sein sollten:

1. **Backup-Verschlüsselung.** Der `pg_dump` aus dem GitHub-Actions-Job (§2) wird vor Ablage verschlüsselt — `gpg --symmetric` mit einem Secret aus GitHub Actions Secrets, nicht im Repo abgelegt. Backups enthalten `customers` (personenbezogene Daten) und die Kostenfelder aus `calculation_versions` — "privates Repo" allein ist kein ausreichender Schutz, insbesondere weil `customers` bereits eine DSGVO-Anonymisierung vorsieht, die ein Klartext-Backup faktisch aushebeln würde.
2. **DSGVO-Anonymisierungs-Cronjob.** Täglicher Job, der `customers WHERE anonymize_after <= now() AND anonymized_at IS NULL` sucht und anonymisiert (siehe `kunden-warenkorb-tracking.md` für die fachliche Regel, wann `anonymize_after` gesetzt wird). Läuft als zweiter, von Keepalive/Backup unabhängiger Workflow (andere sinnvolle Frequenz: täglich statt alle paar Tage). `actor='system'` im Audit-Log (siehe `audit-settings.md`).
3. **Bot-/Spam-Schutz.** Die öffentlichen Formulare (Bestellabgabe, Einreichen einer individuellen Anfrage) bekommen ein Rate-Limiting/Captcha vorgeschaltet — empfohlen: Cloudflare Turnstile (kostenlos, passt zum bestehenden Cloudflare-Einsatz als Hosting-Layer, keine zusätzliche Abhängigkeit).
4. **Token-Sicherheit.** `order_tracking_tokens.token` und `offers.secure_token` werden mit mindestens 128 Bit Entropie generiert (`encode(gen_random_bytes(16), 'hex')` statt `gen_random_uuid()`, das nur ca. 122 Bit liefert). Rate-Limiting auf die Token-Lookup-Funktionen erfolgt über Supabase-eigene Mechanismen (PostgREST-/Edge-Function-Rate-Limits) — keine Eigenentwicklung nötig, damit an Supabase-Bordmitteln festgehalten wird statt an einer selbstgebauten Lösung.
5. **2FA für den Admin-Account.** Wird über Supabase Auth aktiviert (kostenlos enthalten). Bei nur einem Account mit Vollzugriff auf alle Kunden- und Finanzdaten sinnvoll, auch wenn #17 grundsätzlich für Einfachheit plädiert — hier überwiegt das Risiko eines kompromittierten Einzelaccounts.

Diese fünf Punkte sind Ergänzungen zur technischen Umsetzung, nicht zum Datenmodell selbst — keine der zehn Kern-Domänen-Specs muss deswegen ihr Schema ändern (Ausnahme: `offers`/`order_tracking_tokens` haben ohnehin schon `revoked_at`/`revoke_reason`-Felder, dokumentiert in `angebote-individuelle-anfragen.md` bzw. war schon vorhanden in `kunden-warenkorb-tracking.md`).
