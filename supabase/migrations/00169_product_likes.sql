-- Migration 00169: Like-System (Cookie-basiert, anonym)
-- Siehe specs/like-system.md §2 (Tabelle), §3 (Cookie, Frontend-Teil),
-- §4 (fn_toggle_like), §5a (fn_get_liked_products). Eigenständige Entität,
-- unabhängig von den Privatmodus-Flags (immer sichtbar) und ohne
-- Kalkulations-/Bestellbezug.

-- ===========================================================================
-- ABSCHNITT A: product_likes
-- ===========================================================================
-- RLS wird sofort aktiviert, ohne Policies (Konvention wie product_suggestions,
-- 00160): kein Direktzugriff, nur ueber die SECURITY-DEFINER-Funktionen unten
-- und die Aggregat-View v_product_like_counts (keine visitor_token darin,
-- daher unbedenklich fuer anon).
create table product_likes (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products(id),
  visitor_token  text not null,
  created_at     timestamptz not null default now(),
  constraint uq_product_likes_product_visitor unique (product_id, visitor_token)
);

create index idx_product_likes_product on product_likes (product_id);

comment on table product_likes is
  'Anonyme Produkt-Likes (Spec like-system.md). visitor_token kommt aus einem langlebigen Cookie, kein Personenbezug. Bleiben bei Produkt-Deaktivierung erhalten (#1), zaehlen dann aber nirgends mehr mit.';
comment on column product_likes.visitor_token is
  'Zufaellige ID aus dem mw_visitor_id-Cookie (~1 Jahr Laufzeit). Kein Auth-Zwang (Spec §4) — bewusst minimales Missbrauchsrisiko akzeptiert, MVP (#17).';

alter table product_likes enable row level security;

-- ===========================================================================
-- ABSCHNITT B: v_product_like_counts — oeffentliche Aggregat-Sicht
-- ===========================================================================
-- Aktuelle Like-Anzahl je Produkt = COUNT(*) (Spec §2, kein Zaehlerfeld auf
-- products, um Divergenz zu vermeiden). Keine visitor_token-Spalte, daher
-- unbedenklich fuer anon/authenticated SELECT.
create view v_product_like_counts as
select product_id, count(*)::integer as likes_count
from product_likes
group by product_id;

grant select on v_product_like_counts to anon, authenticated;

-- ===========================================================================
-- ABSCHNITT C: fn_toggle_like — atomarer Insert/Delete-Toggle (Spec §4)
-- ===========================================================================
-- Kein Insert vorhanden -> Insert (geliked). Insert vorhanden -> Delete
-- (entliked). Gibt neue Like-Anzahl + eigenen Like-Status zurueck. Race
-- zweier gleichzeitiger Toggles desselben Visitors auf dasselbe Produkt:
-- der UNIQUE-Constraint faengt den Insert-Konflikt ab, dann gilt "bereits
-- geliked" (konsistent, kein Fehler).
create function fn_toggle_like(
  p_product_id    uuid,
  p_visitor_token text
)
returns table(likes_count integer, liked boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token   text := nullif(trim(p_visitor_token), '');
  v_deleted integer;
  v_liked   boolean;
begin
  if v_token is null then
    raise exception 'fn_toggle_like: visitor_token darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from products p where p.id = p_product_id) then
    raise exception 'fn_toggle_like: Produkt % existiert nicht', p_product_id
      using errcode = 'invalid_parameter_value';
  end if;

  delete from product_likes
  where product_id = p_product_id and visitor_token = v_token;
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    v_liked := false;
  else
    begin
      insert into product_likes (product_id, visitor_token)
      values (p_product_id, v_token);
      v_liked := true;
    exception when unique_violation then
      v_liked := true;
    end;
  end if;

  return query
  select count(*)::integer, v_liked
  from product_likes pl
  where pl.product_id = p_product_id;
end;
$$;

revoke all on function fn_toggle_like(uuid, text) from public;
grant execute on function fn_toggle_like(uuid, text) to anon, authenticated;

-- ===========================================================================
-- ABSCHNITT D: fn_get_my_liked_product_ids — eigener Like-Status im Katalog
-- ===========================================================================
-- Technische Ergaenzung (nicht explizit in Spec §5a benannt, aber noetig fuer
-- §5 "Like-Icon ... antippbar" auf Katalog-Karte/Produktdetail): liefert nur
-- die Produkt-IDs, zu denen DIESER Visitor bereits eine Like-Zeile hat.
-- Gleiche Sicherheitsueberlegung wie fn_toggle_like — visitor_token kommt
-- vom Client, kein zusaetzlicher Schutz (Spec §4, akzeptiertes Risiko).
create function fn_get_my_liked_product_ids(
  p_visitor_token text
)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(pl.product_id), '{}'::uuid[])
  from product_likes pl
  where pl.visitor_token = nullif(trim(p_visitor_token), '');
$$;

revoke all on function fn_get_my_liked_product_ids(text) from public;
grant execute on function fn_get_my_liked_product_ids(text) to anon, authenticated;

-- ===========================================================================
-- ABSCHNITT E: fn_get_liked_products — Backend fuer den Likes-Tab (Spec §5a)
-- ===========================================================================
-- Gleiche Zeilenform wie v_catalog (00150) — Produkte inkl. der fuers
-- Karten-Grid noetigen Felder, gefiltert auf Likes dieses Visitors. Nur
-- aktive Produkte (v_catalog filtert active=true bereits selbst), passend zu
-- Randfall §6: deaktivierte Produkte zaehlen nirgends mehr mit.
create function fn_get_liked_products(
  p_visitor_token text
)
returns setof v_catalog
language sql
stable
security definer
set search_path = public
as $$
  select vc.*
  from v_catalog vc
  where nullif(trim(p_visitor_token), '') is not null
    and exists (
      select 1 from product_likes pl
      where pl.product_id = vc.product_id
        and pl.visitor_token = trim(p_visitor_token)
    );
$$;

revoke all on function fn_get_liked_products(text) from public;
grant execute on function fn_get_liked_products(text) to anon, authenticated;
