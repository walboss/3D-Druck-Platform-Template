import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CurrencyPipe, Location } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { GalleriaModule } from 'primeng/galleria';
import { InputNumberModule } from 'primeng/inputnumber';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';

import { CatalogService } from '../../../core/services/catalog.service';
import { CartService } from '../../../core/services/cart.service';
import { CatalogProduct, ProductPart, VCatalogRow } from '../../../core/models/db-types';
import { CatalogStateService } from '../../../core/services/catalog-state.service';
import { PricingService } from '../../../core/services/pricing.service';
import { LikesService } from '../../../core/services/likes.service';
import { StockFinish, StockOptionsService } from '../../../core/services/stock-options.service';
import { SimilarProducts } from './similar-products';

@Component({
  selector: 'app-product-detail',
  standalone: true,
  imports: [
    CurrencyPipe,
    FormsModule,
    RouterLink,
    ButtonModule,
    GalleriaModule,
    InputNumberModule,
    MessageModule,
    SkeletonModule,
    SimilarProducts,
  ],
  templateUrl: './product-detail.html',
  styleUrl: './product-detail.scss',
})
export class ProductDetail implements OnInit {
  private readonly pricing = inject(PricingService);
  private readonly stockOptions = inject(StockOptionsService);
  private readonly catalogState = inject(CatalogStateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly titleService = inject(Title);

  // "Ähnliche Produkte": bis zu 4 aus derselben Kategorie (Entscheidung
  // 2026-09-24), neueste zuerst.
  readonly similarProducts = signal<CatalogProduct[]>([]);
  readonly showPrices = this.pricing.showPrices;
  readonly shopEnabled = this.pricing.shopEnabled;
  readonly customRequestEnabled = this.pricing.customRequestEnabled;
  readonly listLabel = this.pricing.listLabel;
  readonly addToListLabel = this.pricing.addToListLabel;
  readonly goToListLabel = this.pricing.goToListLabel;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly adding = signal(false);

  readonly product = signal<CatalogProduct | null>(null);
  readonly parts = signal<ProductPart[]>([]);
  readonly isMulticolor = signal(false);
  readonly galleryIndex = signal(0);
  private touchStartX: number | null = null;

  readonly selectedVariantId = signal<string | null>(null);
  readonly qty = signal(1);

  // partId -> colorId ('' key used for single-color / whole product)
  readonly selectedColorByPart = signal<Record<string, string>>({});
  readonly selectedFinishByPart = signal<Record<string, string>>({});

  readonly selectedVariant = computed<VCatalogRow | null>(() => {
    const id = this.selectedVariantId();
    return this.product()?.variants.find((v) => v.variant_id === id) ?? null;
  });

  // Nur Farben/Finishes mit aktuellem Filament-Bestand (fn_get_public_stock_options,
  // Migration 00171) -- global für jedes Produkt gleich, kein
  // per-Produkt-Freigabeschritt mehr (Entscheidung 2026-09-20).
  readonly availableColors = this.stockOptions.colors;

  readonly colorPickKeys = computed<{ key: string; label: string }[]>(() => {
    if (this.isMulticolor()) {
      return this.parts().map((p) => ({ key: p.id, label: p.name }));
    }
    return [{ key: 'whole', label: '' }];
  });

  readonly canAddToCart = computed(() => {
    if (!this.selectedVariant()) return false;
    const colorByPart = this.selectedColorByPart();
    const finishByPart = this.selectedFinishByPart();
    return this.colorPickKeys().every((k) => colorByPart[k.key] && finishByPart[k.key]);
  });

  // Hinweis unter dem gesperrten "Hinzufügen"-Button: was noch fehlt.
  readonly missingSelectionHint = computed<string | null>(() => {
    if (!this.selectedVariant() || this.canAddToCart()) return null;
    return this.isMulticolor() ? 'Bitte für alle Teile Farbe und Finish wählen.' : 'Bitte Farbe und Finish wählen.';
  });

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly catalogService: CatalogService,
    private readonly cartService: CartService,
    private readonly likesService: LikesService,
    private readonly messageService: MessageService,
    private readonly location: Location,
  ) {}

