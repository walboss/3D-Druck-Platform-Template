-- Migration 00191: fn_customer_search nicht mehr direkt für anon
-- Siehe OFFENE-SECURITY-FIXES.md §5 (Entscheidung Betreiber 2026-09-24:
-- Variante (b)), specs/kunden-warenkorb-tracking.md §3.
--
-- fn_customer_search (00141) verrät per true/false, ob eine Telefonnummer
-- oder E-Mail zu einem Kunden gehört. Bisher war sie für anon ohne
-- Bot-Schutz direkt über PostgREST aufrufbar, also massenhaft durchprobierbar.
-- Ab jetzt nur noch über den API-Worker (POST /api/kundensuche, Rate-Limit
-- pro IP + Turnstile), der mit service_role aufruft. Die Funktion selbst
-- bleibt unverändert.
--
-- Rollback: grant execute on function fn_customer_search(text, text)
--           to anon, authenticated;

revoke execute on function fn_customer_search(text, text) from anon, authenticated;
grant execute on function fn_customer_search(text, text) to service_role;
