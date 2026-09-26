-- Migration 00150: Views (v_catalog, v_order_tracking)
-- Siehe specs/implementierungsplan-schritt9.md §5, specs/00-overview.md §1
-- Prinzipien #6 (Kunde sieht nie interne Kosten), #7 (interne Notizen nie
-- öffentlich); specs/produkte-varianten-farben.md §2/§3 (Katalogaufbau);
-- specs/bestellungen.md §2/§4 (order_items, Statusübergänge/Zeitstempel).
--
-- Wichtig zu Views + RLS (Task-Vorgabe): Eine View läuft standardmäßig mit den
-- Rechten ihres Eigentümers (hier: der Migrations-Ausführende), nicht des
-- abfragenden Nutzers — sie umgeht damit die RLS-Policies der zugrunde
-- liegenden Tabellen. Bei v_catalog ist das gewollt (die active=true-Filterung
-- steht direkt in der View). Bei v_order_tracking ist das sicherheitskritisch:
-- diese View bekommt deshalb NIEMALS ein GRANT für anon — der einzige
-- vorgesehene Zugriffsweg für Kunden ist fn_get_order_by_token (00149,
-- SECURITY DEFINER), das unabhängig von dieser View direkt auf die
-- Basistabellen zugreift (siehe Kommentar unten).

-- ===========================================================================
-- v_catalog — öffentliche Katalogsicht
-- ===========================================================================
-- Nur aktive Produkte mit ihren aktiven Varianten. Preis ausschließlich aus
-- calculation_versions.final_price der aktuell gültigen Version
-- (scope_type='product_variant', is_current=true) — keine Kostenfelder,
-- keine margin_percent, kein min_price, kein calculated_price (#6). Varianten
-- ohne gültige Kalkulationsversion bleiben enthalten, final_price dann NULL
-- (kein Herausfiltern, LEFT JOIN).
create view v_catalog as
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
  cv.final_price
from products p
join product_variants pv
  on pv.product_id = p.id
 and pv.active = true
left join calculation_versions cv
  on cv.scope_type = 'product_variant'
 and cv.scope_id   = pv.id
 and cv.is_current = true
where p.active = true;

grant select on v_catalog to anon, authenticated;

-- ===========================================================================
-- v_order_tracking — Kundensicht auf eine Bestellung
-- ===========================================================================
-- Eine Zeile je order_item, mit den bestellungsweiten Feldern dupliziert.
-- Positionsbezeichnung: bei Katalogbezug Produktname + size_label + Farbe/
-- Finish (identisch zur Logik in fn_get_order_by_token, 00149), im
-- Ausnahmepfad order_items.desired_description. NIEMALS enthalten:
-- internal_note, jegliche Kostenfelder aus calculation_versions,
-- handed_over_by, handover_note (#6/#7) — Preis je Position nur final_price.
--
-- KEIN GRANT an anon (siehe Hinweis oben) — nur authenticated.
create view v_order_tracking as
select
  o.id                  as order_id,
  o.order_number,
  o.status              as order_status,
  o.confirmed_at,
  o.finished_at,
  o.ready_for_pickup_at,
  o.handed_over_at,
  oi.id                 as order_item_id,
  oi.qty,
  oi.status             as item_status,
  cv.final_price,
  coalesce(
    oi.desired_description,
    p.name || ' - ' || pv.size_label ||
      case when desc_agg.summary is not null
           then ' (' || desc_agg.summary || ')'
           else ''
      end
  )                      as description
from orders o
join order_items oi
  on oi.order_id = o.id
join calculation_versions cv
  on cv.id = oi.calculation_version_id
left join products p
  on p.id = oi.product_id
left join product_variants pv
  on pv.id = oi.variant_id
left join lateral (
  select string_agg(
           case when vcc.product_part_id is null
                then col.name || '/' || fin.name
                else pp.name || ': ' || col.name || '/' || fin.name
           end,
           ', ' order by pp.sort_order nulls first, col.name
         ) as summary
  from variant_configuration_colors vcc
  left join product_parts pp on pp.id = vcc.product_part_id
  join colors col   on col.id = vcc.color_id
  join finishes fin on fin.id = vcc.finish_id
  where vcc.variant_configuration_id = oi.variant_configuration_id
) desc_agg on true;

grant select on v_order_tracking to authenticated;

-- Regressionsprüfung (Task-Vorgabe): fn_get_order_by_token (00149) referenziert
-- diese View NICHT — sie greift direkt auf orders/order_items/
-- calculation_versions/products/product_variants/variant_configuration_colors
-- zu (eigene, identische Projektions-Logik). Da kein Verweis auf v_order_tracking
-- besteht, gibt es durch die Anlage dieser View keine Regression in der
-- Funktion. Bewusst nicht geändert, siehe Schlussbericht.
