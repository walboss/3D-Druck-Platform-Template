-- Migration 00205: v_catalog liefert created_at (Review D29)
--
-- Der Katalog lud bisher v_catalog UND zusaetzlich products nur fuer
-- created_at (Sortierung "Neueste", Badge "Neu") — zwei Requests. Die View
-- bekommt created_at als letzte Spalte; sonst unveraendert gegenueber 00194
-- (Preis nur bei sichtbaren Preisen, security_invoker aus 00196 bleibt).
-- fn_get_liked_products (returns setof v_catalog, select vc.*) liefert die
-- Spalte automatisch mit.
--
-- Rollback: View aus 00194 erneut einspielen (create or replace ohne created_at
-- geht nicht, da Spalten nicht entfernt werden koennen -> drop + create +
-- Grants/Option wie 00196).

create or replace view v_catalog
with (security_invoker = true)
as
select
  p.id          as product_id,
  p.name,
  p.description,
  p.category,
  p.tags,
  p.images,
  pv.id         as variant_id,
  pv.size_label,
  pv.min_qty,
  pv.max_qty,
  pv.step_qty,
  case when (select public.fn_prices_visible_to_caller()) then cv.final_price end as final_price,
  p.created_at
from products p
join product_variants pv
  on pv.product_id = p.id
 and pv.active = true
left join calculation_versions cv
  on cv.scope_type = 'product_variant'
 and cv.scope_id   = pv.id
 and cv.is_current = true
where p.active = true;
