import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { PricingService } from '../services/pricing.service';

/**
 * Wunschliste (Katalog-Auswahl + Kontaktformular) ist nur erreichbar, wenn
 * settings.storefront_shop_enabled an ist. Sonst zurück zum Katalog.
 */
export const shopEnabledGuard: CanActivateFn = async () => {
  const pricing = inject(PricingService);
  const router = inject(Router);

  await pricing.load();
  return pricing.shopEnabled() ? true : router.createUrlTree(['/katalog']);
};
