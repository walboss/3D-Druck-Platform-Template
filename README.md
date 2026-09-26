# 3D-Druck-Platform-Vorlage

Vorlage für deinen eigenen 3D-Druck-Katalog bzw. -Shop: Kunden stöbern im
Katalog, bestellen oder schicken individuelle Anfragen — du behältst im
Admin-Bereich den Überblick über Bestellungen, Produktion und Filamentbestand.

**➡️ Zum Aufsetzen einfach der [Schritt-für-Schritt-Anleitung](ANLEITUNG.md) folgen.**
Keine Programmierkenntnisse nötig, alles läuft auf kostenlosen Tarifen.

## Technik (nur zur Info)

| Teil | Technik |
|---|---|
| Datenbank, Login | Supabase (Postgres) — `supabase/migrations/` |
| Webseite | Angular + PrimeNG auf Cloudflare Workers — `frontend/` |
| API (Bestellungen mit Bot-Schutz) | Cloudflare Worker + Turnstile — `cloudflare-worker/` |
| Aufräumjobs, Backup | GitHub Actions — `.github/workflows/` |
| Fachliche Beschreibung | `specs/` |

## Wichtige Hinweise

- **MakerWorld-Import:** nutzt die öffentliche, aber **inoffizielle** JSON-API
  von MakerWorld. Sie ist nicht dokumentiert und kann sich jederzeit ändern —
  dann liefert der Import ggf. keine Werte mehr (alles bleibt manuell
  eintragbar).
- **Modelle und Bilder von MakerWorld** gehören den jeweiligen Designerinnen
  und Designern. Vor dem Verkauf gedruckter Modelle deren **Lizenz prüfen**
  (viele erlauben nur private Nutzung). Importierte Bilder sind Hotlinks auf
  MakerWorld.
- **Impressum & Datenschutz** (`frontend/src/app/features/storefront/legal/`)
  sind Vorlagen mit Platzhaltern, **keine Rechtsberatung** — siehe
  [Anleitung](ANLEITUNG.md), Abschnitt „Impressum & Datenschutz“.
- Nutzung auf eigenes Risiko, ohne Gewähr.

## Lizenz

Der Code dieser Vorlage steht unter [MIT](LICENSE) — frei nutzbar, auch
kommerziell; der Lizenzhinweis muss erhalten bleiben.

### Verwendete Bibliotheken (eigene Lizenzen)

| Paket | Lizenz |
|---|---|
| **PrimeNG**, PrimeIcons, `@primeuix/*` (PrimeTek) | **PrimeUI License** — eigener Lizenzschlüssel nötig; kostenlose Community-Lizenz für Privatpersonen und kleine Firmen, sonst kostenpflichtig. Siehe [Anleitung Schritt 3.3](ANLEITUNG.md) und <https://primeui.dev/licenses/community> |
| Angular | MIT |
| Supabase JS | MIT |
| Schrift Inter (`@fontsource/inter`) | SIL Open Font License 1.1 |
| RxJS | Apache 2.0 |
| Wrangler (Cloudflare) | MIT oder Apache 2.0 |

Die MIT-Lizenz dieser Vorlage gilt **nicht** für diese Bibliotheken — für sie
gelten jeweils ihre eigenen Bedingungen.
