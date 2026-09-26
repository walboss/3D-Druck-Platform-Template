-- Migration 0009: Ebene 9 (→ Ebene 8)
-- Siehe specs/00-overview.md §3 (FK-Ebene 9) und die jeweiligen Domänen-Specs §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- specs/fertigwarenbestand.md §2
create table finished_goods_movements (
  id uuid primary key default gen_random_uuid(),
  variant_configuration_id uuid not null references variant_configurations(id),
  stock_type stock_type not null,
  movement_type fg_movement_type not null,
  qty_delta int not null,
  reference_type text,
  reference_id uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table finished_goods_movements enable row level security;

-- specs/fertigwarenbestand.md §2
create table finished_goods_reservations (
  id uuid primary key default gen_random_uuid(),
  variant_configuration_id uuid not null references variant_configurations(id),
  stock_type stock_type not null,
  order_item_id uuid not null references order_items(id),
  qty int not null,
  status fg_reservation_status not null,
  created_at timestamptz not null default now(),
  released_at timestamp,
  updated_at timestamptz not null default now()
);

alter table finished_goods_reservations enable row level security;

-- specs/filament-material.md §2
-- production_batch_item_id: bewusst uuid ohne FK-Constraint — production_batch_items entsteht
-- erst in Ebene 11, siehe specs/00-overview.md §3 und specs/implementierungsplan-schritt9.md §1.
create table filament_reservations (
  id uuid primary key default gen_random_uuid(),
  spool_id uuid not null references filament_spools(id),
  order_item_id uuid not null references order_items(id),
  production_batch_item_id uuid,
  amount_g numeric not null,
  status reservation_status not null,
  created_at timestamptz not null default now(),
  released_at timestamp,
  updated_at timestamptz not null default now()
);

alter table filament_reservations enable row level security;

-- specs/kunden-warenkorb-tracking.md §2
create table cart_sessions (
  id uuid primary key default gen_random_uuid(),
  session_token text not null,
  expires_at timestamp not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table cart_sessions enable row level security;

-- specs/kunden-warenkorb-tracking.md §2
create table order_tracking_tokens (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  token text not null unique,
  expires_at timestamp not null,
  revoked_at timestamp,
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table order_tracking_tokens enable row level security;
