-- Migration 00168: fn_import_makerworld_product bekommt p_active-Parameter
-- fuer den Massenimport (specs/massenimport-makerworld-kollektion.md §3.4:
-- Massenimport-Produkte sofort aktiv, im Unterschied zum bisherigen
-- Vorschlaege-Review-Import aus Spec 27, der weiterhin inaktiv anlegt).
--
-- Frontend (admin-makerworld-import.ts) entscheidet je Aufruf: Kategorie
-- global/CSV gesetzt -> p_active=true (Massenimport), sonst p_active
-- weggelassen/false -> unveraendertes Verhalten aus Migration 00161.
--
-- DROP + CREATE statt CREATE OR REPLACE: ein zusaetzliches Pflicht- oder
-- Default-Argument aendert die Funktionssignatur (Anzahl/Typen der
-- Parameter); CREATE OR REPLACE wuerde sonst eine zweite, ueberladene
-- Funktion anlegen statt die bestehende zu ersetzen (PostgREST koennte dann
-- bei Aufrufen ohne p_active nicht mehr eindeutig entscheiden, welche der
-- beiden Funktionen gemeint ist).
drop function if exists fn_import_makerworld_product(
  text, text, text, text, jsonb, text[], text, numeric, numeric, text, uuid, uuid
);

create function fn_import_makerworld_product(
  p_model_id       text,
  p_url            text,
  p_original_title text,
  p_name           text,
  p_images         jsonb,
  p_tags           text[],
  p_category       text,
  p_weight_g       numeric,
  p_print_time_min numeric,
  p_actor          text,
  p_suggestion_id  uuid default null,
  p_admin_id       uuid default null,
  p_active         boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_model_id   text    := nullif(trim(p_model_id), '');
  v_url        text    := nullif(trim(p_url), '');
  v_name       text    := nullif(trim(p_name), '');
  v_orig_title text    := nullif(trim(p_original_title), '');
  v_category   text    := nullif(trim(p_category), '');
  v_images     jsonb   := coalesce(p_images, '[]'::jsonb);
  v_tags       text[]  := coalesce(p_tags, '{}'::text[]);
  v_weight     numeric := greatest(coalesce(p_weight_g, 0), 0);
  v_print_min  numeric := greatest(coalesce(p_print_time_min, 0), 0);
  v_active     boolean := coalesce(p_active, false);
  v_now        timestamptz := now();
  v_product_id uuid;
  v_variant_id uuid;
  v_img        jsonb;
  v_sugg_status product_suggestion_status;
  v_existing   boolean := false;
begin
  -- 1. Pflichtfelder ----------------------------------------------------------
  if v_model_id is null or v_model_id !~ '^[0-9]+$' then
    raise exception 'fn_import_makerworld_product: model_id muss numerisch sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_url is null then
    raise exception 'fn_import_makerworld_product: url darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_name is null then
    raise exception 'fn_import_makerworld_product: name darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_import_makerworld_product: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_admin_id is not null and not exists (select 1 from admins a where a.id = p_admin_id) then
    raise exception 'fn_import_makerworld_product: Admin % existiert nicht', p_admin_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. images-Format pruefen (datenmodell-v1.md: [{url, source_type}]) ------------
  if jsonb_typeof(v_images) <> 'array' then
    raise exception 'fn_import_makerworld_product: images muss ein JSON-Array sein'
      using errcode = 'invalid_parameter_value';
  end if;
  for v_img in select * from jsonb_array_elements(v_images) loop
    if jsonb_typeof(v_img) <> 'object'
       or nullif(trim(v_img->>'url'), '') is null
       or (v_img->>'source_type') not in ('extern_link', 'eigenes_hosting') then
      raise exception 'fn_import_makerworld_product: jedes Bild braucht url und source_type (extern_link | eigenes_hosting)'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  -- 3. Vorschlag (falls angegeben) sperren und pruefen -----------------------------
  if p_suggestion_id is not null then
    select ps.status into v_sugg_status
    from product_suggestions ps
    where ps.id = p_suggestion_id
    for update;

    if not found then
      raise exception 'fn_import_makerworld_product: Vorschlag % existiert nicht', p_suggestion_id
        using errcode = 'invalid_parameter_value';
    end if;
    if v_sugg_status <> 'neu' then
      raise exception 'fn_import_makerworld_product: Vorschlag % hat Status % — Import nur aus ''neu''',
        p_suggestion_id, v_sugg_status
        using errcode = 'check_violation';
    end if;
  end if;

  -- 4. Duplikat-Schutz (Spec 27 §2) ------------------------------------------------
  select p.id into v_product_id
  from products p
  where p.makerworld_model_id = v_model_id;

  if found then
    v_existing := true;
  else
    -- 5. Produkt anlegen (aktiv nur bei Massenimport, Spec massenimport §3.4 —
    -- sonst inaktiv wie bisher, Spec 27 §2) ------------------------------------
    insert into products (
      name, description, category, images, tags, active, is_multicolor,
      makerworld_model_id, makerworld_url, makerworld_title
    )
    values (
      v_name, null, v_category, v_images, v_tags, v_active, false,
      v_model_id, v_url, v_orig_title
    )
    returning id into v_product_id;

    -- 6. Standard-Variante (Spec 27 §2) --------------------------------------------
    insert into product_variants (
      product_id, size_label, weight_g, print_time_min, work_time_min,
      material_need_g, min_qty, max_qty, step_qty, active
    )
    values (
      v_product_id, 'Standard', v_weight, v_print_min, 0,
      v_weight, 1, 10, 1, true
    )
    returning id into v_variant_id;

    perform fn_write_audit('product', v_product_id, 'create', null,
                           null, v_name, 'MakerWorld-Import ' || v_model_id, p_actor);
    perform fn_write_audit('product_variant', v_variant_id, 'create', null,
                           null, 'Standard', 'MakerWorld-Import ' || v_model_id, p_actor);
  end if;

  -- 7. Vorschlag abschliessen ---------------------------------------------------------
  if p_suggestion_id is not null then
    update product_suggestions
    set status     = 'importiert',
        product_id = v_product_id,
        decided_at = v_now,
        decided_by = p_admin_id
    where id = p_suggestion_id;

    perform fn_write_audit('product_suggestion', p_suggestion_id, 'status_change', 'status',
                           'neu', 'importiert',
                           case when v_existing then 'Produkt bereits vorhanden' else 'importiert' end,
                           p_actor);
  end if;

  return v_product_id;
end;
$$;

revoke all on function fn_import_makerworld_product(text, text, text, text, jsonb, text[], text, numeric, numeric, text, uuid, uuid, boolean) from public;
revoke all on function fn_import_makerworld_product(text, text, text, text, jsonb, text[], text, numeric, numeric, text, uuid, uuid, boolean) from anon;
grant execute on function fn_import_makerworld_product(text, text, text, text, jsonb, text[], text, numeric, numeric, text, uuid, uuid, boolean) to authenticated;
