# Anleitung: Eigene 3D-Druck-Plattform aufsetzen

Diese Anleitung ist für alle, die die Plattform **für sich selbst** betreiben
wollen — mit eigenem Shop, eigener Datenbank und eigenem Admin-Zugang.
Du brauchst keine Programmierkenntnisse, nur etwas Geduld (ca. 1–2 Stunden
beim ersten Mal). Alles läuft auf **kostenlosen** Tarifen.

> **Wichtig:** Jede Person bekommt eine komplett eigene Instanz. Du teilst dir
> nichts mit jemand anderem — keine Datenbank, keine Bestellungen, keinen Login.

---

## Überblick: Was am Ende läuft

| Teil | Wo | Wofür |
|---|---|---|
| Datenbank + Login | **Supabase** | Produkte, Bestellungen, Filament, Admin-Login |
| Shop-Webseite | **Cloudflare** (Worker `3d-druck-platform`) | Das, was Kunden und du im Browser sehen |
| API | **Cloudflare** (Worker `3d-druck-platform-api`) | Bestellungen/Anfragen mit Bot-Schutz |
| Code + Automatik | **GitHub** | Code-Ablage, tägliche Aufräumjobs, Backups |

Ergebnis: Dein Shop unter `https://3d-druck-platform.<DEIN-NAME>.workers.dev`,
dein Admin-Bereich unter `.../admin/login`.

---

## Schritt 0 — Vorbereitung (einmalig)

### 0.1 Programme installieren
1. **Node.js** (Version 22 „LTS“): <https://nodejs.org> → großen grünen Button,
   installieren, alles auf Standard lassen.
2. **Git**: <https://git-scm.com/downloads> → installieren, alles auf Standard.
3. **Visual Studio Code** (Editor, für Schritt 4): <https://code.visualstudio.com>
4. Eine **Authenticator-App** aufs Handy (z. B. Google Authenticator,
   Microsoft Authenticator, 2FAS) — für den sicheren Admin-Login.

Prüfen, ob alles da ist — Terminal öffnen (Windows: „PowerShell“ im Startmenü,
Mac: „Terminal“) und eintippen:

```bash
node -v
git --version
```

Beide Befehle müssen eine Versionsnummer anzeigen (Node: `v22.…`).

### 0.2 Konten anlegen (alle kostenlos)
- **GitHub**: <https://github.com/signup>
- **Supabase**: <https://supabase.com> → „Start your project“ (am einfachsten
  „Continue with GitHub“)
- **Cloudflare**: <https://dash.cloudflare.com/sign-up>

### 0.3 Notizzettel anlegen
Öffne eine leere Textdatei **nur auf deinem Rechner** (nicht ins Repo legen,
nicht verschicken!). Dort sammelst du die Werte, die du unterwegs bekommst.
Die mit 🔒 markierten Werte sind **geheim**:

```
SUPABASE PROJECT-ID (Ref):      ...
SUPABASE URL:                   https://<PROJECT-ID>.supabase.co
SUPABASE ANON KEY:              ...
🔒 SUPABASE SERVICE ROLE KEY:   ...
🔒 SUPABASE DATENBANK-PASSWORT: ...
🔒 SUPABASE DB-URL:             postgresql://...
CLOUDFLARE SUBDOMAIN:           <DEIN-NAME>   (aus <DEIN-NAME>.workers.dev)
TURNSTILE SITE KEY:             0x...
🔒 TURNSTILE SECRET KEY:        0x...
ADMIN E-MAIL:                   ...
```

---

## Schritt 1 — Code in dein eigenes GitHub holen

Du holst dir eine eigene Kopie dieser Vorlage. Den Link zur Vorlage findest
du auf ihrer GitHub-Seite: grüner Button **„Code“** → HTTPS-Adresse kopieren
(endet auf `.git`).

1. Auf GitHub oben rechts **„+“ → „New repository“**.
   - Name: z. B. `3D-Druck-Platform`
   - **Private** auswählen
   - **Keine** README/Lizenz/.gitignore ankreuzen → „Create repository“
2. Im Terminal (ersetze `<LINK-ZUR-VORLAGE>` und `<DEIN-GITHUB-NAME>`):

```bash
git clone <LINK-ZUR-VORLAGE> 3D-Druck-Platform
cd 3D-Druck-Platform
git remote rename origin vorlage
git remote add origin https://github.com/<DEIN-GITHUB-NAME>/3D-Druck-Platform.git
git push -u origin main
```

Jetzt liegt eine eigene Kopie in deinem GitHub. Über `vorlage` kannst du
später Updates holen (siehe Schritt 11).