  ngOnInit(): void {
    // Tab-Titel = Produktname (passt zur Link-Vorschau des Workers), beim
    // Verlassen wieder "Mein 3D-Druck".
    this.destroyRef.onDestroy(() => this.titleService.setTitle('Mein 3D-Druck'));
    // paramMap statt snapshot: Klick auf ein ähnliches Produkt bleibt in
    // derselben Komponente, nur die ID wechselt.
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('id');
      if (id) {
        this.selectedColorByPart.set({});
        this.selectedFinishByPart.set({});
        this.similarProducts.set([]);
        this.load(id);
      }
    });
  }

  async load(productId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [detail] = await Promise.all([
        this.catalogService.getProductDetail(productId),
        this.stockOptions.load(),
      ]);
      this.product.set(detail.product);
      this.titleService.setTitle(`${detail.product.name} – Mein 3D-Druck`);
      this.parts.set(detail.parts);
      this.isMulticolor.set(detail.isMulticolor);
      this.galleryIndex.set(0);

      if (detail.product.variants.length > 0) {
        this.selectedVariantId.set(detail.product.variants[0].variant_id);
        this.qty.set(detail.product.variants[0].min_qty);
      }
    } catch {
      this.error.set('Produkt konnte nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
    void this.loadLike(productId);
    void this.loadSimilar(productId);
  }

  private async loadSimilar(productId: string): Promise<void> {
    const key = this.product()?.category?.trim().toLowerCase();
    if (!key) return;
    try {
      const all = this.catalogState.cachedProducts ?? (await this.catalogService.getCatalog());
      if (this.product()?.product_id !== productId) return; // inzwischen weiternavigiert
      this.similarProducts.set(
        all
          .filter((p) => p.product_id !== productId && p.category?.trim().toLowerCase() === key)
          .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
          .slice(0, 4),
      );
    } catch {
      // still -- Bereich bleibt ausgeblendet.
    }
  }

  openSimilar(product: CatalogProduct): void {
    this.router.navigate(['/produkt', product.product_id]);
  }

  private async loadLike(productId: string): Promise<void> {
    try {
      const [counts, likedIds] = await Promise.all([this.likesService.getCounts(), this.likesService.getMyLikedIds()]);
      const product = this.product();
      if (!product) return;
      product.likesCount = counts.get(productId) ?? 0;
      product.likedByMe = likedIds.has(productId);
      this.product.set({ ...product });
    } catch {
      // still -- Herz-Icon bleibt bei 0/ungeliked.
    }
  }

  async toggleLike(): Promise<void> {
    const product = this.product();
    if (!product) return;
    const prevLiked = product.likedByMe;
    const prevCount = product.likesCount;
    this.product.set({ ...product, likedByMe: !prevLiked, likesCount: prevCount + (prevLiked ? -1 : 1) });
    try {
      const result = await this.likesService.toggle(product.product_id);
      const current = this.product();
      if (current) this.product.set({ ...current, likedByMe: result.liked, likesCount: result.likesCount });
    } catch {
      const current = this.product();
      if (current) this.product.set({ ...current, likedByMe: prevLiked, likesCount: prevCount });
    }
  }

  colorName(colorId: string | undefined): string | null {
    if (!colorId) return null;
    return this.availableColors().find((c) => c.id === colorId)?.name ?? null;
  }

  finishesForColor(colorId: string | undefined): StockFinish[] {
    if (!colorId) return [];
    return this.stockOptions.finishesForColor(colorId);
  }

  onSelectColor(partKey: string, colorId: string): void {
    this.selectedColorByPart.update((m) => ({ ...m, [partKey]: colorId }));
    const validFinishes = this.finishesForColor(colorId);
    this.selectedFinishByPart.update((m) => ({
      ...m,
      [partKey]: validFinishes.length === 1 ? validFinishes[0].id : '',
    }));
  }

  onSelectFinish(partKey: string, finishId: string): void {
    this.selectedFinishByPart.update((m) => ({ ...m, [partKey]: finishId }));
  }

  onSelectVariant(variantId: string): void {
    this.selectedVariantId.set(variantId);
    const variant = this.product()?.variants.find((v) => v.variant_id === variantId);
    if (variant) {
      this.qty.set(variant.min_qty);
    }
  }

  async addToCart(): Promise<void> {
    const variant = this.selectedVariant();
    const product = this.product();
    if (!variant || !product || !this.canAddToCart()) return;

    this.adding.set(true);
    try {
      const colorByPart = this.selectedColorByPart();
      const finishByPart = this.selectedFinishByPart();

      const configurationDraft = this.isMulticolor()
        ? this.parts().map((p) => ({
            product_part_id: p.id,
            color_id: colorByPart[p.id],
            finish_id: finishByPart[p.id],
          }))
        : [
            {
              product_part_id: null,
              color_id: colorByPart['whole'],
              finish_id: finishByPart['whole'],
            },
          ];

      await this.cartService.addItem(product.product_id, variant.variant_id, configurationDraft, this.qty());
      this.messageService.add({ severity: 'success', summary: `Zur ${this.listLabel()} hinzugefügt` });
    } catch {
      this.messageService.add({ severity: 'error', summary: 'Hinzufügen fehlgeschlagen' });
    } finally {
      this.adding.set(false);
    }
  }

  goToCart(): void {
    this.router.navigate([this.pricing.listPath()]);
  }

  // Klick auf die Kategorie: Katalog mit genau diesem Filter öffnen.
  openCategory(category: string): void {
    this.catalogState.resetFilters();
    this.catalogState.selectedCategories.set([category.trim().toLowerCase()]);
    this.catalogState.scrollY = 0;
    this.router.navigate(['/katalog']);
  }

  goBack(): void {
    this.location.back();
  }

  // p-galleria (PrimeNG 22) hat keinen Touch-Swipe auf dem Hauptbild mehr eingebaut
  // (nur die Thumbnail-Leiste reagiert auf touchmove) -- daher hier manuell per
  // touchstart/touchend erkannt und activeIndex entsprechend gesetzt.
  onGalleryTouchStart(event: TouchEvent): void {
    this.touchStartX = event.changedTouches[0]?.clientX ?? null;
  }

  onGalleryTouchEnd(event: TouchEvent): void {
    const startX = this.touchStartX;
    this.touchStartX = null;
    if (startX === null) return;

    const endX = event.changedTouches[0]?.clientX ?? startX;
    const deltaX = endX - startX;
    const swipeThresholdPx = 40;
    const imageCount = this.product()?.images.length ?? 0;
    if (imageCount < 2 || Math.abs(deltaX) < swipeThresholdPx) return;

    const current = this.galleryIndex();
    this.galleryIndex.set(deltaX < 0 ? (current + 1) % imageCount : (current - 1 + imageCount) % imageCount);
  }
}
