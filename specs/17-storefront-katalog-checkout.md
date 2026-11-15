# Storefront: Katalog bis Checkout

## 1. Katalog-Übersicht

**Datenquelle:** v_catalog

**Elemente:**
- Produktkarten (Bild, Name, Preis ab final_price, "ab"-Preis bei mehreren Varianten)
- Suchleiste (Volltext über products.tags, GIN-Index vorhanden)
- Filter (Tags als Chips/Multi-Select)
- Sortierung (Preis auf-/absteigend, Neu zuerst)

**Zustände:** Ladezustand (Skeleton-Karten), leeres Suchergebnis, Fehlerzustand

**Paginierung:** Infinite-Scroll (weitere Produkte werden beim Runterscrollen
automatisch nachgeladen, kein Seiten-Wechsel/kein PrimeNG Paginator mehr —
Entscheidung vom 2026-09-20, siehe BUILD-LOG.md). Mobile: 2 Spalten, Tablet:
3, Desktop: 4.

## 2. Produktdetail

**Datenquelle:** v_catalog + Variantenkombinationen (Farbe/Finish/Größe)

**Elemente:**
- Bildergalerie (berücksichtigt source_type: extern_link vs. eigenes_hosting)
- Variantenauswahl: getrennte Selektoren pro Attribut (Farbe, Finish, Größe einzeln,
  z.B. als Swatches/Buttons) — NICHT eine kombinierte Liste vorhandener Varianten.
  Begründung: fn_create_variant_configuration_if_missing legt neue Kombinationen
  erst bei Bestellung automatisch an; pro Produkt sind nur erlaubte Werte je
  Attribut zu hinterlegen, keine vorab bekannte Kombinationsliste nötig.
- Live-Preisanzeige je nach gewählter Variante
- Mengenfeld
- "In den Warenkorb"-Button

**Randfall:** Variantenkombination kann serverseitig noch nicht existieren (wird erst
bei Checkout/fn_create_variant_configuration_if_missing angelegt, Advisory-Lock
gegen Race-Conditions). Preisberechnung darf sich im Frontend nicht auf eine
bereits existierende variant_configuration_id verlassen.

**Preisvorschau** bei neuer, noch nie bestellter Variantenkombination: kein
berechneter Preis, stattdessen Hinweistext "Preis wird bei Bestellung final
berechnet".

**Positionen ohne Preis in Warenkorb/Kasse** (Entscheidung 2026-11-14 —
Review A2): Zeilensumme zeigt "Preis folgt" statt 0 €. Gibt es mindestens eine
solche Position, heißt die Summe "Zwischensumme" (nur Positionen mit Preis) mit
Hinweis darunter "+ N Position(en), deren Preis wir dir noch mitteilen". Haben
alle Positionen einen Preis: "Gesamtsumme" wie bisher.

## 3. Warenkorb

**Datenquelle:** cart_sessions/cart_items (volles CRUD für anon)

**Elemente:**
- Positionsliste, Menge editierbar, Entfernen
- Gesamtsumme
- Hinweis: keine Bestandsreservierung vor Checkout (fn_place_order reserviert nicht)
- "Zur Kasse"-Button

**Session-Konzept:** cart_sessions.id in localStorage, kein Login nötig, funktioniert
über mehrere Linkbesuche hinweg.

**Session-Ablauffrist:** 30 Tage Inaktivität, danach Bereinigung per Cronjob
(siehe .github/workflows/daily-cron.yml).

## 4. Checkout

**Datenquelle:** fn_place_order (Abschluss)

**Ablauf:**
1. ~~Kundensuche "Kennen wir uns schon?" (fn_customer_search)~~ — im
   Storefront entfernt (Entscheidung 2026-11-14 — Review B14): zweites
   Captcha, kein Nutzen, da der Kunde ohnehin alles eingibt. Funktion/Worker-
   Endpunkt bleiben vorerst bestehen, werden nur nicht mehr aufgerufen.
2. Kunde gibt seine Daten selbst ein (Name, Telefon, E-Mail;
   Pflichtfeld-Logik abhängig von email_required_at_order, aktuell false)
3. Verknüpfung mit bestehendem Kunden passiert ausschließlich serverseitig
   innerhalb fn_place_order anhand der eingegebenen Telefon/E-Mail-Daten
4. Bestellabschluss via fn_place_order (Bestellnummer ORDER-<Jahr>-<5-stellig>,
   Mengenregeln-Prüfung)
5. Bestell-Knopf im gewerblichen Modus (Preise sichtbar) bleibt
   "Zahlungspflichtig bestellen" (gesetzliche Button-Lösung), daneben Hinweis
   "Bezahlung bei Abholung". Im Privatmodus ("Anfrage senden") kein solcher
   Hinweis (Entscheidung 2026-11-14 — Review B15).

**Bei Mengenregel-Verstoß:** Inline-Fehlermeldung direkt am betroffenen
Warenkorb-Item ("Diese Menge ist aktuell nicht bestellbar. Bitte Menge
reduzieren."), Checkout-Button bleibt blockiert bis behoben.

## 5. Bestellbestätigung

- Bestellnummer, Zusammenfassung
- Link/Hinweis zum Tracking (Token-basiert, fn_get_order_by_token)
