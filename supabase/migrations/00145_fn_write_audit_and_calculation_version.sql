-- Migration 00145: RPC-Funktionen Teil 5a
-- (fn_write_audit, fn_create_calculation_version)
-- Siehe specs/audit-settings.md §2 (audit_log) und §3 (Prinzip #31),
-- specs/kalkulation.md §2 (calculation_versions) und §3 (Versionierung #8,
-- kopierte Kostenwerte #9, .49-/.99-Aufrundung #29).
--
-- Befund zu 00141–00144: audit_log wird dort bereits inline per direktem
-- INSERT geschrieben (00141 bewusst ohne — kein Statuswechsel). Kein Retrofit
-- in dieser Migration; fn_write_audit ist spaltengleich zu den Inline-Inserts.
-- Keine Angebots-Funktionen (Teil 5b), keine RLS-Policies (Migration 0015).

-- ---------------------------------------------------------------------------
-- fn_write_audit(entity_type, entity_id, action, field_name, old_value,
--                new_value, reason, actor) → uuid
-- ---------------------------------------------------------------------------
-- Reiner INSERT in audit_log (audit-settings.md §2: append-only, nie
-- überschrieben oder gelöscht). Liefert die id des neuen Eintrags.
create or replace function fn_write_audit(
  p_entity_type text,
  p_entity_id   uuid,
  p_action      text,
  p_field_name  text,
  p_old_value   text,
  p_new_value   text,
  p_reason      text,
  p_actor       text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if nullif(trim(p_entity_type), '') is null then
    raise exception 'fn_write_audit: entity_type darf nicht leer sein';
  end if;
  if p_entity_id is null then
    raise exception 'fn_write_audit: entity_id darf nicht NULL sein';
  end if;
  if nullif(trim(p_action), '') is null then
    raise exception 'fn_write_audit: action darf nicht leer sein';
  end if;
  if nullif(trim(p_actor), '') is null then
    raise exception 'fn_write_audit: actor darf nicht leer sein';
  end if;

  insert into audit_log (entity_type, entity_id, action, field_name, old_value, new_value, reason, actor)
  values (p_entity_type, p_entity_id, p_action, p_field_name, p_old_value, p_new_value, p_reason, p_actor)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function fn_write_audit(text, uuid, text, text, text, text, text, text) from public;
revoke all on function fn_write_audit(text, uuid, text, text, text, text, text, text) from anon;
grant execute on function fn_write_audit(text, uuid, text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_round_up_to_49_99(p_value) → numeric
-- ---------------------------------------------------------------------------
-- Hilfsfunktion (kalkulation.md §3, #29): rundet auf den nächsthöheren
-- .49- oder .99-Endpreis auf, nie ab. Kleinster Wert >= p_value mit
-- Nachkommateil .49 oder .99:
--   10.00 → 10.49 | 12.49 → 12.49 | 12.50 → 12.99 | 12.995 → 13.49
create or replace function fn_round_up_to_49_99(p_value numeric)
returns numeric
language plpgsql
immutable
set search_path = public
as $$
declare
  v_base numeric := floor(p_value);
  v_frac numeric := p_value - floor(p_value);
begin
  if p_value is null then
    raise exception 'fn_round_up_to_49_99: Wert darf nicht NULL sein';
  end if;

  if v_frac <= 0.49 then
    return v_base + 0.49;
  elsif v_frac <= 0.99 then
    return v_base + 0.99;
  else
    return v_base + 1.49;
  end if;
end;
$$;

revoke all on function fn_round_up_to_49_99(numeric) from public;
revoke all on function fn_round_up_to_49_99(numeric) from anon;
grant execute on function fn_round_up_to_49_99(numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_create_calculation_version(scope_type, scope_id, cost_components,
--                               margin_percent, reason, created_by) → uuid
-- ---------------------------------------------------------------------------
-- p_cost_components: JSON-Objekt mit den Schlüsseln
--   filament_cost, energy_cost, machine_cost, labor_cost, packaging_cost,
--   license_cost, scrap_allowance, other_cost
-- Fehlender Schlüssel → 0. Unbekannter Schlüssel (z. B. Tippfehler) → dieselbe
-- Exception wie bei Nicht-Objekt, damit keine Kostenkomponente stillschweigend
-- als 0 verschluckt wird. Die Werte werden als Kopien gespeichert
-- (kalkulation.md §3, #9: keine Live-Referenzen auf aktuelle Preise).
--
-- Berechnung (Komponenten, total_cost, min_price kaufmännisch auf 2 Stellen;
-- nur calculated_price bekommt die .49/.99-Rundung):
--   Komponente       = round(Wert, 2)
--   total_cost       = Summe der gerundeten Komponenten
--   min_price        = round(total_cost * (1 + margin_percent / 100), 2)
--   calculated_price = min_price aufgerundet auf .49/.99 (#29, nie ab)
--   final_price      = calculated_price (keine manuelle Überschreibung hier)
--   version_no       = max(version_no) + 1 je (scope_type, scope_id), Start 1
--
-- is_current (kalkulation.md §2: nur für product_variant-Scope):
--   scope_type = 'product_variant' → bisherige is_current-Zeile derselben
--   scope_id wird auf false gesetzt (ausschließlich is_current + updated_at,
--   keine Kosten-/Preisfelder — beide Zeilen bleiben erhalten), neue Zeile true.
--   scope_type = 'offer_item' → is_current = false, keine Umschaltung.
--
-- Versionierung (#8): jede Version ist ein neuer INSERT; Kosten-/Preiswerte
-- bestehender Zeilen werden nie geändert.
--
-- Sperre je (scope_type, scope_id) per Advisory-Lock, damit version_no und
-- is_current bei parallelen Aufrufen konsistent bleiben; die Sperre hält
-- bis Commit/Rollback der aufrufenden Transaktion.
create or replace function fn_create_calculation_version(
  p_scope_type      calc_scope_type,
  p_scope_id        uuid,
  p_cost_components jsonb,
  p_margin_percent  numeric,
  p_reason          calc_reason,
  p_created_by      text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_filament   numeric;
  v_energy     numeric;
  v_machine    numeric;
  v_labor      numeric;
  v_packaging  numeric;
  v_license    numeric;
  v_scrap      numeric;
  v_other      numeric;
  v_total      numeric;
  v_min_price  numeric;
  v_calc_price numeric;
  v_version_no int;
  v_is_current boolean;
  v_now        timestamptz := now();
  v_id         uuid;
begin
  -- 1. Eingabe validieren -----------------------------------------------------
  if p_scope_type is null then
    raise exception 'fn_create_calculation_version: scope_type darf nicht NULL sein';
  end if;
  if p_scope_id is null then
    raise exception 'fn_create_calculation_version: scope_id darf nicht NULL sein';
  end if;
  -- Nicht-Objekt und unbekannter Schlüssel lösen dieselbe Exception aus
  -- (zwei getrennte Prüfungen, da jsonb_object_keys auf Nicht-Objekten
  -- selbst fehlschlägt und OR keine Kurzschlussauswertung garantiert).
  if p_cost_components is null or jsonb_typeof(p_cost_components) <> 'object' then
    raise exception 'fn_create_calculation_version: cost_components muss ein JSON-Objekt mit ausschließlich bekannten Schlüsseln sein (filament_cost, energy_cost, machine_cost, labor_cost, packaging_cost, license_cost, scrap_allowance, other_cost)';
  end if;
  if exists (
       select 1
       from jsonb_object_keys(p_cost_components) k
       where k not in ('filament_cost', 'energy_cost', 'machine_cost', 'labor_cost',
                       'packaging_cost', 'license_cost', 'scrap_allowance', 'other_cost')
     )
  then
    raise exception 'fn_create_calculation_version: cost_components muss ein JSON-Objekt mit ausschließlich bekannten Schlüsseln sein (filament_cost, energy_cost, machine_cost, labor_cost, packaging_cost, license_cost, scrap_allowance, other_cost)';
  end if;
  if p_margin_percent is null then
    raise exception 'fn_create_calculation_version: margin_percent darf nicht NULL sein';
  end if;
  if p_reason is null then
    raise exception 'fn_create_calculation_version: reason ist Pflicht (#27)';
  end if;
  if nullif(trim(p_created_by), '') is null then
    raise exception 'fn_create_calculation_version: created_by darf nicht leer sein';
  end if;

  -- 2. Kostenkomponenten kopieren (fehlender Schlüssel → 0, 2 Nachkommastellen)
  v_filament  := round(coalesce((p_cost_components ->> 'filament_cost')::numeric,   0), 2);
  v_energy    := round(coalesce((p_cost_components ->> 'energy_cost')::numeric,     0), 2);
  v_machine   := round(coalesce((p_cost_components ->> 'machine_cost')::numeric,    0), 2);
  v_labor     := round(coalesce((p_cost_components ->> 'labor_cost')::numeric,      0), 2);
  v_packaging := round(coalesce((p_cost_components ->> 'packaging_cost')::numeric,  0), 2);
  v_license   := round(coalesce((p_cost_components ->> 'license_cost')::numeric,    0), 2);
  v_scrap     := round(coalesce((p_cost_components ->> 'scrap_allowance')::numeric, 0), 2);
  v_other     := round(coalesce((p_cost_components ->> 'other_cost')::numeric,      0), 2);

  v_total := v_filament + v_energy + v_machine + v_labor
           + v_packaging + v_license + v_scrap + v_other;

  -- 3. Preis berechnen ----------------------------------------------------------
  v_min_price  := round(v_total * (1 + p_margin_percent / 100), 2);
  v_calc_price := fn_round_up_to_49_99(v_min_price);

  -- 4. Sperre je Scope, Versionsnummer, is_current ----------------------------
  perform pg_advisory_xact_lock(hashtext('calculation_versions:' || p_scope_type::text || ':' || p_scope_id::text));

  select coalesce(max(version_no), 0) + 1
  into v_version_no
  from calculation_versions
  where scope_type = p_scope_type
    and scope_id   = p_scope_id;

  if p_scope_type = 'product_variant' then
    -- kalkulation.md §2: is_current nur für product_variant-Scope.
    -- Nur das Flag der Vorgängerzeile wird umgeschaltet, sie bleibt erhalten.
    update calculation_versions
    set is_current = false,
        updated_at = v_now
    where scope_type = 'product_variant'
      and scope_id   = p_scope_id
      and is_current = true;

    v_is_current := true;
  else
    v_is_current := false;
  end if;

  -- 5. Neue Version anlegen (reiner INSERT, #8) --------------------------------
  insert into calculation_versions (
    scope_type, scope_id, version_no, reason,
    filament_cost, energy_cost, machine_cost, labor_cost,
    packaging_cost, license_cost, scrap_allowance, other_cost, total_cost,
    margin_percent, min_price, calculated_price, final_price,
    is_current, created_by, created_at, updated_at
  )
  values (
    p_scope_type, p_scope_id, v_version_no, p_reason,
    v_filament, v_energy, v_machine, v_labor,
    v_packaging, v_license, v_scrap, v_other, v_total,
    p_margin_percent, v_min_price, v_calc_price, v_calc_price,
    v_is_current, p_created_by, v_now, v_now
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function fn_create_calculation_version(calc_scope_type, uuid, jsonb, numeric, calc_reason, text) from public;
revoke all on function fn_create_calculation_version(calc_scope_type, uuid, jsonb, numeric, calc_reason, text) from anon;
grant execute on function fn_create_calculation_version(calc_scope_type, uuid, jsonb, numeric, calc_reason, text) to authenticated;
