import { Component, DestroyRef, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { CartService } from '../../core/services/cart.service';
import { ThemeService } from '../../core/theme/theme.service';
import { PricingService } from '../../core/services/pricing.service';
import { ScrollTopButton } from '../../shared/scroll-top/scroll-top-button';
import { LEGAL_PAGES_ENABLED } from '../../core/legal-pages';

// Wischgesten (nur Touch), jeweils vom Bildschirmrand nach innen:
//   rechter Rand -> Warenkorb-/Wunschlisten-Seite
//   linker Rand  -> Katalog
// Nicht, wenn die Berührung in einem Element startet, das selbst Eingaben
// oder Wischen braucht (Formularfelder, Dialoge, Produkt-Galerie).
const SWIPE_EDGE_PX = 28;
const SWIPE_MIN_DX_PX = 70;
const SWIPE_MAX_DY_PX = 60;
const SWIPE_MAX_MS = 700;
const SWIPE_BLOCK_SELECTOR =
  'input, textarea, select, [role="slider"], [contenteditable], [data-no-page-swipe], ' +
  'p-galleria, .gallery-image, .gallery-thumb, .p-dialog, .p-select-overlay, .p-datepicker';

interface StorefrontNavItem {
  label: string;
  shortLabel: string;
  path: string;
  icon: string;
}

@Component({
  selector: 'app-storefront-layout',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, ToastModule, ScrollTopButton],
  providers: [MessageService],
  templateUrl: './storefront-layout.html',
  styleUrl: './storefront-layout.scss',
})
export class StorefrontLayout {
  readonly legalPagesEnabled = LEGAL_PAGES_ENABLED;
  private readonly cart = inject(CartService);
  private readonly themeService = inject(ThemeService);
  private readonly pricing = inject(PricingService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private swipeStart: { x: number; y: number; t: number } | null = null;

  readonly cartCount = this.cart.itemCount;
  readonly theme = this.themeService.theme;
  readonly shopEnabled = this.pricing.shopEnabled;
  readonly customRequestEnabled = this.pricing.customRequestEnabled;
  readonly settingsLoadFailed = this.pricing.loadFailed;
  readonly year = new Date().getFullYear();

  readonly listPath = this.pricing.listPath;
  readonly listLabel = this.pricing.listLabel;

  constructor() {
    void this.init();
    this.initSwipeToList();
  }

  private initSwipeToList(): void {
    const onStart = (event: TouchEvent): void => {
      const touch = event.touches.length === 1 ? event.touches[0] : null;
      const blocked =
        !touch ||
        (event.target instanceof Element && event.target.closest(SWIPE_BLOCK_SELECTOR) !== null);
      const atEdge =
        !!touch && (touch.clientX <= SWIPE_EDGE_PX || touch.clientX >= window.innerWidth - SWIPE_EDGE_PX);
      this.swipeStart = !blocked && atEdge ? { x: touch.clientX, y: touch.clientY, t: Date.now() } : null;
    };
    const onEnd = (event: TouchEvent): void => {
      const start = this.swipeStart;
      this.swipeStart = null;
      const touch = event.changedTouches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < SWIPE_MIN_DX_PX || Math.abs(dy) > SWIPE_MAX_DY_PX || Math.abs(dx) < 2 * Math.abs(dy)) return;
      if (Date.now() - start.t > SWIPE_MAX_MS) return;
      const fromRightEdge = start.x >= window.innerWidth - SWIPE_EDGE_PX && dx < 0;
      const fromLeftEdge = start.x <= SWIPE_EDGE_PX && dx > 0;
      let target: string | null = null;
      if (fromRightEdge && this.shopEnabled()) target = this.listPath();
      else if (fromLeftEdge) target = '/katalog';
      if (!target || this.router.url.split(/[?#]/)[0] === target) return;
      void this.router.navigateByUrl(target);
    };
    const cancel = (): void => {
      this.swipeStart = null;
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', cancel, { passive: true });
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', cancel);
    });
  }

  retrySettings(): void {
    void this.init();
  }

  private async init(): Promise<void> {
    await this.pricing.load();
    if (this.pricing.shopEnabled()) {
      await this.cart.getCart().catch(() => undefined);
    }
  }

  toggleTheme(): void {
    this.themeService.toggle();
  }

  readonly navItems = computed<StorefrontNavItem[]>(() => {
    const items: StorefrontNavItem[] = [
      { label: 'Katalog', shortLabel: 'Katalog', path: '/katalog', icon: 'pi pi-th-large' },
      // Like-System (specs/like-system.md §5): unabhängig von Privatmodus-
      // Flags, immer sichtbar.
      { label: 'Likes', shortLabel: 'Likes', path: '/likes', icon: 'pi pi-heart' },
    ];
    if (this.customRequestEnabled()) {
      items.push({ label: 'Individualanfrage', shortLabel: 'Anfrage', path: '/individualanfrage', icon: 'pi pi-pencil' });
    }
    if (this.shopEnabled()) {
      items.push({
        label: this.listLabel(),
        shortLabel: this.listLabel(),
        path: this.listPath(),
        icon: 'pi pi-list',
      });
    }
    return items;
  });
}
