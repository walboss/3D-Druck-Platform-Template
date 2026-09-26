-- Migration 00190: Admin-Rechte an Tabelle admins binden
-- Siehe OFFENE-SECURITY-FIXES.md §2, specs/audit-settings.md §admins,
-- specs/implementierungsplan-schritt9.md §3.
--
-- Bisher galt jeder eingeloggte Nutzer (Rolle authenticated) als Admin:
-- alle admin_*-Policies waren `using (true)` / `with check (true)`
-- (00149, 00161, 00187). Wäre die Registrierung in Supabase Auth offen
-- (auch über Google-OAuth), hätte jeder neue Account vollen Admin-Zugriff.
--
-- Bewusste Abweichung von implementierungsplan-schritt9.md §3 ("gebunden an
-- auth.role() = 'authenticated'"), Entscheidung Betreiber 2026-09-24:
-- Admin ist nur, wessen JWT-E-Mail in admins steht (active = true),
-- Abgleich ohne Groß-/Kleinschreibung (Variante (a), keine neue Spalte).
--
--   1. fn_is_admin() — SECURITY DEFINER, damit die Prüfung selbst nicht an
--      der RLS auf admins hängt.
--   2. Alle authenticated-Policies mit (true) → fn_is_admin() per
--      `alter policy` (bestehende Migrationen bleiben unverändert).
--      Aufruf als `(select public.fn_is_admin())`, damit Postgres das
--      Ergebnis einmal pro Statement statt pro Zeile auswertet.
--   3. Storage-Policy auf custom-request-files (00157): Die Storage-API läuft
--      nicht über PostgREST, db_pre_request greift dort nicht.
--   4. fn_mfa_pre_request() (00162) lehnt authenticated ohne Admin-Eintrag
--      ab — deckt auch die SECURITY-DEFINER-Admin-Funktionen ab, die RLS
--      umgehen.
--
-- Schutz gegen Aussperren: Die Migration bricht ab, wenn kein aktiver
-- admins-Eintrag mit einem existierenden Supabase-Auth-Account (gleiche
-- E-Mail) übereinstimmt.
--
-- Rollback: Policies wieder auf (true) setzen und fn_mfa_pre_request() aus
--           00162 erneut einspielen.

-- ===========================================================================
-- 0. Schutz gegen Aussperren
-- ===========================================================================
do $$
begin
  if not exists (
    select 1
    from public.admins a
    join auth.users u on lower(u.email) = lower(a.email)
    where a.active
  ) then
    raise exception 'Migration 00190 abgebrochen: kein aktiver admins-Eintrag passt zu einem Supabase-Auth-Account (E-Mail) — Admin würde ausgesperrt';
  end if;
end;
$$;

-- ===========================================================================
-- 1. fn_is_admin()
-- ===========================================================================
create or replace function public.fn_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from admins a
    where a.active
      and lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

comment on function public.fn_is_admin() is
  'true, wenn die E-Mail aus dem JWT einem aktiven Eintrag in admins entspricht (Migration 00190).';

revoke execute on function public.fn_is_admin() from public;
grant execute on function public.fn_is_admin() to anon, authenticated, service_role;

-- ===========================================================================
-- 2. Tabellen-Policies für authenticated
-- ===========================================================================

-- aus Migration 00149
alter policy admin_all_colors on colors
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_finishes on finishes
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_creators on creators
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_admins on admins
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_printers on printers
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_customers on customers
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_products on products
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_filament_products on filament_products
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_licenses on licenses
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_product_parts on product_parts
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_product_variants on product_variants
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_product_color_finish_options on product_color_finish_options
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_filament_spools on filament_spools
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_license_product_links on license_product_links
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_license_cost_models on license_cost_models
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_variant_parts on variant_parts
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_variant_configurations on variant_configurations
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_product_bundles on product_bundles
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_custom_request_colors on custom_request_colors
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_variant_configuration_colors on variant_configuration_colors
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_bundle_items on bundle_items
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_order_bundle_groups on order_bundle_groups
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_cart_sessions on cart_sessions
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_cart_items on cart_items
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_order_tracking_tokens on order_tracking_tokens
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_complaints on complaints
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_all_license_recurring_charges on license_recurring_charges
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_custom_requests on custom_requests
  using ((select public.fn_is_admin()));
alter policy admin_insert_custom_requests on custom_requests
  with check ((select public.fn_is_admin()));
alter policy admin_update_custom_requests on custom_requests
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_offers on offers
  using ((select public.fn_is_admin()));
alter policy admin_insert_offers on offers
  with check ((select public.fn_is_admin()));
alter policy admin_update_offers on offers
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_offer_items on offer_items
  using ((select public.fn_is_admin()));
alter policy admin_insert_offer_items on offer_items
  with check ((select public.fn_is_admin()));
alter policy admin_update_offer_items on offer_items
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_calculation_versions on calculation_versions
  using ((select public.fn_is_admin()));
alter policy admin_insert_calculation_versions on calculation_versions
  with check ((select public.fn_is_admin()));
alter policy admin_update_calculation_versions on calculation_versions
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_orders on orders
  using ((select public.fn_is_admin()));
alter policy admin_insert_orders on orders
  with check ((select public.fn_is_admin()));
alter policy admin_update_orders on orders
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_order_items on order_items
  using ((select public.fn_is_admin()));
alter policy admin_insert_order_items on order_items
  with check ((select public.fn_is_admin()));
alter policy admin_update_order_items on order_items
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_filament_movements on filament_movements
  using ((select public.fn_is_admin()));
alter policy admin_insert_filament_movements on filament_movements
  with check ((select public.fn_is_admin()));
alter policy admin_update_filament_movements on filament_movements
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_finished_goods_movements on finished_goods_movements
  using ((select public.fn_is_admin()));
alter policy admin_insert_finished_goods_movements on finished_goods_movements
  with check ((select public.fn_is_admin()));
alter policy admin_update_finished_goods_movements on finished_goods_movements
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_finished_goods_reservations on finished_goods_reservations
  using ((select public.fn_is_admin()));
alter policy admin_insert_finished_goods_reservations on finished_goods_reservations
  with check ((select public.fn_is_admin()));
alter policy admin_update_finished_goods_reservations on finished_goods_reservations
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_filament_reservations on filament_reservations
  using ((select public.fn_is_admin()));
alter policy admin_insert_filament_reservations on filament_reservations
  with check ((select public.fn_is_admin()));
alter policy admin_update_filament_reservations on filament_reservations
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_production_orders on production_orders
  using ((select public.fn_is_admin()));
alter policy admin_insert_production_orders on production_orders
  with check ((select public.fn_is_admin()));
alter policy admin_update_production_orders on production_orders
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_production_batch_items on production_batch_items
  using ((select public.fn_is_admin()));
alter policy admin_insert_production_batch_items on production_batch_items
  with check ((select public.fn_is_admin()));
alter policy admin_update_production_batch_items on production_batch_items
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_production_material_usage on production_material_usage
  using ((select public.fn_is_admin()));
alter policy admin_insert_production_material_usage on production_material_usage
  with check ((select public.fn_is_admin()));
alter policy admin_update_production_material_usage on production_material_usage
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_settings on settings
  using ((select public.fn_is_admin()));
alter policy admin_update_settings on settings
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));
alter policy admin_select_audit_log on audit_log
  using ((select public.fn_is_admin()));
