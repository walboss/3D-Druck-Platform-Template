-- Migration 0008: Ebene 8 (→ Ebene 7)
-- Siehe specs/00-overview.md §3 (FK-Ebene 8) und specs/bestellungen.md §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- specs/bestellungen.md §2
create table order_bundle_groups (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  bundle_id uuid not null references product_bundles(id),
  bundle_price numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table order_bundle_groups enable row level security;

-- specs/bestellungen.md §2
-- product_id/variant_id/variant_configuration_id: alle drei nullable — Ausnahmepfad für
-- nicht-katalogisierte Positionen (desired_description) statt Katalogbezug.
-- production_order_id: bewusst uuid ohne FK-Constraint — production_orders entsteht erst in
-- Ebene 10, siehe specs/00-overview.md §3 (Vorwärtsreferenz-Hinweis) und
-- specs/implementierungsplan-schritt9.md §1 (Constraint folgt in Migration 0011).
create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  product_id uuid references products(id),
  variant_id uuid references product_variants(id),
  variant_configuration_id uuid references variant_configurations(id),
  desired_description text,
  qty int not null,
  status order_item_status not null,
  cancellation_reason text,
  calculation_version_id uuid not null references calculation_versions(id),
  bundle_group_id uuid references order_bundle_groups(id),
  production_order_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_order_items_katalog_xor_desc check (
    (product_id is not null and variant_id is not null and variant_configuration_id is not null and desired_description is null)
    or
    (product_id is null and variant_id is null and variant_configuration_id is null and desired_description is not null)
  )
);

alter table order_items enable row level security;

-- specs/implementierungsplan-schritt9.md §2: bundle_group_id gesetzt => order_bundle_groups.order_id
-- muss mit order_items.order_id übereinstimmen (reines FK kann das nicht abbilden).
create function trg_check_bundle_group_order_fn() returns trigger as $$
begin
  if new.bundle_group_id is not null then
    if not exists (
      select 1 from order_bundle_groups
      where id = new.bundle_group_id
      and order_id = new.order_id
    ) then
      raise exception 'order_items.bundle_group_id % gehört zu einer anderen order_id als order_items.order_id %', new.bundle_group_id, new.order_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_check_bundle_group_order
  before insert or update on order_items
  for each row execute function trg_check_bundle_group_order_fn();
