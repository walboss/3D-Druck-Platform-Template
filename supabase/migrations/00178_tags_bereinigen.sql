-- Migration 00178: Bestehende products.tags bereinigen
--
-- Befund aus dem vollstaendigen Funktionstest 2026-09-21: Der MakerWorld-
-- Import (Weg A/B, Worker-Funktion translateTagsEnDe + Frontend-Merge in
-- admin-makerworld-import.ts) konnte Tags mit HTML-Entities durchschleusen
-- (z. B. "&amp;#39;decor" statt "'decor", teils mehrfach kodiert) und
-- Duplikate nur case-sensitiv entfernen ("DECO" neben "deco"/"decor").
-- Diese Migration bereinigt einmalig die bestehenden Werte. Der Import-Code
-- selbst wurde separat im Frontend/Worker gefixt, damit neue Importe sauber
-- bleiben (kein Bezug zu dieser Migration, rein applikationsseitig).

create or replace function fn_tmp_decode_html_entities(p_text text)
returns text
language plpgsql
immutable
as $$
declare
  v_text text := p_text;
  v_prev text;
begin
  loop
    v_prev := v_text;
    v_text := replace(v_text, '&amp;', '&');
    v_text := replace(v_text, '&#39;', '''');
    v_text := replace(v_text, '&apos;', '''');
    v_text := replace(v_text, '&quot;', '"');
    v_text := replace(v_text, '&lt;', '<');
    v_text := replace(v_text, '&gt;', '>');
    exit when v_text = v_prev;
  end loop;
  return v_text;
end;
$$;

-- Je Produkt: Tags decodieren, trimmen, leere verwerfen, case-insensitiv
-- deduplizieren (erste Schreibweise je Kleinschreib-Variante gewinnt,
-- urspruengliche Reihenfolge bleibt erhalten).
with unnested as (
  select
    p.id as product_id,
    u.ord,
    trim(both from fn_tmp_decode_html_entities(u.tag)) as cleaned_tag
  from products p
  cross join lateral unnest(p.tags) with ordinality as u(tag, ord)
),
deduped as (
  select distinct on (product_id, lower(cleaned_tag))
    product_id, ord, cleaned_tag
  from unnested
  where cleaned_tag <> ''
  order by product_id, lower(cleaned_tag), ord
),
aggregated as (
  select product_id, array_agg(cleaned_tag order by ord) as new_tags
  from deduped
  group by product_id
)
-- Scalar Subquery statt FROM/JOIN, damit Produkte OHNE verbleibende Tags
-- (alle Tags waren nur Muell und wurden herausgefiltert) ebenfalls auf
-- '{}' gesetzt werden -- ein normaler JOIN wuerde diese Zeilen auslassen.
update products p
set tags = coalesce((select a.new_tags from aggregated a where a.product_id = p.id), '{}'::text[])
where p.tags is distinct from coalesce((select a.new_tags from aggregated a where a.product_id = p.id), '{}'::text[]);

drop function fn_tmp_decode_html_entities(text);
