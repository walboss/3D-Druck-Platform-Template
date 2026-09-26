import { Injectable, signal } from '@angular/core';
import { CatalogProduct } from '../models/db-types';

export type CatalogSortOption = 'price_asc' | 'price_desc' | 'newest' | 'popular';

export const CATALOG_PAGE_SIZE = 12;

// Katalog-Zustand über Navigationen hinweg (Entscheidung 2026-09-24):
// Zurück vom Produkt behält Suche, Filter, Sortierung, geladene Menge und
// Scroll-Position. Nur im Speicher — Neuladen der Seite setzt alles zurück.
@Injectable({ providedIn: 'root' })
export class CatalogStateService {
  readonly searchText = signal('');
  readonly selectedCategories = signal<string[]>([]);
  readonly sortOption = signal<CatalogSortOption>('newest');
  readonly visibleCount = signal(CATALOG_PAGE_SIZE);

  // Letzter geladener Katalog: sofort anzeigen, im Hintergrund aktualisieren.
  cachedProducts: CatalogProduct[] | null = null;
  scrollY = 0;

  resetFilters(): void {
    this.searchText.set('');
    this.selectedCategories.set([]);
    this.visibleCount.set(CATALOG_PAGE_SIZE);
  }
}
