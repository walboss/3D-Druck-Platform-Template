-- Migration 0011: Ebene 11 (→ Ebene 10)
-- Siehe specs/00-overview.md §3 (FK-Ebene 11, Vorwärtsreferenz-Hinweis) und
-- specs/produktion.md §2.
-- Alle Tabellen: RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- specs/produktion.md §2
create table production_batch_items (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references production_orders(id),
  order_item_id uuid not null references order_items(id),
  qty_planned int not null,
  qty_success int,
  qty_scrap_normal int,
  qty_scrap_complaint int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table production_batch_items enable row level security;

-- Vorwärtsreferenzen aus Ebene 8/9 werden jetzt nachgezogen, siehe
-- specs/00-overview.md §3 und specs/implementierungsplan-schritt9.md §1.
alter table order_items
  add constraint fk_order_items_production_order
  foreign key (production_order_id) references production_orders(id);

alter table filament_reservations
  add constraint fk_filament_reservations_production_batch_item
  foreign key (production_batch_item_id) references production_batch_items(id);
