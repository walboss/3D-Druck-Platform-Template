-- Migration 00198: MakerWorld-Import mit Druckplatten und Farbteilen
--
-- Wunsch/Entscheidungen Betreiber 2026-09-26: Beim MakerWorld-Import die
-- Druckplatten auslesen (MakerWorld-API instances[0].extention.modelInfo.plates,
-- je Platte Druckzeit, Gewicht, Bild, Filamente mit Gramm) und daraus
--   a) ein Produkt mit Farbteilen machen (z. B. Pilz: Platte 1 = Stiel,
--      Platte 2 = Kopf; Kürbis: Körper grün + Stiel orange auf einer Platte),
--      Teilnamen beim Import frei vergeben, gleicher Name = gleiches Teil, oder
--   b) je Platte ein eigenes Produkt (z. B. Flaschenkürbis / runder Kürbis),
--   c) wie bisher ein einfarbiges Produkt.
-- Eine Platte = 1 verkauftes Stück (Gewicht/Zeit der Platte gelten für 1 Stück).
--
-- 1. products.makerworld_plate_no: Platten-Nr. bei "je Platte ein Produkt",
--    sonst NULL. Duplikat-Schutz (00160) jetzt je (Modell-ID, Platte).
-- 2. fn_import_makerworld_product (Stand 00168) + p_plate_no, p_parts:
--    p_parts = [{name, weight_g, print_time_min}, …]; ab 2 Teilen wird das
--    Produkt mehrfarbig, je Teil product_parts + variant_parts (Gewicht,
--    Druckzeit, Materialbedarf). Variante "Standard" bekommt die Summen
--    (p_weight_g / p_print_time_min wie bisher). Ein Vorschlag darf für
--    mehrere Platten-Produkte desselben Modells verwendet werden.

-- ===========================================================================
-- 1. Platten-Nr. + Duplikat-Schutz je Platte
-- ===========================================================================
alter table products add column if not exists makerworld_plate_no int;

alter table products add constraint chk_products_makerworld_plate_no
  check (makerworld_plate_no is null or (makerworld_plate_no >= 1 and makerworld_model_id is not null));

comment on column products.makerworld_plate_no is
  'Nr. der MakerWorld-Druckplatte, wenn aus einem Modell je Platte ein eigenes Produkt importiert wurde (00198); sonst NULL.';

drop index if exists uq_products_makerworld_model_id;
create unique index uq_products_makerworld_model_plate
  on products (makerworld_model_id, coalesce(makerworld_plate_no, 0))
  where makerworld_model_id is not null;

