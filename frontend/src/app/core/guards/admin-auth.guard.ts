import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SupabaseClientService } from '../services/supabase-client.service';
import { AuthService } from '../services/auth.service';

export const SECURITY_PATH = '/admin/sicherheit';

/**
 * Admin-Guard mit 2FA-Pflicht (Migration 00162 erzwingt aal2 serverseitig):
 * - keine Session            -> /admin/login
 * - Faktor vorhanden, aal1    -> /admin/login (TOTP-Schritt)
 * - kein Faktor eingerichtet  -> nur /admin/sicherheit erreichbar (Enrollment)
 */
export const adminAuthGuard: CanActivateFn = async (route, state) => {
  const supabase = inject(SupabaseClientService);
  const auth = inject(AuthService);
  const router = inject(Router);

  const { data } = await supabase.client.auth.getSession();
  if (!data.session) {
    // OAuth-Fehlerparameter (error, error_description) an die Login-Seite
    // durchreichen, sonst geht die Ursache eines fehlgeschlagenen
    // Google-Logins verloren.
    return router.createUrlTree(['/admin/login'], {
      queryParams: route.queryParams,
      fragment: route.fragment ?? undefined,
    });
  }

  const { currentLevel, nextLevel } = await auth.getAssuranceLevel();
  if (currentLevel === 'aal2') {
    return true;
  }

  if (nextLevel === 'aal2') {
    return router.createUrlTree(['/admin/login']);
  }

  if (state.url.startsWith(SECURITY_PATH)) {
    return true;
  }
  return router.createUrlTree([SECURITY_PATH]);
};
