-- Migration 00159: anon-EXECUTE-Grant auf fn_reject_offer zurücknehmen
-- Siehe specs/18-storefront-anfrage-angebot-tracking.md §7 (korrigierte
-- Fassung): "Kein eigenständiges 'Ablehnen' auf Kundenseite —
-- fn_reject_offer ist bewusst Admin-only (Migration 00154)."
--
-- Migration 00156 hatte fn_reject_offer(uuid, text, text) versehentlich für
-- anon freigegeben (damaliger, seither korrigierter Spec-Stand). Diese
-- Migration nimmt genau diesen einen Grant zurück — Funktionskörper und der
-- authenticated-Grant aus 00154 bleiben unverändert.
revoke execute on function fn_reject_offer(uuid, text, text) from anon;
