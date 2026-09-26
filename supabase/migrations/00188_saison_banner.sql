-- Migration 00188: Saison-Banner (2026-09-24)
--
-- Explizite Adminentscheidung (Betreiber, 2026-09-24, per Chat): Oben im
-- Storefront-Katalog erscheint ein Banner zur aktuellen Saison (kürzester
-- aktiver Zeitraum, siehe 00187) mit Produktbildern der Kategorie und
-- Schnellfilter. Überschrift und Text optional pro Saison pflegbar; leer =
-- Standardtext im Frontend (Kategoriename bzw. "Jetzt passend zur Saison").

alter table category_seasons
  add column banner_title text,
  add column banner_text text;
