-- Migration 0005: Ebene 5 (→ Ebene 4)
-- Siehe specs/00-overview.md §3 (FK-Ebene 5) und die jeweiligen Domänen-Specs §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- specs/produkte-varianten-farben.md §2
create table variant_configuration_colors (
  id uuid primary key default gen_random_uuid(),
  variant_configuration_id uuid not null references variant_configurations(id),
  product_part_id uuid references product_parts(id),
  color_id uuid not null references colors(id),
  finish_id uuid not null references finishes(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table variant_configuration_colors enable row level security;

-- specs/produkte-varianten-farben.md §2
create table bundle_items (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references product_bundles(id),
  product_id uuid not null references products(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table bundle_items enable row level security;

-- specs/angebote-individuelle-anfragen.md §2
-- Token-Entropie-Detail (gen_random_bytes statt gen_random_uuid) kommt erst in einer
-- späteren Security-Migration (implementierungsplan-schritt9.md §7) — hier text unique.
create table offers (
  id uuid primary key default gen_random_uuid(),
  custom_request_id uuid not null references custom_requests(id),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  status offer_status not null default 'offen',
  secure_token text not null unique,
  rejection_reason text,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table offers enable row level security;

-- specs/filament-material.md §2
create table filament_movements (
  id uuid primary key default gen_random_uuid(),
  spool_id uuid not null references filament_spools(id),
  movement_type filament_movement_type not null,
  amount_g numeric not null,
  reference_type text,
  reference_id uuid,
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table filament_movements enable row level security;
