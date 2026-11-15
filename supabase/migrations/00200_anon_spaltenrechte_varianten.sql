-- Migration 00200: anon darf keine Betriebsinterna aus Varianten lesen
--
-- Befund (OFFENE-SECURITY-FIXES.md, Entscheidung Betreiber 2026-10-10): Mit dem
-- oeffentlichen anon-Key konnten Gewicht, Druck-/Arbeitszeit und Materialbedarf
-- direkt ueber die Tabellen product_variants und variant_parts gelesen werden
-- (Grant auf alle Spalten aus 00149). Gleiche Loesung wie bei
-- calculation_versions (00196): Spaltenrechte statt Tabellenrecht.
--
-- product_variants: anon behaelt nur die Spalten, die v_catalog (security_invoker,
-- 00196) braucht: id, product_id, size_label, min_qty, max_qty, step_qty, active.
-- Gesperrt: weight_g, print_time_min, work_time_min, material_need_g (und alle
-- uebrigen). Die RLS-Policy anon_select_product_variants (active = true) bleibt.
--
-- variant_parts: wird vom Shop nicht direkt gelesen (nur product_parts mit
-- Name/Reihenfolge). Gewicht/Druckzeit/Materialbedarf sind dieselben
-- Betriebsinterna; anon behaelt nur id, variant_id, product_part_id.
--
-- Nicht betroffen: Admin (authenticated), RPCs mit security definer, Worker.

revoke select on product_variants from anon;
grant select (id, product_id, size_label, min_qty, max_qty, step_qty, active)
  on product_variants to anon;

revoke select on variant_parts from anon;
grant select (id, variant_id, product_part_id)
  on variant_parts to anon;
