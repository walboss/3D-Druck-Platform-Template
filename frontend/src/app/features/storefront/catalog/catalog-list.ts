import { Component, ElementRef, Injector, OnDestroy, OnInit, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { InputTextModule } from 'primeng/inputtext';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';

import { CatalogService } from '../../../core/services/catalog.service';
import { CatalogProduct } from '../../../core/models/db-types';
import { PricingService } from '../../../core/services/pricing.service';
import { LikesService } from '../../../core/services/likes.service';
import { CategorySeason, currentSeasonCategories, currentSeasons } from '../../../core/utils/season.util';
import { SeasonBanner, SeasonBannerData } from './season-banner';
import { CategoryBar } from './category-bar';
import { CATALOG_PAGE_SIZE, CatalogSortOption, CatalogStateService } from '../../../core/services/catalog-state.service';

type SortOption = CatalogSortOption;

const PAGE_SIZE = CATALOG_PAGE_SIZE;

// "Neu"-Etikett für Produkte, die in den letzten 14 Tagen angelegt wurden.
const NEW_PRODUCT_DAYS = 14;

@Component({
  selector: 'app-catalog-list',
  standalone: true,
  imports: [
    RouterLink,
    CurrencyPipe,
    FormsModule,
    InputTextModule,
    MultiSelectModule,
    SelectModule,
    SkeletonModule,
    ButtonModule,
    MessageModule,
    SeasonBanner,
    CategoryBar,
  ],
  templateUrl: './catalog-list.html',
  styleUrl: './catalog-list.scss',
})
export class CatalogList implements OnInit, OnDestroy {
  private readonly pricing = inject(PricingService);
  readonly showPrices = this.pricing.showPrices;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly allProducts = signal<CatalogProduct[]>([]);

  private readonly state = inject(CatalogStateService);
  private readonly injector = inject(Injector);
  // Nur bei Browser-/App-"Zurück" (popstate) die alte Scroll-Position setzen.
  private readonly restoreScroll = inject(Router).currentNavigation()?.trigger === 'popstate';

  readonly searchText = this.state.searchText;
  readonly selectedCategories = this.state.selectedCategories;
  readonly categorySeasons = signal<CategorySeason[]>([]);
  readonly sortOption = this.state.sortOption;
  readonly visibleCount = this.state.visibleCount;

  private readonly scrollAnchor = viewChild<ElementRef<HTMLElement>>('scrollAnchor');
  private observer: IntersectionObserver | null = null;

  readonly sortOptions = computed(() => {
    const options = [
      { label: 'Beliebteste zuerst', value: 'popular' as SortOption },
      { label: 'Neu zuerst', value: 'newest' as SortOption },
    ];
    if (this.showPrices()) {
      options.push(
        { label: 'Preis aufsteigend', value: 'price_asc' as SortOption },
        { label: 'Preis absteigend', value: 'price_desc' as SortOption },
      );
    }
    return options;
  });

  // Kategorie-Filter statt Tags (Migration 00187, Entscheidung 2026-09-24,
  // Betreiber). Aktuelle Saison-Kategorien stehen zuerst (kürzester Zeitraum
  // vorn), danach alphabetisch. Vergleich ohne Groß-/Kleinschreibung.
  // Saison-Schalter in den Settings (Migration 00189): aus = keine Saisons.
  private readonly activeSeasons = computed(() => (this.pricing.seasonsEnabled() ? this.categorySeasons() : []));

  readonly seasonCategoryKeys = computed(() =>
    currentSeasonCategories(this.activeSeasons()).map((c) => c.toLowerCase()),
  );

  readonly availableCategories = computed(() => {
    const byKey = new Map<string, string>();
    for (const p of this.allProducts()) {
      const c = p.category?.trim();
      if (c && !byKey.has(c.toLowerCase())) byKey.set(c.toLowerCase(), c);
    }
    const seasonKeys = this.seasonCategoryKeys().filter((k) => byKey.has(k));
    const rest = Array.from(byKey.keys())
      .filter((k) => !seasonKeys.includes(k))
      .sort((a, b) => byKey.get(a)!.localeCompare(byKey.get(b)!, 'de'));
    return [
      ...seasonKeys.map((k) => ({ label: `${byKey.get(k)} (Saison)`, name: byKey.get(k)!, value: k, season: true })),
      ...rest.map((k) => ({ label: byKey.get(k)!, name: byKey.get(k)!, value: k, season: false })),
    ];
  });

  readonly currentSeasonOptions = computed(() => this.availableCategories().filter((c) => c.season));

  // Saison-Banner (Migration 00188): kürzeste aktuelle Saison, für die es
  // Produkte gibt; nur ohne aktive Suche/Filter. Bis zu 4 Produktbilder.
  readonly seasonBanner = computed<SeasonBannerData | null>(() => {
    if (this.hasActiveFilters()) return null;
    const optionKeys = new Set(this.currentSeasonOptions().map((o) => o.value));
    const season = currentSeasons(this.activeSeasons()).find((s) => optionKeys.has(s.category.trim().toLowerCase()));
    if (!season) return null;
    const key = season.category.trim().toLowerCase();
    const name = this.currentSeasonOptions().find((o) => o.value === key)!.name;
    const images = this.allProducts()
      .filter((p) => p.category?.trim().toLowerCase() === key)
      .map((p) => this.coverImage(p))
      .filter((url): url is string => !!url)
      .slice(0, 4);
    return {
      key,
      title: season.banner_title?.trim() || name,
      text: season.banner_text?.trim() || 'Jetzt passend zur Saison',
      images,
    };
  });

  // Weitere aktuelle Saisons neben dem Banner als Chips.
  readonly otherSeasonOptions = computed(() => {
    const bannerKey = this.seasonBanner()?.key;
    return this.currentSeasonOptions().filter((o) => o.value !== bannerKey);
  });

  readonly filteredProducts = computed(() => {
    const text = this.searchText().trim().toLowerCase();
    const categories = this.selectedCategories();

    let result = this.allProducts();

    if (text) {
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(text) ||
          p.tags.some((t) => t.toLowerCase().includes(text)),
      );
    }

    if (categories.length > 0) {
      result = result.filter((p) => categories.includes(p.category?.trim().toLowerCase() ?? ''));
    }

    const sorted = [...result];
    switch (this.sortOption()) {
      case 'price_asc':
        sorted.sort((a, b) => (a.minPrice ?? Infinity) - (b.minPrice ?? Infinity));
        break;
      case 'price_desc':
        sorted.sort((a, b) => (b.minPrice ?? -Infinity) - (a.minPrice ?? -Infinity));
        break;
      case 'newest':
        sorted.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
        break;
      case 'popular':
        sorted.sort((a, b) => b.likesCount - a.likesCount);
        break;
    }

    // Saison-Produkte nach oben — nicht bei expliziter Preissortierung.
    const seasonKeys = this.seasonCategoryKeys();
    const priceSort = this.sortOption() === 'price_asc' || this.sortOption() === 'price_desc';
    if (seasonKeys.length > 0 && !priceSort) {
      const rank = (p: CatalogProduct) => {
        const i = seasonKeys.indexOf(p.category?.trim().toLowerCase() ?? '');
        return i === -1 ? seasonKeys.length : i;
      };
      sorted.sort((a, b) => rank(a) - rank(b)); // stabil: Reihenfolge innerhalb bleibt
    }
    return sorted;
  });

  readonly pagedProducts = computed(() => this.filteredProducts().slice(0, this.visibleCount()));

  readonly hasMore = computed(() => this.visibleCount() < this.filteredProducts().length);

  constructor(
    private readonly catalogService: CatalogService,
    private readonly likesService: LikesService,
    private readonly router: Router,
  ) {
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && this.hasMore()) {
          this.loadMore();
        }
      },
      { rootMargin: '400px' },
    );
    // Sentinel-Element sitzt hinter dem @for/@if-Zweig und wird erst nach
    // dem ersten erfolgreichen Laden gerendert (bzw. neu, falls die Sicht
    // zwischenzeitlich auf Fehler-/Leerzustand wechselt) -- effect() haengt
    // den Observer bei jeder Neuzuweisung des viewChild-Signals neu ein.
    effect(() => {
      const el = this.scrollAnchor()?.nativeElement;
      this.observer?.disconnect();
      if (el) this.observer?.observe(el);
    });
  }

  ngOnInit(): void {
    this.load();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.state.scrollY = window.scrollY;
  }

  loadMore(): void {
    this.visibleCount.update((n) => n + PAGE_SIZE);
  }

  async load(): Promise<void> {
    this.error.set(null);
    const cached = this.state.cachedProducts;
    if (cached) {
      // Zurück aus dem Produkt: gemerkten Stand sofort zeigen, Scroll-Position
      // wiederherstellen, frische Daten still im Hintergrund nachladen.
      this.allProducts.set(cached);
      this.loading.set(false);
      if (this.restoreScroll) {
        const y = this.state.scrollY;
        afterNextRender(() => window.scrollTo({ top: y }), { injector: this.injector });
      }
    } else {
      this.loading.set(true);
    }
    try {
      const products = await this.catalogService.getCatalog();
      const current = this.allProducts();
      // Like-Stand aus dem Cache übernehmen, bis loadLikes() fertig ist.
      for (const p of products) {
        const old = current.find((c) => c.product_id === p.product_id);
        if (old) {
          p.likesCount = old.likesCount;
          p.likedByMe = old.likedByMe;
        }
      }
      this.allProducts.set(products);
      this.state.cachedProducts = products;
    } catch {
      if (!cached) this.error.set('Katalog konnte nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
    void this.loadLikes();
    void this.loadSeasons();
  }

  resetFilters(): void {
    this.state.resetFilters();
  }

  readonly hasActiveFilters = computed(
    () => this.searchText().trim().length > 0 || this.selectedCategories().length > 0,
  );

  // Saisons sind optional — ein Fehler blockiert den Katalog nicht.
  private async loadSeasons(): Promise<void> {
    try {
      this.categorySeasons.set(await this.catalogService.getCategorySeasons());
    } catch {
      this.categorySeasons.set([]);
    }
  }

  selectSeasonCategory(value: string): void {
    this.selectedCategories.set([value]);
    this.onFilterChanged();
  }

  // Likes sind unabhängig vom übrigen Katalog-Laden (Spec like-system.md §1)
  // -- ein Fehler hier blockiert den Katalog nicht, Zähler bleiben dann 0.
  private async loadLikes(): Promise<void> {
    try {
      const [counts, likedIds] = await Promise.all([this.likesService.getCounts(), this.likesService.getMyLikedIds()]);
      this.allProducts.update((products) => {
        this.likesService.applyLikeState(products, counts, likedIds);
        return [...products];
      });
      this.state.cachedProducts = this.allProducts();
    } catch {
      // still -- Herz-Icons bleiben bei 0/ungeliked.
    }
  }

  async toggleLike(product: CatalogProduct, event: Event): Promise<void> {
    event.stopPropagation();
    event.preventDefault();
    const prevLiked = product.likedByMe;
    const prevCount = product.likesCount;
    this.patchProduct(product.product_id, { likedByMe: !prevLiked, likesCount: prevCount + (prevLiked ? -1 : 1) });
    try {
      const result = await this.likesService.toggle(product.product_id);
      this.patchProduct(product.product_id, { likedByMe: result.liked, likesCount: result.likesCount });
    } catch {
      this.patchProduct(product.product_id, { likedByMe: prevLiked, likesCount: prevCount });
    }
  }

  private patchProduct(productId: string, patch: Partial<CatalogProduct>): void {
    this.allProducts.update((products) => products.map((p) => (p.product_id === productId ? { ...p, ...patch } : p)));
    this.state.cachedProducts = this.allProducts();
  }

  onFilterChanged(): void {
    this.visibleCount.set(PAGE_SIZE);
  }

  openProduct(product: CatalogProduct): void {
    this.router.navigate(['/produkt', product.product_id]);
  }

  private readonly newSince = Date.now() - NEW_PRODUCT_DAYS * 24 * 60 * 60 * 1000;

  isNew(product: CatalogProduct): boolean {
    return !!product.created_at && new Date(product.created_at).getTime() >= this.newSince;
  }

  coverImage(product: CatalogProduct): string | null {
    return product.images?.[0]?.url ?? null;
  }
}
