# Task-Spec: Filament- und Spulen-Neuanlage

Ergänzt `23-admin-lager-filament.md` und `filament-material.md` um den bisher fehlenden Weg, überhaupt erst Filamente/Spulen ins System zu bringen — der bestehende "Wareneingang erfassen"-Dialog setzt bereits existierende Spulen voraus (Autocomplete auf `filament_spools`), kann aber keine neuen anlegen. Bei leerer Bibliothek ("Keine Spulen vorhanden") ist der Dialog dadurch aktuell eine Sackgasse.

## 1. Zweck

Zwei neue, kleine Formulare im Lager/Filament-Bereich, bevor der bestehende Wareneingang-Dialog nutzbar wird.

## 2. Screen/Dialog A: "Filament anlegen" (`filament_products`)

Felder (siehe `filament-material.md` §2):
- Hersteller — Dropdown mit Presets **Jayo** und **Bambulab**, zusätzlich Option "Sonstiger…" die ein Freitextfeld aufklappt (kein hartes Enum in der DB, nur UI-Komfort — `manufacturer` bleibt `text`).
- Produktname (text)
- Material (text, z. B. PLA/PETG/ABS)
- Farbe / Finish — Dropdown aus bestehenden `colors`/`finishes` (kein Freitext, siehe Datenmodell)
- Durchmesser mm (Default 1.75)
- Druck-/Betttemperatur, Druckprofil
- `active` (Default true)

## 3. Screen/Dialog B: "Spule anlegen" (`filament_spools`)

Felder (siehe `filament-material.md` §2):
- Filament — Auswahl aus bestehenden `filament_products` (aus Schritt A), mit direktem "+ Neues Filament anlegen"-Link, der Dialog A inline öffnet, statt zwei komplett getrennte Wege zu erzwingen
- Kaufpreis
- Anbruchgewicht (gewogen, nicht Herstellerangabe — Pflichtfeld-Hinweistext dazu übernehmen, siehe Geschäftsregeln in `filament-material.md`)
- Taragewicht
- Kaufdatum
- `active` (Default true)

Nach Anlage: `initial_weight_g` ist der reale Nullpunkt, kein zusätzlicher `filament_movements`-Eintrag nötig (der Wareneingang selbst ist keine Bewegung, sondern die Startbefüllung der Spule).

## 4. Zusammenspiel mit bestehendem "Wareneingang erfassen"

Keine Änderung am bestehenden Dialog nötig — er funktioniert bereits korrekt, sobald das Autocomplete Ergebnisse findet. Nur die Lücke davor (Punkt 2+3) fehlt.

## 5. Nicht Teil dieser Aufgabe

- Keine Änderung an `filament_movements`/`filament_reservations`-Logik.
- Kein Preset-Katalog mit vorbefüllten Temperaturwerten pro Hersteller/Material (nice-to-have für später, hier nur die Hersteller-Namen als Dropdown-Komfort).
