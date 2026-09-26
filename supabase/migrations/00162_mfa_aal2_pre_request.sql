-- Migration 00162: 2FA (TOTP) für den Admin serverseitig erzwingen
-- Siehe specs/architektur-technologie-v1.md §4.5 ("2FA für den Admin-Account
-- wird über Supabase Auth aktiviert") und specs/audit-settings.md §admins.
--
-- Umsetzung über PostgREST `db_pre_request` statt über jede einzelne
-- admin_all_*-Policy aus Migration 00149: Die Funktion läuft vor jedem
-- REST-/RPC-Request und lehnt Requests der Rolle `authenticated` ab, deren
-- JWT nicht die Assurance-Stufe `aal2` (Passwort + TOTP) trägt. Damit sind
-- auch die SECURITY-DEFINER-Admin-Funktionen (fn_confirm_order, …) abgedeckt,
-- die RLS umgehen würden. anon (Shop) und service_role (Cron) bleiben
-- unberührt.
--
-- MFA-Enrollment/-Challenge/-Verify laufen über GoTrue (/auth/v1), nicht
-- über PostgREST — der Admin kann TOTP also auch mit aal1 einrichten.
--
-- Rollback: alter role authenticator reset pgrst.db_pre_request;
--           notify pgrst, 'reload config';

create or replace function public.fn_mfa_pre_request()
returns void
language plpgsql
stable
set search_path = public
as $$
declare
  v_claims jsonb;
begin
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  if v_claims is null then
    return;
  end if;

  if (v_claims ->> 'role') = 'authenticated'
     and coalesce(v_claims ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'MFA erforderlich: Sitzung hat nicht Assurance-Stufe aal2'
      using errcode = '42501', hint = 'mfa_required';
  end if;
end;
$$;

comment on function public.fn_mfa_pre_request() is
  'PostgREST db_pre_request: verlangt aal2 (TOTP) für Rolle authenticated (Admin).';

grant execute on function public.fn_mfa_pre_request() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'public.fn_mfa_pre_request';
notify pgrst, 'reload config';
