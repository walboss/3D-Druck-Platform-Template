-- Migration 00187: Saison-Kategorien (2026-09-24)
--
-- Explizite Adminentscheidung (Betreiber, 2026-09-24, per Chat) — weicht bewusst
-- von specs/17-storefront-katalog-checkout.md ("Filter: Tags als Chips/
-- Multi-Select") ab:
--   - Storefront-Katalog filtert nach products.category (Dropdown,
--     Mehrfachauswahl) statt nach Tags. Tags bleiben in der Suche.
--   - Pro Kategorie ist ein jährlich wiederkehrender Saison-Zeitraum
--     (TT.MM–TT.MM, darf über den Jahreswechsel gehen) im Admin pflegbar.
--     Liegt das heutige Datum im Zeitraum, steht die Kategorie im Filter
--     zuerst und ihre Produkte oben im Katalog. Bei mehreren aktiven
--     Saisons gewinnt der kürzere Zeitraum (z. B. Halloween vor Herbst).
--   - Kein Löschen, nur deaktivieren (Prinzip #2).
-- Die Saison-Berechnung erfolgt im Frontend (Datum des Besuchers).

create table category_seasons (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  start_month int not null check (start_month between 1 and 12),
  start_day int not null check (start_day between 1 and 31),
  end_month int not null check (end_month between 1 and 12),
  end_day int not null check (end_day between 1 and 31),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ungültige Tage (z. B. 31.04.) ablehnen; 29.02. erlaubt (Schaltjahr 2000)
  constraint category_seasons_valid_start check (make_date(2000, start_month, start_day) is not null),
  constraint category_seasons_valid_end check (make_date(2000, end_month, end_day) is not null),
  constraint category_seasons_category_not_blank check (btrim(category) <> '')
);

-- ein Zeitraum pro Kategorie
create unique index category_seasons_category_idx on category_seasons (lower(btrim(category)));

alter table category_seasons enable row level security;

create policy anon_select_category_seasons on category_seasons
  for select to anon
  using (active = true);

create policy admin_all_category_seasons on category_seasons
  for all to authenticated using (true) with check (true);

grant select on category_seasons to anon;
grant select, insert, update on category_seasons to authenticated;
