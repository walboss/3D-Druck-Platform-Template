# Spec: Drucker-Integration Bambu Lab (X2D)

**Status: verschoben.** Kein Bestandteil der zehn Kern-Specs aus Schritt 8, keine Voraussetzung für den ersten Livegang. Wird erst deutlich später angegangen, wenn überhaupt — separat davon bereits eingeplant: `produktdaten-import-3mf.md` (unabhängig, braucht keinen Live-Zugriff auf den Drucker).

---

## 1. Zweck

Live-Daten aus dem Bambu-Lab-Drucker (X2D, AMS) nutzen, um zwei Arbeitsschritte teilweise zu automatisieren:
1. Erfassung des **tatsächlichen** Filamentverbrauchs nach einem Druck (statt manueller Eingabe).
2. Anzeige, welche offenen Bestellpositionen mit dem **aktuell im AMS geladenen** Filament (Farbe + Material + Restmenge) sofort produzierbar wären.

Ersetzt an keiner Stelle Admin-Entscheidungen — siehe Nicht-Ziele.

---

## 2. Technische Grundlage (Rechercheergebnis, Stand September 2026)

- Der Drucker meldet über lokales MQTT (Port 8883, TLS) laufend einen JSON-Report; darin je AMS-Fach: `tray_color` (Hex RRGGBBAA), `tray_type` (Material), `remain` (Restmenge in %).
- **Wichtiger Stabilitätshinweis:** Seit Anfang 2025 verlangt die Firmware eine Authentifizierung für lokalen Zugriff. Funktionierende Drittanbieter-Lösungen nutzen ein aus der Bambu-Connect-Anwendung extrahiertes Zertifikat, um das zu umgehen — das ist **inoffiziell, nicht von Bambu unterstützt** und kann mit einem künftigen Firmware-Update ohne Vorwarnung wieder brechen.
- Konsequenz für die Architektur: Dieses Modul darf **nirgendwo** eine Voraussetzung für einen Kernprozess sein (Reservierung, Statuswechsel, Bestellabwicklung). Fällt der Zugriff aus, muss die Plattform ohne Einschränkung im manuellen Modus weiterlaufen.

---

## 3. Ergänzende Datenstruktur (nur relevant, wenn dieses Modul aktiv ist)

### `printer_connections`
| Feld | Hinweis |
|---|---|
| id PK, printer_id FK → `printers` | |
| local_ip | **verschlüsselt speichern**, nie im Klartext-Log — Netzwerkinterna sollen so wenig wie möglich nach außen sichtbar sein |
| access_code | verschlüsselt speichern, nie im Klartext-Log |
| serial_number | |
| active | Modul je Drucker einzeln an-/abschaltbar |

`local_ip` und `access_code` sind nur backendseitig entschlüsselbar — kein API-Endpunkt liefert sie im Klartext zurück, auch nicht ans Admin-Frontend. RLS/Policy-Regel dazu gehört in `audit-settings.md`, sobald diese Tabelle dort mit aufgenommen wird.

### `ams_color_mappings`
| Feld | Hinweis |
|---|---|
| id PK | |
| ams_tray_color_hex | vom Drucker gemeldeter Hex-Wert |
| ams_tray_info_idx | offizieller Bambu-Farbcode (z. B. `GFL99`), nur bei Bambu-Markenfilament vorhanden |
| color_id | FK → `colors` |
| source | enum(`bambu_rfid`, `manuell`) |

**Zwei Vertrauensstufen, je nach Filament:**
- **Bambu-Markenfilament** (per RFID erkannt, `tray_info_idx` vorhanden, z. B. „GFL99"): Farbe/Material gelten als zuverlässig — Mapping wird direkt aus den RFID-Daten übernommen (`source = 'bambu_rfid'`), kein manueller Schritt nötig. Bambus Farbcodes sind ein festes, bekanntes Schema, das sich einmalig vorbefüllen lässt.
- **Fremdfilament** (kein RFID/kein `tray_info_idx`, nur manuell am Drucker eingestellte Werte): bleibt wie ursprünglich vorgesehen — Zuordnung **vom Admin gepflegt** (`source = 'manuell'`), da diese Werte am Drucker frei eingegeben und nicht verifiziert sind.

Keine Änderung an bestehenden Kern-Tabellen aus `datenmodell-v1.md` nötig — `filament_movements`, `production_material_usage`, `printers` sind bereits generisch genug (siehe §4).

---

## 4. Funktion A: Automatische Verbrauchserfassung

- Bei Druckende meldet das AMS den neuen Restwert je Fach. Differenz zum vorherigen Wert → neuer Eintrag in `filament_movements` (`movement_type = 'produktion'`, `created_by = 'system:bambu_mqtt'`).
- Voraussetzung: Der Druck ist bereits einem `production_batch_item` zugeordnet (Admin hat vorher regulär die Spule reserviert und die Produktion gestartet, siehe `produktion.md`) — das System ordnet die gemessene Menge dieser bestehenden Zuordnung zu, wählt sie nicht selbst.
- Genauigkeit hängt vom Filament ab: Bambu-Markenspulen mit RFID liefern ein genaueres `tray_weight`; Fremdfilament ohne RFID liefert ggf. nur eine grobe Prozentangabe. Bei Fremdfilament bleibt die manuelle Eingabe die zuverlässigere Option.

## 5. Funktion B: "Was passt zu dem, was geladen ist"

Reine Leseabfrage/Dashboard-Ansicht, keine neue Wahrheit im Datenmodell:
1. Aktuelle AMS-Belegung lesen (Farbe → über `ams_color_mappings` auf `color_id` auflösen, Material, Restmenge).
2. Offene `order_items` filtern auf: `variant_configuration_colors` passt zur geladenen Farbe/zum Material, und Restmenge ≥ `variant_parts.material_need_g × qty`.
3. Ergebnisliste im Admin-Dashboard neben der bestehenden Bestellübersicht.

---

## 6. Nicht-Ziele (explizit außerhalb dieser Spec)

- **Kein Schreibzugriff auf den Drucker** — kein Start/Stopp/Pause von Drucken über die Plattform. Reine Beobachtung, keine Steuerung, auch wenn die zugrundeliegenden Tools das technisch könnten.
- **Keine automatische Spulenauswahl oder -reservierung** — Prinzip #18 gilt unverändert, der Admin reserviert die Spule weiterhin manuell bei Produktionsstart. Automatisiert wird ausschließlich die Verbrauchs*messung* danach.
- **Kein automatisches Anlegen neuer Filamentspulen per RFID-Erkennung** — trotz technischer Machbarkeit (siehe Recherche) hier nicht vorgesehen; Spulenanlage bleibt Admin-Aktion.
- **Keine Mehrdrucker-Orchestrierung** — Modell unterstützt zwar mehrere `printers`, aber Lastverteilung/Warteschlangen über mehrere Drucker ist nicht Teil dieser Spec.

---

## 7. Abhängigkeiten

- Setzt `filament-material.md` und `produktion.md` (Kern-Specs aus Schritt 8) voraus — insbesondere `filament_movements`, `production_material_usage`, `variant_parts.material_need_g`.
- Setzt `colors.hex` aus `produkte-varianten-farben.md` voraus.
- Keine Abhängigkeit in umgekehrter Richtung — die Kern-Specs referenzieren dieses Modul nirgends, damit das MVP unabhängig davon funktioniert.
- Keine Abhängigkeit von `produktdaten-import-3mf.md` (eigenständig, siehe dort).
