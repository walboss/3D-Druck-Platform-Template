-- Migration 0003: Ebene 3 (→ Ebene 2)
-- Siehe specs/00-overview.md §3 (FK-Ebene 3) und die jeweiligen Domänen-Specs §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- specs/produkte-varianten-farben.md §2
create table product_parts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  name text not null,
  sort_order int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table product_parts enable row level security;

-- specs/produkte-varianten-farben.md §2
create table product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  size_label text not null,
  weight_g numeric not null,
  print_time_min numeric not null,
  work_time_min numeric not null,
  material_need_g numeric not null,
  min_qty int not null,
  max_qty int not null,
  step_qty int not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table product_variants enable row level security;

-- specs/produkte-varianten-farben.md §2
create table product_color_finish_options (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  color_id uuid not null references colors(id),
  finish_id uuid not null references finishes(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table product_color_finish_options enable row level security;

-- specs/filament-material.md §2
create table filament_spools (
  id uuid primary key default gen_random_uuid(),
  filament_product_id uuid not null references filament_products(id),
  purchase_price numeric not null,
  initial_weight_g numeric not null,
  tare_weight_g numeric not null,
  purchase_date date not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table filament_spools enable row level security;

-- specs/lizenzen.md §2
create table license_product_links (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references licenses(id),
  product_id uuid not null references products(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table license_product_links enable row level security;

-- specs/lizenzen.md §2
create table license_cost_models (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references licenses(id),
  cost_type license_cost_type not null,
  amount numeric not null,
  period text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table license_cost_models enable row level security;

-- specs/angebote-individuelle-anfragen.md §2
-- color_id/finish_id bewusst nullable: Fallback für den einfarbigen Fall.
-- Bei mehrfarbigen Anfragen wird stattdessen custom_request_colors genutzt (Ebene 4).
create table custom_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  makerworld_link text,
  own_image text,
  desired_size text not null,
  color_id uuid references colors(id),
  finish_id uuid references finishes(id),
  qty int not null,
  message text not null,
  status custom_request_status not null default 'neu',
  slice_file_upload text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table custom_requests enable row level security;
