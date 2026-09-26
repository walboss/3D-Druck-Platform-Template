# Admin: Dashboard & Bestellverwaltung

## Dashboard

**Datenquelle:** v_dashboard_orders_open, v_dashboard_stock_low, v_dashboard_production_running

**Layout:** Kachel-Grid, jede Kachel klickbar → navigiert zum passenden Detailbereich

**Zustände:** Ladezustand pro Kachel unabhängig, Leerzustand je Kachel, Fehlerzustand
pro Kachel mit Retry

**Auto-Refresh:** Polling-Intervall (z.B. 60s) statt reinem manuellem Reload —
kein Realtime/Websocket-Infrastrukturaufwand für Ein-Admin-Betrieb nötig

## Bestellübersicht/-verwaltung

**Liste:**
- Filter nach Bestellstatus (New, Confirmed, InProduction, ...)
- Suche nach Bestellnummer/Kundenname
- Ausnahmepfad-Positionen (ohne Katalogbezug, desired_description) visuell markiert

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

**Best Practice:** Bestätigungsdialog nur bei irreversiblen/kritischen Aktionen
(Stornierung, Übergabe), nicht bei jeder Statusänderung