3. Einmal die Grundpakete installieren (im Ordner `3D-Druck-Platform`):

```bash
npm install
```

---

## Schritt 2 — Supabase (Datenbank) einrichten

### 2.1 Projekt anlegen
1. Supabase-Dashboard → **„New project“**.
2. Name: beliebig, z. B. `3d-druck`.
3. **Database Password**: auf „Generate a password“ klicken und
   **sofort in den Notizzettel kopieren** 🔒.
4. Region: **Europe – Frankfurt (eu-central-1)** (oder eine andere EU-Region).
5. „Create new project“ → ein paar Minuten warten.

### 2.2 Werte abschreiben
- **Project Settings → General**: *Project ID* (z. B. `abcdefghijklmnop`)
  → Notizzettel. Deine URL ist `https://<PROJECT-ID>.supabase.co`.
- **Project Settings → API Keys**: *anon / public* Key und
  *service_role* Key (🔒, auf „Reveal“ klicken) → Notizzettel.
- Oben auf **„Connect“** → Reiter „Connection String“ → **„Session pooler“**
  → die `postgresql://...`-Adresse kopieren, `[YOUR-PASSWORD]` durch dein
  Datenbank-Passwort ersetzen → Notizzettel als 🔒 **DB-URL**.

### 2.3 Login-Einstellungen (Sicherheit!)
**Authentication → Sign In / Providers**:
- **„Allow new users to sign up“ = AUS** (sonst könnte sich jeder registrieren)
- Unter „Email“: **„Leaked password protection“ AN**,
  **Minimum password length = 12**

**Authentication → Multi-Factor**: *TOTP (App Authenticator)* muss
**aktiviert** sein (Standard).

### 2.4 Deinen Admin-Account anlegen
**Authentication → Users → „Add user“ → „Create new user“**:
- E-Mail: deine Admin-E-Mail
- Passwort: ein starkes Passwort (mind. 12 Zeichen)
- **„Auto Confirm User“ ankreuzen**
- „Create user“

### 2.5 Datenbank befüllen (Migrationen)
Im Terminal, im Ordner `3D-Druck-Platform`:

```bash
npx supabase login
```
Browser öffnet sich → bestätigen.

```bash
npx supabase link --project-ref <PROJECT-ID>
```
Fragt nach dem Datenbank-Passwort → einfügen (wird beim Tippen nicht angezeigt).

```bash
npx supabase db push
```
Mit `Y` bestätigen. Jetzt werden alle Tabellen angelegt.

> ⚠️ **Das bricht beim ersten Mal ABSICHTLICH ab** mit:
> `Migration 00190 abgebrochen: kein aktiver admins-Eintrag passt zu einem Supabase-Auth-Account`
> Das ist ein Schutz, damit du dich nicht selbst aussperrst. Weiter mit 2.6.

### 2.6 Dich als Admin eintragen
Supabase-Dashboard → **SQL Editor** → „New query“ → einfügen (deine E-Mail
eintragen, **genau dieselbe** wie in 2.4) → **„Run“**:

```sql
insert into admins (email, password_hash, active)
values ('deine-admin@email.de', 'supabase-auth', true);
```

(`password_hash` wird nicht benutzt — das echte Passwort verwaltet Supabase.)

Dann im Terminal nochmal:

```bash
npx supabase db push
```
Jetzt muss es ohne Fehler durchlaufen („Finished supabase db push“).

---

## Schritt 3 — Cloudflare einrichten

### 3.1 Deine workers.dev-Adresse
Cloudflare-Dashboard → links **„Workers & Pages“** öffnen. Beim ersten Mal
wirst du nach einer **Subdomain** gefragt (z. B. `maxdruck`) → du bekommst
`maxdruck.workers.dev`. Diesen Namen in den Notizzettel als
**CLOUDFLARE SUBDOMAIN**. (Falls nicht gefragt: rechts auf der Seite steht
„Subdomain: ….workers.dev“.)

Deine späteren Adressen:
- Shop: `https://3d-druck-platform.<SUBDOMAIN>.workers.dev`
- API: `https://3d-druck-platform-api.<SUBDOMAIN>.workers.dev`

### 3.2 Turnstile (Bot-Schutz für Bestellformulare)
Cloudflare-Dashboard → **„Turnstile“** → **„Add widget“**:
- Name: `3d-druck`
- Hostname: `3d-druck-platform.<SUBDOMAIN>.workers.dev` und zusätzlich `localhost`
- Widget Mode: **Managed**
- „Create“ → **Site Key** und 🔒 **Secret Key** in den Notizzettel.

