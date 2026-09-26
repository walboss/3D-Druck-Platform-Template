-- Migration 00171: Storefront zeigt nur Farben/Finishes mit aktuellem Filament-Bestand
-- Entscheidung 2026-09-20 (Betreiber), Nachtrag zu Migration 00170: "alle
-- Farben global verfügbar" ging zu weit — angezeigt werden sollen nur
-- Farben (und dazu passende Finishes), zu denen gerade tatsächlich
-- Filament am Lager ist, nicht die komplette Farben-Stammdaten-Liste.
--
-- Restbestand einer Spule laut specs/filament-material.md §3:
-- initial_weight_g + Σ(filament_movements.amount_g) — keine eigene
-- current_weight-Spalte, um Divergenz zu vermeiden.
--
-- Bewusst NUR eine Frontend-Anzeige-Filterung (welche Farbe/Finish der
-- Kunde im Storefront zur Auswahl bekommt), keine zusätzliche
-- Server-Validierung beim Hinzufügen/Checkout: fn_cart_add_item
-- reserviert laut Kommentar in 00149 ausdrücklich keinen Bestand (#14) --
-- dieselbe Logik gilt hier, Bestand ist eine weiche Anzeige-Größe, keine
-- harte Transaktionsbedingung. fn_create_variant_configuration_if_missing
-- (00170) bleibt unverändert (aktiv in colors/finishes reicht serverseitig).
--
-- Zwei interne Views (nicht an anon vergeben, nur intern von der
-- SECURITY DEFINER Funktion unten gelesen) + eine schmale öffentliche
-- Funktion, analog fn_get_public_settings (00163): gibt ausschließlich
-- Farben/Finishes mit Bestand > 0 zurück, keine Mengen, keine Preise,
-- keine sonstigen Lagerinterna.

create view v_filament_spool_remaining as
select
  fs.id                 as spool_id,
  fs.filament_product_id,
  fs.active,
  fs.initial_weight_g + coalesce(sum(fm.amount_g), 0) as remaining_g
from filament_spools fs
left join filament_movements fm on fm.spool_id = fs.id
group by fs.id, fs.filament_product_id, fs.active, fs.initial_weight_g;

create view v_color_finish_stock as
select
  fp.color_id,
  fp.finish_id,
  sum(sr.remaining_g) as remaining_g
from filament_products fp
join v_filament_spool_remaining sr
  on sr.filament_product_id = fp.id
 and sr.active
where fp.active
group by fp.color_id, fp.finish_id
having sum(sr.remaining_g) > 0;

create or replace function fn_get_public_stock_options()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'colors', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'hex', c.hex))
      from colors c
      where c.active
        and exists (select 1 from v_color_finish_stock v where v.color_id = c.id)
    ), '[]'::jsonb),
    'finishes', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name))
      from finishes f
      where f.active
        and exists (select 1 from v_color_finish_stock v where v.finish_id = f.id)
    ), '[]'::jsonb),
    'colorFinishPairs', coalesce((
      select jsonb_agg(jsonb_build_object('color_id', v.color_id, 'finish_id', v.finish_id))
      from v_color_finish_stock v
    ), '[]'::jsonb)
  );
$$;

revoke all on function fn_get_public_stock_options() from public;
grant execute on function fn_get_public_stock_options() to anon, authenticated;
