-- Migration 00177: Erstkalkulation nachtraeglich fuer Bestandsvarianten
-- Entscheidung 2026-09-20 (Betreiber): Trigger aus Migration 00175 greift nur bei
-- NEUEN Varianten. Wendet dieselbe Formel (Filamentkosten aus Gewicht * Durch-
-- schnittspreis/Gramm ueber aktive Filamente, Maschinenkosten aus Druckzeit *
-- settings.machine_hourly_rate, Margin 20%, reason='sonstiger_grund')
-- rueckwirkend auf alle product_variants ohne is_current-Kalkulationsversion
-- an -- betrifft die 21 Bestandsprodukte aus BUILD-LOG.md
-- "Migration 00173" (final_price = null).

do $$
declare
  v_price_per_gram numeric;
  v_machine_rate    numeric;
  v_variant         record;
  v_filament_cost   numeric;
  v_machine_cost    numeric;
begin
  select avg(fs.purchase_price / nullif(fs.initial_weight_g - fs.tare_weight_g, 0))
  into v_price_per_gram
  from filament_spools fs
  join filament_products fp on fp.id = fs.filament_product_id
  where fs.active and fp.active;

  select s.machine_hourly_rate into v_machine_rate from settings s limit 1;

  for v_variant in
    select pv.id, pv.weight_g, pv.print_time_min
    from product_variants pv
    where not exists (
      select 1 from calculation_versions cv
      where cv.scope_type = 'product_variant'
        and cv.scope_id = pv.id
        and cv.is_current
    )
  loop
    v_filament_cost := coalesce(v_price_per_gram, 0) * coalesce(v_variant.weight_g, 0);
    v_machine_cost  := coalesce(v_machine_rate, 0) * (coalesce(v_variant.print_time_min, 0) / 60.0);

    perform fn_create_calculation_version(
      'product_variant',
      v_variant.id,
      jsonb_build_object('filament_cost', v_filament_cost, 'machine_cost', v_machine_cost),
      20,
      'sonstiger_grund',
      'system'
    );
  end loop;
end $$;
