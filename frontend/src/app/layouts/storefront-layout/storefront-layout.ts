import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { CartService } from '../../core/services/cart.service';
import { ThemeService } from '../../core/theme/theme.service';
import { PricingService } from '../../core/services/pricing.service';
import { ScrollTopButton } from '../../shared/scroll-top/scroll-top-button';
import { LEGAL_PAGES_ENABLED } from '../../core/legal-pages';

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

  readonly cartCount = this.cart.itemCount;
  readonly theme = this.themeService.theme;
  readonly shopEnabled = this.pricing.shopEnabled;
  readonly customRequestEnabled = this.pricing.customRequestEnabled;
  readonly year = new Date().getFullYear();

  readonly listPath = this.pricing.listPath;
  readonly listLabel = this.pricing.listLabel;

  constructor() {
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
