# Admin: Dashboard & Bestellverwaltung

## Dashboard

**Datenquelle:** v_dashboard_orders_open, v_dashboard_stock_low, v_dashboard_production_running

**Layout:** Kachel-Grid, jede Kachel klickbar → navigiert zum passenden Detailbereich

**Zustände:** Ladezustand pro Kachel unabhängig, Leerzustand je Kachel, Fehlerzustand
pro Kachel mit Retry

**Auto-Refresh:** Polling-Intervall (z.B. 60s) statt reinem manuellem Reload —
kein Realtime/Websocket-Infrastrukturaufwand für Ein-Admin-Betrieb nötig.
Beim Polling kein Lade-Skelett (nur beim ersten Laden); kein Polling, solange
der Tab im Hintergrund ist, beim Zurückkehren sofort aktualisieren. Kacheln
per Tastatur bedienbar.

**Kacheln „Was ist zu tun?"** (Entscheidung 2026-11-14 — Review C23/F9):
- Offene Bestellungen mit Aufschlüsselung „davon N neu – zu bestätigen"
- Bereit zur Abholung (Anzahl Bestellungen im Status ReadyForPickup)
- Neue Anfragen (Individualanfragen im Status `neu`)

## Bestellübersicht/-verwaltung

**Liste:**
- Filter nach Bestellstatus (New, Confirmed, InProduction, ...)
- Suche nach Bestellnummer/Kundenname
- Ausnahmepfad-Positionen (ohne Katalogbezug, desired_description) visuell markiert
  — Anzeige-Begriff im Admin: „Ohne Katalogprodukt" (Review F12)

**Detailansicht (pro Bestellung):**
- Positionsliste mit Einzelstatus (Offen → Wartet auf Material → In Produktion →
  Fertig, + Storniert)
- Aktionen je nach Status:
  - Bestätigen (fn_confirm_order)
  - Zur Produktion zuordnen (fn_assign_to_production) → Produktionsstart
    (fn_start_production_order)
  - Nachproduktion bei laufendem Auftrag (fn_add_position_to_running_order)
  - Bereit zur Abholung (fn_ready_for_pickup) → Übergabe (fn_hand_over_order)
  - Stornieren (fn_cancel_order_item/fn_cancel_order) — Stornogrund PFLICHTFELD

**Stornieren** (ganze Bestellung) ist optisch von den Fortschritts-Aktionen
abgesetzt (eigene Zeile, dezenter Text-Knopf), damit es am Handy nicht neben
„Bestätigen" vertippt wird (Entscheidung 2026-11-14 — Review F10).

**Best Practice:** Bestätigungsdialog nur bei irreversiblen/kritischen Aktionen
(Stornierung, Übergabe), nicht bei jeder Statusänderung
