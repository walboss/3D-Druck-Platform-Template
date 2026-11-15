import { Component, OnInit, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { ButtonModule } from 'primeng/button';

import { LikesService } from '../../../core/services/likes.service';
import { CatalogProduct } from '../../../core/models/db-types';
import { PricingService } from '../../../core/services/pricing.service';

// Spec like-system.md §5: eigener Nav-Punkt "Likes" (Route /likes), zeigt
// nur die vom aktuellen Visitor (Cookie) geliketen Produkte, gleiches
// Karten-Grid-Layout wie der Katalog, eigener Leerzustand.
import { SizedImage } from '../../../shared/sized-image/sized-image';
@Component({
  selector: 'app-likes-list',
  standalone: true,
  imports: [SizedImage, CurrencyPipe, RouterLink, SkeletonModule, MessageModule, ButtonModule],
  templateUrl: './likes-list.html',
  styleUrl: './likes-list.scss',
})
export class LikesList implements OnInit {
  readonly showPrices = inject(PricingService).showPrices;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly products = signal<CatalogProduct[]>([]);

  constructor(private readonly likesService: LikesService) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const products = await this.likesService.getLikedProducts();
      const counts = await this.likesService.getCounts(products.map((p) => p.product_id));
      for (const product of products) {
        product.likesCount = counts.get(product.product_id) ?? 0;
      }
      this.products.set(products);
    } catch {
      this.error.set('Likes konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  coverImage(product: CatalogProduct): string | null {
    return product.images?.[0]?.url ?? null;
  }

  async unlike(product: CatalogProduct, event: Event): Promise<void> {
    event.stopPropagation();
    event.preventDefault();
    try {
      await this.likesService.toggle(product.product_id);
      this.products.update((list) => list.filter((p) => p.product_id !== product.product_id));
    } catch {
      // still -- Karte bleibt stehen, naechster Reload zeigt korrekten Stand.
    }
  }
}
