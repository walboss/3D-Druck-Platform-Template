-- Migration 00157: Lagerkritisch-Schwellenwert in settings, Dashboard-View
-- v_dashboard_stock_low liest den Schwellenwert aus settings, privater
-- Storage-Bucket custom-request-files für Individualanfrage-Uploads.
-- Siehe specs/16-admin-dashboard.md (Views, Single Source of Truth für
-- fachliche Schwellenwerte), specs/17-storefront-katalog-checkout.md §4
-- (Kunden-Dedup — bereits in 00156 umgesetzt, hier nur geprüft),
-- specs/produktdaten-import-3mf.md (Dateityp .gcode.3mf, Farbslots).
--
-- Stand vor dieser Migration (00156, geprüft):
--   - v_dashboard_orders_open, v_dashboard_stock_low,
--     v_dashboard_production_running existieren, SELECT nur authenticated.
--     v_dashboard_stock_low hat den Schwellenwert 100 g fest verdrahtet —
--     das wird hier durch die neue settings-Spalte ersetzt.
--   - fn_place_order sucht vor Neuanlage per Telefon ODER E-Mail nach einem
--     bestehenden Kunden (Normalisierung wie fn_customer_search). Signatur
--     und Rückgabewert unverändert. Keine weitere Änderung nötig.
--   - fn_submit_custom_request (00146) hat bereits p_own_image text
--     (Referenzbild-Verweis), p_slice_file_upload text (3mf-Verweis) und
--     p_slot_colors jsonb ([{slot_label, hex}, ...]) — keine Erweiterung nötig.
--
-- Keine Änderung am Cloudflare Worker, kein Frontend-Code.

-- ===========================================================================
-- ABSCHNITT A: settings.low_stock_threshold_g
-- ===========================================================================
-- Schwellenwert in Gramm, unter dem eine Spule im Dashboard als
-- "Lagerkritisch" gilt (specs/16: Schwellenwerte zentral, nicht im Client).
-- Default 100 entspricht dem bisher fest verdrahteten Wert aus 00156.
alter table settings
  add column if not exists low_stock_threshold_g numeric not null default 100;

-- Bestehende einzige Zeile explizit auf 100 setzen (idempotent: ADD COLUMN
-- mit DEFAULT füllt bereits 100, das UPDATE ist ein no-op bei Wiederholung).
update settings set low_stock_threshold_g = 100
where low_stock_threshold_g is distinct from 100;

-- ===========================================================================
-- ABSCHNITT B: v_dashboard_stock_low — Schwellenwert aus settings
-- ===========================================================================
-- Spaltenliste identisch zu 00156, daher CREATE OR REPLACE ohne DROP
-- (bestehende Grants bleiben erhalten). Einzige Änderung: der Vergleichswert
-- kommt aus settings.low_stock_threshold_g statt aus dem Literal 100.
-- settings hat genau eine Zeile (00151); `limit 1` als Absicherung.
create or replace view v_dashboard_stock_low as
select
  fs.id                as spool_id,
  fs.filament_product_id,
  fp.manufacturer,
  fp.product_name,
  fp.material,
  col.name              as color_name,
  fs.initial_weight_g + coalesce(mov.amount_sum, 0)                            as rest_g,
  fs.initial_weight_g + coalesce(mov.amount_sum, 0) - coalesce(res.qty_sum, 0) as available_g
from filament_spools fs
join filament_products fp on fp.id = fs.filament_product_id
left join colors col on col.id = fp.color_id
left join lateral (
  select sum(m.amount_g) as amount_sum
  from filament_movements m
  where m.spool_id = fs.id
) mov on true
left join lateral (
  select sum(r.amount_g) as qty_sum
  from filament_reservations r
  where r.spool_id = fs.id
    and r.status = 'aktiv'
) res on true
where fs.active = true
  and (fs.initial_weight_g + coalesce(mov.amount_sum, 0) - coalesce(res.qty_sum, 0))
      < (select s.low_stock_threshold_g from settings s limit 1);

grant select on v_dashboard_stock_low to authenticated;

-- ===========================================================================
-- ABSCHNITT C: Storage-Bucket custom-request-files
-- ===========================================================================
-- Privater Bucket (public = false) für Referenzbilder und .gcode.3mf-Dateien
-- zu Individualanfragen. Upload läuft ausschließlich über den Cloudflare
-- Worker mit service_role (umgeht RLS), deshalb bewusst KEINE anon-Policy
-- auf storage.objects — anon sieht/schreibt nichts (RLS Deny-All).
-- authenticated (Admin) bekommt SELECT auf die Objekte dieses Buckets, um
-- hochgeladene Dateien im Anfragen-Postfach einsehen zu können.
insert into storage.buckets (id, name, public)
values ('custom-request-files', 'custom-request-files', false)
on conflict (id) do nothing;

drop policy if exists admin_select_custom_request_files on storage.objects;
create policy admin_select_custom_request_files on storage.objects
  for select to authenticated
  using (bucket_id = 'custom-request-files');
