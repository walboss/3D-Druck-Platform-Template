-- Migration 0013: Ebene 13 (audit_log)
-- Siehe specs/00-overview.md §3 (FK-Ebene 13, entity-übergreifend, technisch
-- unabhängig) und specs/audit-settings.md §2.
-- RLS aktiviert, noch ohne Policy (siehe implementierungsplan-schritt9.md §1).

-- specs/audit-settings.md §2: kein FK auf entity_type/entity_id (textbasiert),
-- kein updated_at, da audit_log append-only ist und nie überschrieben wird.
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  field_name text,
  old_value text,
  new_value text,
  reason text,
  actor text not null,
  created_at timestamptz not null default now()
);

alter table audit_log enable row level security;
