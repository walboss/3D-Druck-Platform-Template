-- Migration 0010: Ebene 10 (→ Ebene 9)
-- Siehe specs/00-overview.md §3 (FK-Ebene 10) und die jeweiligen Domänen-Specs §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- specs/kunden-warenkorb-tracking.md §2
create table cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_session_id uuid not null references cart_sessions(id),
  product_id uuid not null references products(id),
  variant_id uuid not null references product_variants(id),
  configuration_draft jsonb,
  qty int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table cart_items enable row level security;

-- specs/produktion.md §2
create table production_orders (
  id uuid primary key default gen_random_uuid(),
  printer_id uuid references printers(id),
  status production_order_status not null,
  planned_start timestamp not null,
  actual_start timestamp,
  actual_end timestamp,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table production_orders enable row level security;
