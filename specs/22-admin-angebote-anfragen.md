# Admin: Angebote & Individualanfragen-Postfach

**Datenquelle:** custom_requests, fn_create_offer_from_request,
fn_reject_custom_request, fn_revoke_offer, fn_reject_offer, fn_expire_offers (Cron)

**Elemente:**
- Posteingang: neue Individualanfragen, Status (offen/abgelehnt/in Angebot
  überführt)
- Anfrage-Detail → "Angebot erstellen": je Position eine Kalkulationsversion,
  128-Bit-Token wird generiert, Link zum Versenden (kopierbar, da E-Mail-System
  deaktiviert ist)
- Angebotsliste mit Status (aktiv/angenommen/abgelehnt/abgelaufen/widerrufen)
- Aus abgelaufenem/abgelehntem Angebot: "Neues Angebot zur selben Anfrage"

**Best Practice:** Prominenter "Link kopieren"-Button direkt nach
Angebotserstellung, da E-Mail-Versand deaktiviert ist