alter policy admin_insert_audit_log on audit_log
  with check ((select public.fn_is_admin()));

-- aus Migration 00161
alter policy admin_select_product_suggestions on product_suggestions
  using ((select public.fn_is_admin()));

-- aus Migration 00187
alter policy admin_all_category_seasons on category_seasons
  using ((select public.fn_is_admin())) with check ((select public.fn_is_admin()));

-- ===========================================================================
-- 3. Storage: custom-request-files (00157)
-- ===========================================================================
alter policy admin_select_custom_request_files on storage.objects
  using (bucket_id = 'custom-request-files' and (select public.fn_is_admin()));

-- ===========================================================================
-- 4. fn_mfa_pre_request(): zusätzlich Admin-Eintrag verlangen
-- ===========================================================================
create or replace function public.fn_mfa_pre_request()
returns void
language plpgsql
stable
set search_path = public
as $$
declare
  v_claims jsonb;
begin
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  if v_claims is null then
    return;
  end if;

  if (v_claims ->> 'role') = 'authenticated' then
    if coalesce(v_claims ->> 'aal', 'aal1') <> 'aal2' then
      raise exception 'MFA erforderlich: Sitzung hat nicht Assurance-Stufe aal2'
        using errcode = '42501', hint = 'mfa_required';
    end if;

    if not public.fn_is_admin() then
      raise exception 'Kein Admin-Zugang: Account steht nicht (aktiv) in admins'
        using errcode = '42501', hint = 'not_admin';
    end if;
  end if;
end;
$$;

comment on function public.fn_mfa_pre_request() is
  'PostgREST db_pre_request: verlangt für Rolle authenticated aal2 (TOTP) und einen aktiven admins-Eintrag (00162, 00190).';

notify pgrst, 'reload config';

-- ===========================================================================
-- 5. Kontrolle: keine authenticated-Policy mehr mit (true)
-- ===========================================================================
do $$
declare
  v_rest text;
begin
  select string_agg(schemaname || '.' || tablename || '.' || policyname, ', ')
    into v_rest
  from pg_policies
  where schemaname in ('public', 'storage')
    and 'authenticated' = any (roles)
    and (qual = 'true' or with_check = 'true');

  if v_rest is not null then
    raise exception 'Migration 00190: noch offene authenticated-Policies mit (true): %', v_rest;
  end if;
end;
$$;
