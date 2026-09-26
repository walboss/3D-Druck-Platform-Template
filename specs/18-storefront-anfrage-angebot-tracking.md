# Storefront: Individualanfrage, Angebotsansicht, Tracking

## 6. Individualanfrage-Formular

**Datenquelle:** fn_submit_custom_request

**Elemente:**
- Beschreibungsfeld (Freitext, optional Referenzbild)
- Farbmodus-Umschalter: einfarbig oder mehrfarbig (XOR)
  - Einfarbig: Farbwähler, Hex-Bestfarbabgleich wird VOR dem Absenden als
    Vorschau angezeigt ("wir ordnen deine Farbe automatisch [X] zu")
  - Mehrfarbig: Slot-Zuordnung, optional automatisch befüllt durch 3mf-Upload
    (Limits: max. 50 MB Dateigröße, max. 8 Farbslots)
- Kontaktdaten (Name, Telefon/E-Mail)
- Absenden → Bestätigung

## 7. Angebotsansicht (Token-Link)

**Datenquelle:** fn_get_offer_by_token (Migration 00149, anon + authenticated)

**Elemente:**
- Angebotsdetails je Position (desired_variant_description, qty, final_price
  aus verknüpfter calculation_version) — keine Kostenfelder/Margen
- Gültigkeitszeitraum (valid_from, valid_until)
- Annehmen (fn_accept_offer). Kein eigenständiges "Ablehnen" auf
  Kundenseite — fn_reject_offer ist bewusst Admin-only (Migration 00154).
  Lehnt ein Kunde ab (z. B. telefonisch), vermerkt der Admin das im
  Angebote-Postfach (specs/22).
- Bei ungültigem/abgelaufenem/widerrufenem/unbekanntem Token: einheitliche
  Fehlermeldung "Angebotslink ungültig oder nicht mehr verfügbar"
  (Enumerations-Schutz)

## 8. Bestell-Tracking (Token-Link)

**Datenquelle:** fn_get_order_by_token

**Elemente:**
- Statusanzeige/Timeline pro Bestellposition (Offen → Wartet auf Material →
  In Produktion → Fertig, bzw. Storniert)
- Bestellnummer, Positionsübersicht
- Bei WartetAufMaterial: nur neutraler Statustext ohne Zeitprognose
  ("Wartet auf Materialeingang, wird automatisch bearbeitet") — keine
  Datums-/Zeitschätzung, da automatischer FIFO-Retry nicht verlässlich
  vorhersagbar ist
- Kein direkter View-Zugriff (RLS), ausschließlich über diese Funktion
