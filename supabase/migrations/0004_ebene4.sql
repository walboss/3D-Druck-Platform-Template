-- Migration 0004: Ebene 4 (→ Ebene 3)
-- Siehe specs/00-overview.md §3 (FK-Ebene 4) und die jeweiligen Domänen-Specs §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- specs/produkte-varianten-farben.md §2
create table variant_parts (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references product_variants(id),
  product_part_id uuid not null references product_parts(id),
  weight_g numeric not null,
  print_time_min numeric not null,
  material_need_g numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table variant_parts enable row level security;

-- specs/produkte-varianten-farben.md §2
create table variant_configurations (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references product_variants(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table variant_configurations enable row level security;

-- specs/produkte-varianten-farben.md §2
create table product_bundles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  fixed_price numeric not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table product_bundles enable row level security;

-- specs/angebote-individuelle-anfragen.md §2
-- color_id/finish_id bewusst nullable: können bei 3mf-Import ohne eindeutigen Treffer leer bleiben.
create table custom_request_colors (
  id uuid primary key default gen_random_uuid(),
  custom_request_id uuid not null references custom_requests(id),
  slot_label text not null,
  color_id uuid references colors(id),
  finish_id uuid references finishes(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table custom_request_colors enable row level security;
