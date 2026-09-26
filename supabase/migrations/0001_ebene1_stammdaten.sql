-- Migration 0001: Ebene 1 Stammdaten (keine Fremdabhängigkeiten)
-- Siehe specs/00-overview.md §3 (FK-Ebene 1) und die jeweiligen Domänen-Specs §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- specs/produkte-varianten-farben.md §2
create table colors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  hex text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table colors enable row level security;

-- specs/produkte-varianten-farben.md §2
create table finishes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table finishes enable row level security;

-- specs/lizenzen.md §2
create table creators (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  profile_url text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table creators enable row level security;

-- specs/audit-settings.md §2
create table admins (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table admins enable row level security;

-- specs/produktion.md §2
create table printers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  model text not null,
  power_consumption_w numeric not null,
  machine_hour_rate numeric not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table printers enable row level security;

-- specs/kunden-warenkorb-tracking.md §2
-- anonymize_after ist nullable: laut implementierungsplan-schritt9.md §4 (fn_hand_over_order)
-- wird es erst bei Bestellübergabe gesetzt, existiert also bei der Kundenanlage noch nicht.
create table customers (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  email text,
  phone text,
  pickup_method text not null,
  anonymize_after date,
  anonymized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table customers enable row level security;

-- specs/audit-settings.md §2
create table settings (
  id uuid primary key default gen_random_uuid(),
  email_system_enabled boolean not null default false,
  email_required_at_order boolean not null default false,
  electricity_price_per_kwh numeric,
  default_labor_rate_per_hour numeric,
  min_order_value numeric,
  customer_data_retention_days int not null default 730,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table settings enable row level security;
