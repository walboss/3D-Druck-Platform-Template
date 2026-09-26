-- Migration 00192: fn_place_order und fn_submit_custom_request nur noch
-- über den API-Worker (Turnstile) aufrufbar.
--
-- Befund Security-Check 2026-09-25: Beide Funktionen hatten EXECUTE für anon.
-- Da der Anon-Key im Frontend-Bundle steckt, ließ sich Turnstile per
-- Direktaufruf von /rest/v1/rpc/... umgehen (Bestell-/Anfrage-Spam).
-- Gleiches Muster wie 00161 (fn_submit_product_suggestion) und 00191
-- (fn_customer_search): der Worker prüft Turnstile und ruft dann mit
-- service_role auf.
--
-- WICHTIG Reihenfolge: API-Worker (cloudflare-worker/, ruft ab jetzt mit
-- SUPABASE_SERVICE_ROLE_KEY auf) VOR dieser Migration deployen, sonst schlägt
-- der Checkout fehl.

revoke execute on function fn_place_order(uuid, jsonb) from anon;
grant execute on function fn_place_order(uuid, jsonb) to service_role;

revoke execute on function fn_submit_custom_request(jsonb, text, text, text, int, text, uuid, uuid, text, jsonb, numeric, integer) from anon;
grant execute on function fn_submit_custom_request(jsonb, text, text, text, int, text, uuid, uuid, text, jsonb, numeric, integer) to service_role;
