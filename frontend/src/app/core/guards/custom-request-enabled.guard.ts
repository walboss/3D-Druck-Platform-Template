import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { PricingService } from '../services/pricing.service';

/**
 * Individualanfrage (freies Formular) ist nur erreichbar, wenn
 * settings.storefront_custom_request_enabled an ist. Sonst zurück zum Katalog.
 */
export const customRequestEnabledGuard: CanActivateFn = async () => {
  const pricing = inject(PricingService);
  const router = inject(Router);

  await pricing.load();
  return pricing.customRequestEnabled() ? true : router.createUrlTree(['/katalog']);
};
