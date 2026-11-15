-- Migration 00202: MakerWorld-Modell neu einlesen
--
-- Entscheidung Betreiber 2026-11-14: Ein bereits importiertes Modell (z. B. mit
-- "Je Platte ein Produkt" falsch aufgeteilt) soll im MakerWorld-Import per
-- Knopf "Neu einlesen" erneut importiert werden koennen. Dazu werden die
-- bisherigen Produkte dieses Modells entfernt -- aber nur, wenn es keine
-- Bestellungen o. ae. dazu gibt; sonst nur deaktiviert.
--
-- fn_makerworld_reset_model(p_model_id, p_actor) je Produkt des Modells:
--   * Loeschen: Warenkorb-Eintraege, Likes, Farb/Finish-Optionen,
--     Lizenz-Links, Varianten mit Teilen/Konfigurationen und deren
--     Kalkulationsversionen (polymorph, ohne FK), Teile, Produkt.
--     Vorschlaege behalten ihren Eintrag (product_id -> NULL).
--   * Verweist noch etwas mit Geschichte auf Produkt/Variante/Konfiguration
--     (Bestellungen, Angebote, Sets, Lager-/Produktionsbuchungen ...), bricht
--     der Fremdschluessel das Loeschen ab: der Teilschritt wird
--     zurueckgerollt, das Produkt nur deaktiviert und von der Modell-ID
--     geloest (makerworld_model_id/_plate_no -> NULL, Link bleibt), damit der
--     Duplikat-Schutz (00198) den neuen Import nicht blockiert.
-- Rueckgabe: {"deleted": n, "deactivated": m}.
--
-- Rollback: drop function fn_makerworld_reset_model(text, text);

create function fn_makerworld_reset_model(
  p_model_id text,
  p_actor    text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_model_id    text := nullif(trim(p_model_id), '');
  v_product     record;
  v_variant_ids uuid[];
  v_config_ids  uuid[];
  v_deleted     int := 0;
  v_deactivated int := 0;
begin
  if not public.fn_is_admin() then
    raise exception 'fn_makerworld_reset_model: nur fuer Admins'
      using errcode = 'insufficient_privilege';
  end if;
  if v_model_id is null or v_model_id !~ '^[0-9]+$' then
    raise exception 'fn_makerworld_reset_model: model_id muss numerisch sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_makerworld_reset_model: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_product in
    select p.id, p.name, p.active from products p where p.makerworld_model_id = v_model_id
  loop
    begin
      select coalesce(array_agg(v.id), '{}') into v_variant_ids
      from product_variants v where v.product_id = v_product.id;
      select coalesce(array_agg(vc.id), '{}') into v_config_ids
      from variant_configurations vc where vc.variant_id = any (v_variant_ids);

      delete from cart_items where product_id = v_product.id or variant_id = any (v_variant_ids);
      delete from product_likes where product_id = v_product.id;
      update product_suggestions set product_id = null where product_id = v_product.id;
      delete from variant_configuration_colors where variant_configuration_id = any (v_config_ids);
      delete from variant_configurations where id = any (v_config_ids);
      delete from variant_parts where variant_id = any (v_variant_ids);
      delete from calculation_versions
      where scope_type = 'product_variant' and scope_id = any (v_variant_ids);
      delete from product_color_finish_options where product_id = v_product.id;
      delete from license_product_links where product_id = v_product.id;
      delete from product_variants where id = any (v_variant_ids);
      delete from product_parts where product_id = v_product.id;
      delete from products where id = v_product.id;

      perform fn_write_audit('product', v_product.id, 'delete', null,
                             v_product.name, null,
                             'MakerWorld-Modell ' || v_model_id || ' neu einlesen', p_actor);
      v_deleted := v_deleted + 1;
    exception when foreign_key_violation then
      update products
      set active = false,
          makerworld_model_id = null,
          makerworld_plate_no = null
      where id = v_product.id;

      perform fn_write_audit('product', v_product.id, 'update', 'active',
                             v_product.active::text, 'false',
                             'MakerWorld-Modell ' || v_model_id
                               || ' neu einlesen (hat Bestellungen o. ae., nur deaktiviert)', p_actor);
      v_deactivated := v_deactivated + 1;
    end;
  end loop;

  return jsonb_build_object('deleted', v_deleted, 'deactivated', v_deactivated);
end;
$$;

revoke all on function fn_makerworld_reset_model(text, text) from public;
revoke all on function fn_makerworld_reset_model(text, text) from anon;
grant execute on function fn_makerworld_reset_model(text, text) to authenticated;
