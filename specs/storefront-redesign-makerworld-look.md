# Task-Spec: Storefront-Redesign (MakerWorld-Look)

**Status: ERLEDIGT** (Session 2026-09-19/20, Commits 06f19a1, 349197a, 7c8e240, 648f971, 06375ab, 3662c4a, 4acfec1, ffa376c, e2b0f6d — siehe BUILD-LOG.md). Diese Datei dokumentiert jetzt den Ist-Zustand, kein offener Task mehr.

Ergänzt `17-storefront-katalog-checkout.md` und `18-storefront-anfrage-angebot-tracking.md` um eine visuelle Überarbeitung — kein Datenmodell-/Backend-Change, reine Frontend-/Styling-Aufgabe.

## 1. Referenz & Ziel

Vorbild: MakerWorld-App — dunkles/helles Theme, großes bildlastiges Grid ohne viel Weißraum, schlanker Header nur mit Logo statt Textmarke.

**Umfang: gesamter Storefront**, nicht nur der Katalog — Katalog-Übersicht, Produktdetail, Warenkorb/Wunschliste, Checkout/Anfrage abschicken, Bestellbestätigung, Individualanfrage-Formular, Angebotsansicht (Token-Link), Bestell-Tracking (Token-Link). Admin-Bereich war **nicht** Teil dieser Aufgabe.

## 2. Theme-System (Light/Dark, automatisch + manueller Override) — UMGESETZT

- `ThemeService`, gesteuert über `prefers-color-scheme` + manueller Umschalter, Auswahl in `localStorage` (`app-theme`) persistiert.
- CSS-Design-Tokens auf Root-Ebene, PrimeNG-Preset (`app-preset.ts`) um dark `colorScheme` erweitert.

## 3. Header — UMGESETZT

- Text "3D-Druck-Shop" entfernt, Logo (`brand/logo.png`) links, kompakt, Header schlanker.
- Seitentitel/Footer zusätzlich von "3D-Druck-Shop" auf "Mein 3D-Druck" geändert, Katalog-Untertitel ("Fertige Modelle – Größe, Farbe und Finish nach Wunsch.") entfernt — beides klang laut Umsetzungs-Session zu sehr nach Shop/Konfigurator, war über die ursprüngliche Spec hinaus ergänzt.

## 4. Katalog-Grid (MakerWorld-Stil) — UMGESETZT

- Karten randnah, ohne Kartenrahmen/-schatten, Bildformat 3:4.
- Spaltenzahl unverändert wie in `17-storefront-katalog-checkout.md` (Mobile 2, Tablet 3, Desktop 4).
- Produktdetail-Bildergalerie analog großformatig umgestellt.

## 5. Restliche Screens — UMGESETZT

Alle genannten Screens auf dieselben Design-Tokens umgestellt.

## 6. Zusätzlich aus dieser Session entstanden (über die ursprüngliche Spec hinaus)

Im Lauf der Session stellte sich heraus, dass der Storefront aktuell nur eine Modell-Übersicht für den Bekanntenkreis ohne Gewinnabsicht ist, kein echter Webshop — daraus entstand eine Folge-Aufgabe, dokumentiert in `specs/privatmodus-schalter.md`: drei Admin-Schalter für Preis-/Shop-/Individualanfrage-Sichtbarkeit, Umbenennung Warenkorb → Wunschliste, gestufter Produktdetail-CTA. Diese funktionalen Änderungen sind **nicht** Teil dieser (rein visuellen) Spec — Details dort.

## 7. Asset

Logo liegt unter `brand/logo.png` im Frontend-Projekt.
