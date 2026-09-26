-- Migration 00161: Funktionen für MakerWorld-Import und Modellvorschläge
-- (fn_submit_product_suggestion, fn_import_makerworld_product,
-- fn_reject_product_suggestion), Grants und RLS-Policies für
-- product_suggestions.
-- Siehe specs/27-makerworld-import-vorschlaege.md §3 (Regeln), §5
-- (Funktionen), §2 (Variante, Aktiv-Status, Duplikat-Schutz).
--
-- Konventionen wie in 00144/00154: SECURITY DEFINER + search_path = public,
-- Fehler mit errcode, Audit über fn_write_audit(entity_type, entity_id,
-- action, field, old, new, reason, actor). Admin-Funktionen nehmen wie
-- fn_reject_custom_request einen p_actor (Audit) und — analog zu
-- p_handed_over_by in 00144 — einen optionalen p_admin_id für decided_by.
-- p_admin_id ist optional (NULL erlaubt, Spec 27 §3: decided_by nullable),
-- weil die admins-Tabelle in der Startphase leer sein kann.

-- ===========================================================================
-- ABSCHNITT A: fn_submit_product_suggestion — Kunde ohne Login (via Worker)
-- ===========================================================================
-- Spec 27 §3/§4. Rückgabe ist der Status für die Kundenantwort:
--   'angelegt'              → neuer offener Vorschlag
--   'bereits_vorgeschlagen' → offener Vorschlag zur ID existiert (kein Insert,
--                             kein Fehler — Kunde sieht trotzdem "Danke")
--   'bereits_im_katalog'    → Produkt mit dieser Modell-ID existiert
-- Nur service_role (Worker mit SUPABASE_SERVICE_ROLE_KEY, nach Turnstile);
-- anon/authenticated bewusst ohne EXECUTE, damit der anonyme Pfad nur über
-- den Turnstile-geschützten Worker erreichbar ist.
create or replace function fn_submit_product_suggestion(
  p_makerworld_url      text,
  p_makerworld_model_id text,
  p_note                text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url      text := nullif(trim(p_makerworld_url), '');
  v_model_id text := nullif(trim(p_makerworld_model_id), '');
  v_note     text := nullif(trim(p_note), '');
  v_id       uuid;
begin
  if v_url is null then
    raise exception 'fn_submit_product_suggestion: makerworld_url darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_model_id is null or v_model_id !~ '^[0-9]+$' then
    raise exception 'fn_submit_product_suggestion: makerworld_model_id muss numerisch sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'fn_submit_product_suggestion: note darf höchstens 500 Zeichen haben'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Bereits im Katalog (aktiv oder inaktiv — beides zählt, Spec 27 §3).
  if exists (select 1 from products p where p.makerworld_model_id = v_model_id) then
    return 'bereits_im_katalog';
  end if;

  -- Offener Vorschlag vorhanden: still ignorieren.
  if exists (
    select 1 from product_suggestions ps
    where ps.makerworld_model_id = v_model_id and ps.status = 'neu'
  ) then
    return 'bereits_vorgeschlagen';
  end if;

  insert into product_suggestions (makerworld_url, makerworld_model_id, note)
  values (v_url, v_model_id, v_note)
  returning id into v_id;

  return 'angelegt';
exception
  -- Rennen zweier gleichzeitiger Einreichungen: der Partial-Unique-Index
  -- uq_product_suggestions_open_model_id fängt es ab — gleiche Antwort wie
  -- beim regulären Duplikat.
  when unique_violation then
    return 'bereits_vorgeschlagen';
end;
$$;

revoke all on function fn_submit_product_suggestion(text, text, text) from public;
revoke all on function fn_submit_product_suggestion(text, text, text) from anon;
revoke all on function fn_submit_product_suggestion(text, text, text) from authenticated;
grant execute on function fn_submit_product_suggestion(text, text, text) to service_role;

-- ===========================================================================
-- ABSCHNITT B: fn_import_makerworld_product — Admin legt Produkt + Variante an
-- ===========================================================================
-- Spec 27 §2/§5:
--   * Produkt: name = p_name (übersetzter/editierter Titel), makerworld_title
--     = p_original_title, images = p_images (jsonb-Array von {url,
--     source_type}), tags, category, active = false, makerworld_model_id/-url.
--   * Genau eine Variante 'Standard': weight_g/print_time_min aus MakerWorld
--     (0 wenn NULL), work_time_min = 0, material_need_g = weight_g,
--     min 1 / max 10 / step 1, active = true. Keine Kalkulation.
--   * Duplikat: existiert makerworld_model_id bereits, wird nichts angelegt
--     und die bestehende product_id zurückgegeben (kein Fehler).
--   * p_suggestion_id gesetzt: Vorschlag → 'importiert' mit product_id.
--     Auch beim Duplikat-Fall wird der Vorschlag auf das bestehende Produkt
--     gesetzt, damit er nicht offen bleibt.
create or replace function fn_import_makerworld_product(
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
  p_admin_id       uuid default null
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

  -- 2. images-Format prüfen (datenmodell-v1.md: [{url, source_type}]) ------------
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

  -- 3. Vorschlag (falls angegeben) sperren und prüfen -----------------------------
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
    -- 5. Produkt anlegen (inaktiv, Spec 27 §2) -------------------------------------
    insert into products (
      name, description, category, images, tags, active, is_multicolor,
      makerworld_model_id, makerworld_url, makerworld_title
    )
    values (
      v_name, null, v_category, v_images, v_tags, false, false,
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

  -- 7. Vorschlag abschließen ---------------------------------------------------------
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

revoke all on function fn_import_makerworld_product(text, text, text, text, jsonb, text[], text, numeric, numeric, text, uuid, uuid) from public;
revoke all on function fn_import_makerworld_product(text, text, text, text, jsonb, text[], text, numeric, numeric, text, uuid, uuid) from anon;
grant execute on function fn_import_makerworld_product(text, text, text, text, jsonb, text[], text, numeric, numeric, text, uuid, uuid) to authenticated;

-- ===========================================================================
-- ABSCHNITT C: fn_reject_product_suggestion — Admin lehnt ab
-- ===========================================================================
-- Spec 27 §5. Nur aus 'neu'. Grund optional (kein Kundenkontakt, nichts zu
-- begründen), landet nur im Audit.
create or replace function fn_reject_product_suggestion(
  p_id       uuid,
  p_actor    text,
  p_reason   text default null,
  p_admin_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status product_suggestion_status;
begin
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_reject_product_suggestion: actor darf nicht leer sein'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_admin_id is not null and not exists (select 1 from admins a where a.id = p_admin_id) then
    raise exception 'fn_reject_product_suggestion: Admin % existiert nicht', p_admin_id
      using errcode = 'invalid_parameter_value';
  end if;

  select ps.status into v_status
  from product_suggestions ps
  where ps.id = p_id
  for update;

  if not found then
    raise exception 'fn_reject_product_suggestion: Vorschlag % existiert nicht', p_id
      using errcode = 'invalid_parameter_value';
  end if;
  if v_status <> 'neu' then
    raise exception 'fn_reject_product_suggestion: Vorschlag % hat Status % — Ablehnung nur aus ''neu''',
      p_id, v_status
      using errcode = 'check_violation';
  end if;

  update product_suggestions
  set status     = 'abgelehnt',
      decided_at = now(),
      decided_by = p_admin_id
  where id = p_id;

  perform fn_write_audit('product_suggestion', p_id, 'status_change', 'status',
                         'neu', 'abgelehnt', nullif(trim(p_reason), ''), p_actor);
end;
$$;

revoke all on function fn_reject_product_suggestion(uuid, text, text, uuid) from public;
revoke all on function fn_reject_product_suggestion(uuid, text, text, uuid) from anon;
grant execute on function fn_reject_product_suggestion(uuid, text, text, uuid) to authenticated;

-- ===========================================================================
-- ABSCHNITT D: Grants und RLS für product_suggestions
-- ===========================================================================
-- Admin (authenticated) liest die Liste direkt (Spec 27 §6); Schreibzugriffe
-- laufen ausschließlich über die Funktionen oben (SECURITY DEFINER), daher
-- nur SELECT. anon bekommt nichts — Einreichung nur über den Worker
-- (service_role, bypasst RLS).
grant select on product_suggestions to authenticated;

create policy admin_select_product_suggestions on product_suggestions
  for select to authenticated
  using (true);