### 3.3 PrimeUI-Lizenzschlüssel (Pflicht, meist kostenlos)
Die Oberfläche nutzt **PrimeNG** von PrimeTek. Ab Version 21 braucht PrimeNG
einen **eigenen Lizenzschlüssel** — die Lizenz dieser Vorlage (MIT) gilt nur
für den Vorlagen-Code, **nicht** für PrimeNG.

- **Community-Lizenz (kostenlos)** — für Privatpersonen, Studierende,
  gemeinnützige und nicht-kommerzielle Open-Source-Projekte sowie kleine
  Firmen (unter 1 Mio. USD Jahresumsatz, weniger als 5 Entwickler und
  10 Mitarbeitende, unter 3 Mio. USD Fremdkapital). Muss **jährlich
  bestätigt** werden.
- Sonst: **Commercial License** (kostenpflichtig, pro Entwickler).

So bekommst du den Schlüssel:
1. Auf <https://primeui.dev> registrieren und die **Community-Lizenz**
   beantragen (Bedingungen: <https://primeui.dev/licenses/community>).
2. Den Lizenzschlüssel (lange Zeichenkette) in den Notizzettel als
   **PRIMEUI-KEY**.

> Den Schlüssel **niemals** an andere weitergeben oder in eine öffentliche
> Vorlage kopieren — er gilt nur für dich. In deiner eigenen Webseite ist
> er drin, das ist so vorgesehen.

---

## Schritt 4 — Deine Werte in den Code eintragen

Im Code stehen an allen nötigen Stellen **Platzhalter** wie `DEINE-PROJECT-ID`.
Die tauschst du mit **Suchen & Ersetzen** gegen deine Werte aus:

1. VS Code öffnen → **Datei → Ordner öffnen** → `3D-Druck-Platform`.
2. **Strg + Umschalt + H** (Mac: **Cmd + Umschalt + H**) öffnet
   „In Dateien ersetzen“.
3. Auf die drei Punkte **„…“** unter dem Ersetzen-Feld klicken und bei
   **„Auszuschließende Dateien“** `*.md` eintragen (damit diese Anleitung
   selbst nicht verändert wird).
4. Nacheinander diese Ersetzungen machen — jeweils oben suchen, darunter
   ersetzen, dann auf „Alle ersetzen“ (Symbol rechts neben dem Ersetzen-Feld).
   **Groß-/Kleinschreibung genau so** wie in der Tabelle:

| Suchen nach | Ersetzen durch | Beispiel |
|---|---|---|
| `DEINE-PROJECT-ID` | deine **Supabase PROJECT-ID** | `abcdefghijklmnop` |
| `DEIN-ANON-KEY` | dein **Supabase Anon Key** | `eyJhbGciOi…` (sehr lang) |
| `DEINE-SUBDOMAIN` | deine **Cloudflare-Subdomain** | `maxdruck` |
| `DEIN-TURNSTILE-SITE-KEY` | dein **Turnstile Site Key** | `0x4AAAA…` |
| `DEIN-PRIMEUI-LICENSE-KEY` | dein **PrimeUI-Lizenzschlüssel** (Schritt 3.3) | `eyJpZCI6…` (sehr lang) |
| `DEIN-GITHUB-NAME` | dein **GitHub-Benutzername** (nur für Backup, Schritt 9) | `maxmuster` |
| `Mein 3D-Druck` | **Name deines Shops** (optional) | `Max' Druckwerk` |

5. **Optional — eigenes Logo:** Deine Logo-Datei (PNG, am besten mit
   transparentem Hintergrund, eher breit als hoch) unter genau diesem Namen
   ablegen und die vorhandene überschreiben:
   `frontend/public/brand/logo.png`

6. Kontrolle: nochmal mit **Strg + Umschalt + F** nach `DEIN` suchen —
   außer in `.md`-Dateien darf **nichts** mehr gefunden werden.

7. Alles speichern (**Strg + K, dann S** = alle speichern) und hochladen:

```bash
git add .
git commit -m "Eigene Instanz: meine Werte eingetragen"
git push
```

> 🔒 Der **Anon Key** und der **Site Key** sind öffentlich (stecken sowieso in
> der Webseite) — die dürfen in den Code. **Niemals** in den Code gehören:
> Service Role Key, DB-Passwort, DB-URL, Turnstile Secret Key.

---

## Schritt 5 — API-Worker hochladen

Im Terminal (vom Ordner `3D-Druck-Platform` aus):

```bash
cd cloudflare-worker
npm install
npx wrangler login
```
Browser öffnet sich → „Allow“.

Jetzt die drei geheimen Werte hinterlegen. Nach jedem Befehl wirst du nach
dem Wert gefragt → aus dem Notizzettel einfügen → Enter:

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

(Falls gefragt wird, ob ein neuer Worker angelegt werden soll: **ja**.)

Dann hochladen:

```bash
npx wrangler deploy
cd ..
```

Am Ende steht die Adresse `https://3d-druck-platform-api.<SUBDOMAIN>.workers.dev`.

---

## Schritt 6 — Shop-Webseite hochladen

```bash
cd frontend
npm install
npx ng build --configuration production
npx wrangler deploy
cd ..
```

(Falls Angular fragt, ob anonyme Nutzungsdaten geteilt werden dürfen:
egal, `N` ist ok.)

Am Ende steht die Adresse `https://3d-druck-platform.<SUBDOMAIN>.workers.dev`
→ im Browser öffnen, der Shop sollte (noch leer) erscheinen. 🎉

---

## Schritt 7 — Supabase die Shop-Adresse mitteilen

Supabase-Dashboard → **Authentication → URL Configuration**:
- **Site URL**: `https://3d-druck-platform.<SUBDOMAIN>.workers.dev`
- **Redirect URLs** → „Add URL“:
  `https://3d-druck-platform.<SUBDOMAIN>.workers.dev/**`
- Speichern.

---

## Schritt 8 — Erster Admin-Login + 2FA

1. `https://3d-druck-platform.<SUBDOMAIN>.workers.dev/admin/login` öffnen.
2. Mit Admin-E-Mail + Passwort aus Schritt 2.4 anmelden.
3. Du landest automatisch auf **„Sicherheit“** → QR-Code mit der
   Authenticator-App scannen → 6-stelligen Code eingeben.
4. Ab jetzt fragt jeder Login nach Passwort **und** Code aus der App.

Danach im Admin-Bereich:
- **Einstellungen**: Shop-Modus, Strompreis, Stundensatz usw. prüfen.
- **Drucker**, **Filament**, **Katalog** anlegen — dann erscheinen Produkte im Shop.

> Hinweis: Erscheint ein Banner „Invalid PrimeUI License“, stimmt der
> Lizenzschlüssel aus Schritt 3.3 nicht (fehlt, falsch kopiert oder
> abgelaufen — die Community-Lizenz muss jährlich erneuert werden).
> Schlüssel in `frontend/src/app/app.config.ts` korrigieren, dann Schritt 6
> wiederholen. Ohne gültigen Schlüssel ist die Nutzung von PrimeNG laut
> Lizenz nicht erlaubt.

---

## Schritt 9 — Automatik in GitHub (Wach-halten, Aufräumen, Backup)

**Warum wichtig:** Kostenlose Supabase-Projekte werden nach ca. 7 Tagen ohne
Aufrufe **pausiert**. Der Job „Keepalive & Backup“ verhindert das.

### 9.1 (Optional) Backup-Repo anlegen
- GitHub → „New repository“ → Name `3-D-Druck-Backup`, **Private**,
  „Add a README file“ **ankreuzen** → Create.
- Zugriffstoken dafür: GitHub → Profilbild → **Settings → Developer settings →
  Personal access tokens → Fine-grained tokens → „Generate new token“**
  - Repository access: *Only select repositories* → `3-D-Druck-Backup`
  - Permissions → Repository permissions → **Contents: Read and write**
  - Ablaufdatum: maximal → Token kopieren 🔒
- Ein langes, zufälliges **Backup-Passwort** ausdenken (z. B. mit einem
  Passwort-Manager) und gut aufheben 🔒 — ohne dieses kannst du Backups
  **nicht** wiederherstellen.

### 9.2 Secrets eintragen
In **deinem** Repo `3D-Druck-Platform` auf GitHub:
**Settings → Secrets and variables → Actions → „New repository secret“**.
Für jede Zeile einmal:

| Name | Wert |
|---|---|
| `SUPABASE_DB_URL` | 🔒 DB-URL aus 2.2 |
| `SUPABASE_SERVICE_ROLE_KEY` | 🔒 Service Role Key |
| `SUPABASE_ANON_KEY` | Anon Key |
| `BACKUP_REPO_PAT` | 🔒 Token aus 9.1 (nur bei Backup) |
| `BACKUP_ENCRYPTION_KEY` | 🔒 Backup-Passwort aus 9.1 (nur bei Backup) |

### 9.3 Testen
Repo → Reiter **„Actions“** → links „Keepalive & Backup“ → **„Run workflow“**.
Nach 1–2 Minuten sollte ein grüner Haken erscheinen. Dasselbe mit
„Daily Cron“.

(Ohne Backup-Repo wird „Keepalive & Backup“ beim Backup-Schritt rot — das
Wachhalten klappt trotzdem, weil es der erste Schritt ist.)

---

## Schritt 10 — Fertig-Check ✅

- [ ] Shop-Adresse öffnet sich
- [ ] Admin-Login mit 2FA klappt
- [ ] Ein Test-Produkt angelegt → erscheint im Shop
- [ ] Testbestellung aufgegeben → erscheint im Admin unter Bestellungen
- [ ] In Supabase unter Authentication → Users existiert **nur** dein Account
- [ ] GitHub Actions laufen grün

---

## Schritt 11 — Später Updates übernehmen

Wenn es in der Vorlage Neuerungen gibt:

```bash
cd 3D-Druck-Platform
git pull vorlage main
```

- Gibt es dabei Konflikte, betreffen sie meist die Dateien aus Schritt 4
  → dort jeweils **deine** Werte behalten.
- Dann hochladen und neu ausrollen:

```bash
git push
npx supabase db push

cd cloudflare-worker
npx wrangler deploy
cd ../frontend
npm install
npx ng build --configuration production
npx wrangler deploy
cd ..
```

(`npx supabase db push` läuft zusätzlich auch automatisch per GitHub Action,
sobald du nach `main` pushst — doppelt schadet nicht.)

---

## Impressum & Datenschutz (sobald du verkaufst)

Die Seiten **Impressum** und **Datenschutzerklärung** sind fertig vorbereitet,
aber ausgeschaltet — für einen rein privaten Katalog unter Bekannten braucht
man sie meist nicht. Sobald du etwas gegen Geld anbietest:

1. In `frontend/src/app/features/storefront/legal/impressum.html` und
   `datenschutz.html` alle Angaben in `[ECKIGEN KLAMMERN]` ausfüllen
   (Name, Anschrift, E-Mail, Supabase-Region, Aufbewahrungsfrist,
   Aufsichtsbehörde, Datum) und den gelben „Entwurf“-Hinweis löschen.
2. In `frontend/src/app/core/legal-pages.ts` den Wert auf `true` setzen.
   Dann erscheinen die Links im Footer und ein Datenschutz-Hinweis beim
   Absenden von Bestellung/Anfrage.
3. Schritt 6 wiederholen (Webseite neu hochladen).
4. Mit Supabase und Cloudflare den Auftragsverarbeitungsvertrag (AVV/DPA)
   abschließen — kostenlos, bei Supabase im Dashboard unter Organization →
   Legal Documents, bei Cloudflare ist er Teil der Nutzungsbedingungen.

Die Texte sind eine Vorlage, keine Rechtsberatung — im Zweifel prüfen lassen.

---

## Hilfe — häufige Probleme

| Problem | Lösung |
|---|---|
| `npx: command not found` / `node` unbekannt | Node.js neu installieren, Terminal **neu öffnen**. |
| `db push` fragt nach Passwort / „password authentication failed“ | Datenbank-Passwort aus 2.1 verwenden. Vergessen? Supabase → Project Settings → Database → „Reset database password“. |
| `db push` bricht bei **00190** ab | Schritt 2.6: E-Mail in `admins` muss exakt der Login-E-Mail entsprechen. |
| Shop zeigt „Fehler beim Laden“ | Schritt 4 prüfen: `DEINE-PROJECT-ID` und `DEIN-ANON-KEY` richtig ersetzt? Danach Schritt 6 wiederholen. |
| Bestellung/Anfrage abschicken schlägt fehl | Turnstile-Hostname (3.2), Secrets im API-Worker (Schritt 5) und Ersetzung `DEINE-SUBDOMAIN` (Schritt 4) prüfen. |
| Admin-Login: „MFA erforderlich“ / Daten laden nicht | 2FA in Schritt 8 zu Ende einrichten, ab- und wieder anmelden. |
| Admin-Login klappt, aber alles leer / Zugriff verweigert | Stimmt die E-Mail in `admins` (2.6) mit der Login-E-Mail überein? |
| GitHub Action „Keepalive“ rot beim ersten Schritt | Secret `SUPABASE_ANON_KEY` fehlt oder Project-ID in der Workflow-Datei nicht ersetzt. |
| Supabase-Projekt „paused“ | Im Dashboard „Restore project“ klicken, dann Schritt 9 prüfen. |

---

## Kurz zur Sicherheit

- **Nur du** bist Admin. Registrierung bleibt **aus** (Schritt 2.3).
- 🔒-Werte nie in den Code, in Chats oder Screenshots.
- Wurde ein 🔒-Wert doch mal öffentlich: in Supabase/Cloudflare/GitHub neu
  erzeugen und überall (Schritt 5 + 9.2) neu eintragen.
