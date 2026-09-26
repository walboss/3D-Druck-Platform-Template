import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { TabsModule } from 'primeng/tabs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { DialogModule } from 'primeng/dialog';
import { AutoCompleteModule, AutoCompleteCompleteEvent } from 'primeng/autocomplete';

import { AdminCatalogService, AdminProductListRow } from '../../../core/services/admin-catalog.service';
import { AdminMakerworldService } from '../../../core/services/admin-makerworld.service';

@Component({
  selector: 'app-admin-catalog-list',
  standalone: true,
  imports: [
    FormsModule,
    TabsModule,
    TableModule,
    ButtonModule,
    ToggleSwitchModule,
    SkeletonModule,
    MessageModule,
    DialogModule,
    AutoCompleteModule,
  ],
  templateUrl: './admin-catalog-list.html',
  styleUrl: './admin-catalog-list.scss',
})
export class AdminCatalogList implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly products = signal<AdminProductListRow[]>([]);
  readonly openSuggestions = signal(0);

  // "Nur ohne Kategorie": schnelles Nachpflegen für Kategorie-Filter/Saisons
  // im Katalog (Migration 00187).
  readonly onlyWithoutCategory = signal(false);
  readonly withoutCategoryCount = computed(() => this.products().filter((p) => !p.category?.trim()).length);
  private readonly visibleProducts = computed(() =>
    this.onlyWithoutCategory() ? this.products().filter((p) => !p.category?.trim()) : this.products(),
  );
  readonly activeProducts = computed(() => this.visibleProducts().filter((p) => p.active));
  readonly hiddenProducts = computed(() => this.visibleProducts().filter((p) => !p.active));

  // Mehrfachauswahl: Kategorie für mehrere Produkte auf einmal setzen.
  readonly selectedProducts = signal<AdminProductListRow[]>([]);
  readonly bulkDialogVisible = signal(false);
  readonly bulkCategory = signal('');
  readonly bulkSaving = signal(false);
  readonly bulkError = signal<string | null>(null);
  readonly knownCategories = signal<string[]>([]);
  readonly categorySuggestions = signal<string[]>([]);

  constructor(
    private readonly catalogService: AdminCatalogService,
    private readonly makerworldService: AdminMakerworldService,
    private readonly router: Router,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.products.set(await this.catalogService.listProducts());
      // Anzahl offener Kundenvorschläge (Spec 27 §6); Fehler hier blockieren
      // die Liste nicht.
      this.makerworldService
        .countOpenSuggestions()
        .then((n) => this.openSuggestions.set(n))
        .catch(() => this.openSuggestions.set(0));
    } catch {
      this.error.set('Produkte konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  async openBulkCategoryDialog(): Promise<void> {
    this.bulkCategory.set('');
    this.bulkError.set(null);
    this.bulkDialogVisible.set(true);
    this.knownCategories.set(await this.catalogService.listCategories().catch(() => []));
  }

  searchCategories(event: AutoCompleteCompleteEvent): void {
    const q = event.query.trim().toLocaleLowerCase('de');
    this.categorySuggestions.set(
      q ? this.knownCategories().filter((c) => c.toLocaleLowerCase('de').includes(q)) : [...this.knownCategories()],
    );
  }

  // Leere Eingabe = Kategorie entfernen.
  async applyBulkCategory(): Promise<void> {
    const ids = this.selectedProducts().map((p) => p.id);
    if (ids.length === 0) return;
    const category = (this.bulkCategory() ?? '').trim() || null;
    this.bulkSaving.set(true);
    this.bulkError.set(null);
    try {
      await this.catalogService.setCategoryForProducts(ids, category);
      this.products.update((list) => list.map((p) => (ids.includes(p.id) ? { ...p, category } : p)));
      this.selectedProducts.set([]);
      this.bulkDialogVisible.set(false);
    } catch {
      this.bulkError.set('Kategorie konnte nicht gesetzt werden.');
    } finally {
      this.bulkSaving.set(false);
    }
  }

  async toggleActive(product: AdminProductListRow, active: boolean): Promise<void> {
    try {
      await this.catalogService.setProductActive(product.id, active);
      product.active = active;
      // Toggle wechselt den Tab-Bestand (aktiv <-> ausgeblendet) — Signal
      // muss neu gesetzt werden, damit die computed()-Filter neu laufen.
      this.products.update((list) => [...list]);
    } catch {
      this.error.set('Status konnte nicht geändert werden.');
    }
  }

  openProduct(product: AdminProductListRow): void {
    this.router.navigate(['/admin/katalog', product.id]);
  }

  createProduct(): void {
    this.router.navigate(['/admin/katalog/neu']);
  }

  openMasterData(): void {
    this.router.navigate(['/admin/katalog/stammdaten']);
  }

  openSeasons(): void {
    this.router.navigate(['/admin/katalog/saisons']);
  }

  openImport(): void {
    this.router.navigate(['/admin/katalog/import']);
  }

  openSuggestions_(): void {
    this.router.navigate(['/admin/katalog/vorschlaege']);
  }

  formatPriceRange(product: AdminProductListRow): string {
    if (product.priceFrom === null || product.priceTo === null) return 'keine Kalkulation';
    const from = product.priceFrom.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (product.priceFrom === product.priceTo) return `${from} €`;
    const to = product.priceTo.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${from}–${to} €`;
  }

  formatPrintTimeRange(product: AdminProductListRow): string {
    if (product.printTimeMinFrom === null || product.printTimeMinTo === null) return '–';
    if (product.printTimeMinFrom === product.printTimeMinTo) return `${product.printTimeMinFrom} min`;
    return `${product.printTimeMinFrom}–${product.printTimeMinTo} min`;
  }
}
