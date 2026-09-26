-- Migration 0007: Ebene 7 (→ Ebene 6, referenziert optional offers)
-- Siehe specs/00-overview.md §3 (FK-Ebene 7) und specs/bestellungen.md §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- specs/bestellungen.md §2
create table orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid not null references customers(id),
  status order_status not null,
  source order_source not null,
  offer_id uuid references offers(id),
  customer_message text,
  internal_note text,
  cancellation_reason text,
  confirmed_at timestamp,
  finished_at timestamp,
  ready_for_pickup_at timestamp,
  handed_over_at timestamp,
  handed_over_by uuid references admins(id),
  handover_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table orders enable row level security;