-- ===========================================================================
-- 2. Import-Funktion mit Platte und Farbteilen
-- ===========================================================================
drop function fn_import_makerworld_product(text, text, text, text, jsonb, text[], text, numeric, numeric, text, uuid, uuid, boolean);

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
  p_active         boolean default false,
  p_plate_no       int     default null,
  p_parts          jsonb   default null
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
  v_plate_no   int     := p_plate_no;
  v_parts      jsonb   := coalesce(p_parts, '[]'::jsonb);
  v_part       jsonb;
  v_part_id    uuid;
  v_sort       int     := 0;
  v_multicolor boolean;
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
  -- 00198: Platte und Farbteile ---------------------------------------------
  if v_plate_no is not null and v_plate_no < 1 then
    raise exception 'fn_import_makerworld_product: plate_no muss >= 1 sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(v_parts) <> 'array' then
    raise exception 'fn_import_makerworld_product: parts muss ein JSON-Array sein'
      using errcode = 'invalid_parameter_value';
  end if;
  for v_part in select * from jsonb_array_elements(v_parts) loop
    if jsonb_typeof(v_part) <> 'object'
       or nullif(trim(v_part->>'name'), '') is null
       or coalesce((v_part->>'weight_g')::numeric, -1) < 0
       or coalesce((v_part->>'print_time_min')::numeric, -1) < 0 then
      raise exception 'fn_import_makerworld_product: jedes Teil braucht name, weight_g >= 0 und print_time_min >= 0'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  if (select count(distinct lower(trim(e->>'name'))) from jsonb_array_elements(v_parts) e)
     <> jsonb_array_length(v_parts) then
    raise exception 'fn_import_makerworld_product: Teilnamen müssen eindeutig sein'
      using errcode = 'invalid_parameter_value';
  end if;
  -- Ein einzelnes "Teil" ist kein Farbteil → einfarbig wie bisher.
  v_multicolor := jsonb_array_length(v_parts) >= 2;

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
    -- 00198: "Je Platte ein Produkt" importiert mehrere Produkte zu einem
    -- Vorschlag → ein bereits für dieses Modell importierter Vorschlag ist ok.
    if v_sugg_status = 'importiert'
       and exists (select 1 from product_suggestions ps
                   where ps.id = p_suggestion_id and ps.makerworld_model_id = v_model_id) then
      null;
    elsif v_sugg_status <> 'neu' then
      raise exception 'fn_import_makerworld_product: Vorschlag % hat Status % — Import nur aus ''neu''',
        p_suggestion_id, v_sugg_status
        using errcode = 'check_violation';
    end if;
  end if;

  -- 4. Duplikat-Schutz (Spec 27 §2) ------------------------------------------------
  select p.id into v_product_id
  from products p
  where p.makerworld_model_id = v_model_id
    and p.makerworld_plate_no is not distinct from v_plate_no;

  if found then
    v_existing := true;
  else
    -- 5. Produkt anlegen (aktiv nur bei Massenimport, Spec massenimport §3.4 —
    -- sonst inaktiv wie bisher, Spec 27 §2) ------------------------------------
    insert into products (
      name, description, category, images, tags, active, is_multicolor,
      makerworld_model_id, makerworld_url, makerworld_title, makerworld_plate_no
    )
    values (
      v_name, null, v_category, v_images, v_tags, v_active, v_multicolor,
      v_model_id, v_url, v_orig_title, v_plate_no
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

    -- 00198: Farbteile mit Gewicht/Druckzeit je Teil (variant_parts, genutzt
    -- u. a. von der automatischen Spulenwahl, 00182).
    if v_multicolor then
      for v_part in select * from jsonb_array_elements(v_parts) loop
        v_sort := v_sort + 1;
        insert into product_parts (product_id, name, sort_order)
        values (v_product_id, trim(v_part->>'name'), v_sort)
        returning id into v_part_id;

        insert into variant_parts (variant_id, product_part_id, weight_g, print_time_min, material_need_g)
        values (v_variant_id, v_part_id,
                (v_part->>'weight_g')::numeric,
                (v_part->>'print_time_min')::numeric,
                (v_part->>'weight_g')::numeric);
      end loop;
    end if;

    perform fn_write_audit('product', v_product_id, 'create', null,
                           null, v_name, 'MakerWorld-Import ' || v_model_id, p_actor);
    perform fn_write_audit('product_variant', v_variant_id, 'create', null,
                           null, 'Standard', 'MakerWorld-Import ' || v_model_id, p_actor);
  end if;

  -- 7. Vorschlag abschliessen ---------------------------------------------------------
  if p_suggestion_id is not null and v_sugg_status = 'neu' then
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

revoke all on function fn_import_makerworld_product(text, text, text, text, jsonb, text[], text, numeric, numeric, text, uuid, uuid, boolean, int, jsonb) from public;
revoke all on function fn_import_makerworld_product(text, text, text, text, jsonb, text[], text, numeric, numeric, text, uuid, uuid, boolean, int, jsonb) from anon;
grant execute on function fn_import_makerworld_product(text, text, text, text, jsonb, text[], text, numeric, numeric, text, uuid, uuid, boolean, int, jsonb) to authenticated;
