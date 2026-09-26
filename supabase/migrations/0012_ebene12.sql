-- Migration 0012: Ebene 12 (→ Ebene 11)
-- Siehe specs/00-overview.md §3 (FK-Ebene 12) und specs/produktion.md §2,
-- specs/lizenzen.md §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- specs/produktion.md §2
create table production_material_usage (
  id uuid primary key default gen_random_uuid(),
  production_batch_item_id uuid not null references production_batch_items(id),
  spool_id uuid not null references filament_spools(id),
  amount_g numeric not null,
  filament_movement_id uuid not null references filament_movements(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table production_material_usage enable row level security;

-- specs/produktion.md §2, §4: decision/decision_note/cost nullable, da erst bei
-- Entscheidung (resolved_at gesetzt) befüllt — reported_at gesetzt => Status "offen"
-- ohne decision (§4 "decision Pflichtfeld ab diesem Zeitpunkt").
create table complaints (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references order_items(id),
  reported_at timestamptz not null,
  reason text not null,
  decision complaint_decision,
  decision_note text,
  cost numeric,
  resolved_at timestamptz,
  replacement_production_batch_item_id uuid references production_batch_items(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table complaints enable row level security;

-- specs/lizenzen.md §2
create table license_recurring_charges (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references licenses(id),
  period_start date not null,
  period_end date not null,
  amount_paid numeric not null,
  allocated_qty int not null,
  per_unit_allocated_cost numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table license_recurring_charges enable row level security;
