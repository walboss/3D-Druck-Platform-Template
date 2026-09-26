## Admin-Dashboard: Datenquelle

Entscheidung: Eigene aggregierende Views, keine clientseitige Aggregation.
Begründung: Single Source of Truth für fachliche Schwellenwerte (Lagerkritisch,
überfällig etc.), konsistent mit v_catalog/v_order_tracking-Muster, kein
Performance-Grund für Client-Aggregation bei einem Admin-Account.

Views (je eine pro Dashboard-Kachel, RLS: SELECT nur authenticated):
- v_dashboard_orders_open      — offene Bestellungen nach Status gruppiert
- v_dashboard_stock_low        — Filamentspulen/Bestand unter Schwellenwert
- v_dashboard_production_running — laufende Produktionsaufträge + Fortschritt
- weitere nach Bedarf beim Screen-Design ergänzen

Nicht implementieren:
- Keine SQL-Migration, keine tatsächlichen Views anlegen — das folgt später
  in der Umsetzungsphase der UI/UX-Spezifikation.
