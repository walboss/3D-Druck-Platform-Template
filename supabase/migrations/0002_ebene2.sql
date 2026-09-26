-- Migration 0002: Ebene 2 (→ Ebene 1)
-- Siehe specs/00-overview.md §3 (FK-Ebene 2) und die jeweiligen Domänen-Specs §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- Enum für products.images[].source_type. Existierte noch nicht in 0000_enums_and_extensions.sql.
create type image_source_type as enum (
  'extern_link', 'eigenes_hosting'
);

-- specs/lizenzen.md §2
create table licenses (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id),
  commercial_use_allowed boolean not null,
  valid_from date,
  valid_until date,
  status license_status not null,
  proof_note text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table licenses enable row level security;

-- specs/filament-material.md §2
create table filament_products (
  id uuid primary key default gen_random_uuid(),
  manufacturer text not null,
  product_name text not null,
  material text not null,
  color_id uuid not null references colors(id),
  finish_id uuid not null references finishes(id),
  diameter_mm numeric not null,
  print_temp_c int not null,
  bed_temp_c int not null,
  print_profile text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table filament_products enable row level security;

-- specs/produkte-varianten-farben.md §2
create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  category text,
  images jsonb not null default '[]'::jsonb,
  tags text[] not null default '{}'::text[],
  active boolean not null default true,
  is_multicolor boolean not null default false,
  license_id uuid references licenses(id),
  -- source_custom_request_id: Vorwärtsreferenz auf custom_requests (kommt erst in Ebene 3).
  -- Bewusst OHNE FK-Constraint, analog zum Muster von order_items.production_order_id
  -- aus specs/00-overview.md §3. FK wird in einer späteren Migration nachgezogen.
  source_custom_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_products_tags on products using gin (tags);

alter table products enable row level security;
