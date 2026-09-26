# Task-Spec: Massenimport aus MakerWorld-Kollektion

Ergänzt `21-admin-katalogpflege.md` und baut auf dem bestehenden MakerWorld-Link-Import (Task D, siehe BUILD-LOG.md — zieht bisher pro Produktvariante Gewicht/Druckzeit aus einem einzelnen Link) auf, erweitert ihn aber um Massenverarbeitung mehrerer Links auf einmal plus automatische Kategorie-Zuordnung.

## 1. Zweck

Statt jedes Modell einer MakerWorld-Kollektion einzeln über den bestehenden Produkt-Editor anzulegen, sollen mehrere Links auf einmal eingegeben und als fertige Katalog-Produkte importiert werden können — inkl. automatischer Zuordnung zu einer Kategorie (abgeleitet vom Kollektionsnamen, z. B. "Winter").

**Wichtig zur Datenquelle:** MakerWorld selbst bietet keinen strukturierten Datei-Export einer Kollektion — der Input ist eine reine **Liste von MakerWorld-Modell-Links** (Copy/Paste in ein Textfeld, oder Upload einer Textdatei mit einem Link pro Zeile). Keine Kollektions-API, kein automatisches Auslesen der Kollektion selbst nötig — der Admin stellt die Linkliste manuell zusammen.

## 2. Screen: Neues Massenimport-Formular (Katalogpflege)

Neuer Dialog/Screen, erreichbar aus der Produktliste heraus. Zwei Eingabewege, je nach Bedarf:

**Weg A — einfache Linkliste:** Mehrzeiliges Textfeld (ein Link pro Zeile) ODER Upload einer reinen `.txt`-Datei (ein Link pro Zeile). Dazu ein einzelnes **Kategorie-Freitextfeld**, das für **alle** Links in diesem Durchgang gilt (z. B. "Winter" für eine komplett winterliche Kollektion).

**Weg B — CSV-Upload:** Datei-Upload `.csv`, Spalten:

| Spalte | Pflicht | Hinweis |
|---|---|---|
| `link` | ja | MakerWorld-Modell-Link |
| `category` | nein | falls leer: Fallback auf das globale Kategorie-Freitextfeld (falls ausgefüllt) — ist auch das leer, bricht die Zeile mit Fehler ab ("Keine Kategorie angegeben") |
| `name` | nein | überschreibt den automatisch von der MakerWorld-Seite gezogenen Produktnamen, falls gesetzt |
| `tags` | nein | kommagetrennt, ergänzt (nicht ersetzt) automatisch gezogene Tags, falls vorhanden |

Damit lässt sich z. B. eine gemischte Kollektion mit unterschiedlichen Kategorien pro Zeile importieren, ohne mehrere Durchgänge zu brauchen. Erste Zeile = Header (`link,category,name,tags`), UTF-8, Komma als Trennzeichen. Bei Bedarf kann Weg A einfach als Sonderfall von Weg B behandelt werden (nur `link`-Spalte, globales Kategoriefeld greift für alle Zeilen) — technische Entscheidung, beide Wege müssen aber im UI nutzbar sein, da eine reine Linkliste ohne CSV-Formatierung der schnellere Weg für den Normalfall (eine Kategorie für alles) bleibt.

## 3. Ablauf pro Link

1. Link validieren (MakerWorld-URL-Format), Kategorie je Zeile auflösen (CSV-Spalte `category`, sonst globales Feld, siehe §2).
2. Bestehenden MakerWorld-Link-Import-Mechanismus wiederverwenden für Gewicht/Druckzeit (wie bisher pro Variante).
3. **Erweiterung nötig:** Der bisherige Import zieht laut Build-Log nur Gewicht/Druckzeit. Für den Massenimport zusätzlich Produktname (außer per CSV-Spalte `name` überschrieben) und mindestens ein Bild (als `extern_link`, siehe `produkte-varianten-farben.md` §2/§3 — Hotlink auf das MakerWorld-Showcase-Foto, analog zur bisherigen Praxis) von der MakerWorld-Seite übernehmen. Tags aus CSV-Spalte `tags` ergänzen automatisch gezogene Tags, falls vorhanden.
4. Neues `products` + eine `product_variants`-Zeile anlegen:
   - `category` = die in Schritt 1 aufgelöste Kategorie (keine Migration nötig — `category` ist laut Datenmodell bereits ein einfaches Textfeld auf `products`, keine separate Kategorien-Tabelle. "Automatisch anlegen, falls sie fehlt" ist damit strukturell bereits der Normalfall: der String wird einfach geschrieben.)
   - `active = true` — Produkte erscheinen sofort im Katalog.
   - `images[].source_type = 'extern_link'`.
5. **Kalkulation wird NICHT automatisch erzeugt** — kein `calculation_versions`-Eintrag beim Import, da die tatsächlichen Kosten (Material, Marge etc.) aus einem MakerWorld-Link nicht ableitbar sind. Admin muss nach dem Import jedes Produkt einmal regulär über den bestehenden Kalkulationsversionen-Dialog durchgehen, bevor ein realer Verkauf/Preis existiert. Aktuell durch den Privatmodus (`storefront_prices_visible=false`) ohnehin nicht sichtbar — kein Blocker für den sofortigen Katalog-Auftritt.

Bei sehr langen Listen (z. B. >30 Zeilen, egal ob Weg A oder B) sollte das UI einen Fortschrittsbalken zeigen, da jede Zeile einzeln verarbeitet wird (Netzwerk-Roundtrip pro MakerWorld-Link).

## 4. Ergebnis-Bericht nach Import

Nach Abschluss: Liste mit "X erfolgreich importiert, Y fehlgeschlagen" — bei Fehlschlägen (ungültiger Link, MakerWorld-Seite nicht erreichbar, kein Gewicht/Zeit auslesbar) den jeweiligen Link + Fehlergrund anzeigen, kein harter Abbruch des gesamten Imports bei einzelnen Fehlern.

## 5. Randfälle

- **Link taucht doppelt in der Liste auf** oder verweist auf ein Modell, das schon importiert wurde: kein automatischer Duplikat-Check im MVP dieser Aufgabe — Admin ist dafür verantwortlich, keine Duplikate einzureichen. Kann als spätere Erweiterung ergänzt werden.
- **Modell ist mehrfarbig / hat mehrere Größenvarianten:** Massenimport legt nur **eine** Standardvariante pro Produkt an (wie beim bisherigen Einzel-Import) — weitere Varianten bleiben manuelle Nacharbeit im Produkt-Editor, wie von dir schon so gehandhabt ("wenn es verschiedene gibt füge ich das manuell hinzu").

## 6. Nicht Teil dieser Aufgabe

- Keine Kollektions-API-Anbindung an MakerWorld — reine Linkliste/CSV als Input.
- Keine automatische Kalkulation/Preisfindung.
- Kein Duplikat-Check.
- Keine Validierung/Bereinigung der CSV über die vier definierten Spalten hinaus (z. B. keine Erkennung von Zeichensatz-Problemen jenseits UTF-8).
- Keine Änderung am bestehenden Einzel-Import (Produkt-Editor, ein Link pro Variante) — bleibt unverändert parallel bestehen.
