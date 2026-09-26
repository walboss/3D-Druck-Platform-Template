-- Migration 00196: Views mit security_invoker, anon-Rechte auf Views bereinigt
--
-- Befund Supabase-Linter 2026-09-26 ("security_definer_view"): Alle Views in
-- public liefen mit den Rechten ihres Erstellers und umgingen damit RLS.
-- Supabase vergibt per Default-Privileges SELECT auf neue Tabellen/Views an
-- anon — bei v_order_tracking (Bestellungen) und v_dashboard_orders_open
-- (Vor-/Nachname) wäre das ein Datenleck gewesen, da diese Views nie ein
-- anon-Grant bekommen sollten (Kommentar in 00150).
--
-- Neu:
-- 1. Explizit REVOKE für anon auf alle Admin-/internen Views.
-- 2. Alle Views: security_invoker = true → Rechte/RLS des Aufrufers gelten.
-- 3. Damit v_catalog und v_product_like_counts für anon weiter funktionieren,
--    bekommt anon genau die nötigen Spalten + eine lesende RLS-Policy:
--    - calculation_versions: nur scope_type, scope_id, is_current,
--      final_price; nur aktuelle Produktvarianten-Preise und nur, wenn Preise
--      sichtbar sind (fn_prices_visible_to_caller, 00194). Kostenfelder
--      bleiben gesperrt (#6).
--    - product_likes: nur product_id (visitor_token bleibt unsichtbar).
-- 4. trg_check_bundle_group_order_fn: fester search_path (Linter
--    "function_search_path_mutable").
-- 5. Trigger-Funktionen (SECURITY DEFINER) nicht per RPC aufrufbar
--    (Linter "Public Can Execute SECURITY DEFINER Function").

-- ---------------------------------------------------------------------------
-- 1. Admin-/interne Views: kein Zugriff für anon
-- ---------------------------------------------------------------------------
revoke all on v_order_tracking               from anon;
revoke all on v_dashboard_orders_open        from anon;
revoke all on v_dashboard_production_running from anon;
revoke all on v_dashboard_stock_low          from anon;
revoke all on v_filament_spool_remaining     from anon;
revoke all on v_color_finish_stock           from anon;

-- Öffentliche Views: nur lesen
revoke all on v_catalog             from anon;
revoke all on v_product_like_counts from anon;
grant select on v_catalog             to anon;
grant select on v_product_like_counts to anon;

-- ---------------------------------------------------------------------------
-- 2. security_invoker für alle Views
-- ---------------------------------------------------------------------------
alter view v_catalog                      set (security_invoker = true);
alter view v_product_like_counts          set (security_invoker = true);
alter view v_order_tracking               set (security_invoker = true);
alter view v_dashboard_orders_open        set (security_invoker = true);
alter view v_dashboard_production_running set (security_invoker = true);
alter view v_dashboard_stock_low          set (security_invoker = true);
alter view v_filament_spool_remaining     set (security_invoker = true);
alter view v_color_finish_stock           set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- 3a. calculation_versions: minimaler Lesezugriff für anon (v_catalog)
-- ---------------------------------------------------------------------------
revoke all on calculation_versions from anon;
grant select (scope_type, scope_id, is_current, final_price) on calculation_versions to anon;

create policy anon_select_current_variant_prices on calculation_versions
  for select to anon
  using (
    scope_type = 'product_variant'
    and is_current
    and (select public.fn_prices_visible_to_caller())
  );

-- ---------------------------------------------------------------------------
-- 3b. product_likes: nur product_id lesbar (v_product_like_counts)
-- ---------------------------------------------------------------------------
revoke all on product_likes from anon, authenticated;
grant select (product_id) on product_likes to anon, authenticated;

create policy public_select_product_likes on product_likes
  for select to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- 4. Trigger-Funktion mit festem search_path
-- ---------------------------------------------------------------------------
alter function trg_check_bundle_group_order_fn() set search_path = public;

-- ---------------------------------------------------------------------------
-- 5. Trigger-Funktionen: kein EXECUTE für anon/authenticated
-- ---------------------------------------------------------------------------
revoke all on function fn_auto_calculate_new_variant() from public, anon, authenticated;
revoke all on function trg_retry_on_material_inflow_fn() from public, anon, authenticated;
