-- Migration 0006: Ebene 6 (→ Ebene 5)
-- Siehe specs/00-overview.md §3 (FK-Ebene 6) und die jeweiligen Domänen-Specs §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- Fachliche Erweiterung (nicht aus der Spec, siehe Task-Vorgabe): nicht-katalogisierte
-- Bestellpositionen (bestellungen.md, Ausnahmepfad) brauchen eine eigene Kalkulation ohne
-- zwingend existierendes Angebot.
alter type calc_scope_type add value 'order_item';

-- specs/kalkulation.md §2
create table calculation_versions (
  id uuid primary key default gen_random_uuid(),
  scope_type calc_scope_type not null,
  scope_id uuid not null,
  version_no int not null,
  reason calc_reason not null,
  filament_cost numeric not null,
  energy_cost numeric not null,
  machine_cost numeric not null,
  labor_cost numeric not null,
  packaging_cost numeric not null,
  license_cost numeric not null,
  scrap_allowance numeric not null,
  other_cost numeric not null,
  total_cost numeric not null,
  margin_percent numeric not null,
  min_price numeric not null,
  calculated_price numeric not null,
  final_price numeric not null,
  is_current boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table calculation_versions enable row level security;

-- specs/angebote-individuelle-anfragen.md §2
create table offer_items (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references offers(id),
  product_id uuid references products(id),
  desired_variant_description text not null,
  qty int not null,
  calculation_version_id uuid not null references calculation_versions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table offer_items enable row level security;
