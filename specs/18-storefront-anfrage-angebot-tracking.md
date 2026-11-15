# Storefront: Individualanfrage, Angebotsansicht, Tracking

## 6. Individualanfrage-Formular

**Datenquelle:** fn_submit_custom_request

**Elemente:**
- Beschreibungsfeld (Freitext, optional Referenzbild)
- Farbmodus-Umschalter: einfarbig oder mehrfarbig (XOR)
  - Einfarbig: Farbkreise der aktiven Farben (wie auf der Produktseite),
    OHNE Vorauswahl — der Kunde wählt aktiv eine Farbe (Entscheidung
    2026-11-14 — Review B16; ersetzt den früheren freien Farbwähler
    mit Hex-Bestfarbabgleich)
  - Mehrfarbig: Slot-Zuordnung, optional automatisch befüllt durch 3mf-Upload
    (Limits: max. 50 MB Dateigröße, max. 8 Farbslots). Slots heißen „Slot 1…n"
    (lückenlos nummeriert); je Slot optional ein Teilename als Hinweis
    (gespeichert als „Slot n – Name", siehe angebote-individuelle-anfragen.md)
- Kontaktdaten (Name, Telefon/E-Mail)
- Absenden → Bestätigung mit Knopf „Zum Katalog“

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
- Bestelldatum (orders.created_at, ab Migration 00201 in fn_get_order_by_token)
- Bei Gesamtstatus „Bereit zur Abholung": deutlicher Abholhinweis
- Positionsstatus nur einmal anzeigen (Stepper); eigenes Status-Tag je
  Position nur bei „Storniert". Kein eigener Aktualisieren-Knopf (Neuladen
  der Seite genügt).
(Entscheidungen 2026-11-14 — Review B19)
