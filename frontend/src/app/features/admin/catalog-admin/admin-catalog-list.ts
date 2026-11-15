import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { MessageService } from 'primeng/api';
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
import { AuthService } from '../../../core/services/auth.service';
import { WorkerApiService } from '../../../core/services/worker-api.service';

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

  private readonly messages = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly workerApi = inject(WorkerApiService);

  // „Beschreibungen ergänzen“ (Entscheidung Betreiber 2026-11-15): KI-Vorschlag
  // für alle Produkte ohne Beschreibung, nichts wird überschrieben.
  readonly describing = signal(false);
  readonly describeProgress = signal<{ done: number; total: number } | null>(null);

  constructor(
    private readonly catalogService: AdminCatalogService,
    private readonly router: Router,
  ) {}

  async fillDescriptions(): Promise<void> {
    const token = this.auth.session()?.access_token;
    if (!token || this.describing()) return;
    this.describing.set(true);
    try {
      const candidates = await this.catalogService.listProductsWithoutDescription();
      if (candidates.length === 0) {
        this.messages.add({ severity: 'info', summary: 'Alle Produkte haben schon eine Beschreibung' });
        return;
      }
      const ok = window.confirm(
        `${candidates.length} Produkte ohne Beschreibung.

Für jedes einen kurzen KI-Text erzeugen und speichern? ` +
          'Vorhandene Beschreibungen werden nicht verändert; du kannst jeden Text später im Editor ändern.',
      );
      if (!ok) return;
      let done = 0;
      let failed = 0;
      this.describeProgress.set({ done, total: candidates.length });
      const queue = [...candidates];
      const worker = async (): Promise<void> => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          try {
            const text = await this.workerApi.generateDescription(token, {
              title: c.name,
              tags: c.tags,
              sizeHint: c.sizeHint,
              parts: c.parts,
            });
            await this.catalogService.setDescriptionIfEmpty(c.id, text);
          } catch {
            failed++;
          }
          done++;
          this.describeProgress.set({ done, total: candidates.length });
        }
      };
      await Promise.all([worker(), worker()]);
      this.messages.add({
        severity: failed > 0 ? 'warn' : 'success',
        summary: `${done - failed} Beschreibungen ergänzt`,
        detail: failed > 0 ? `${failed} fehlgeschlagen – einfach erneut starten.` : undefined,
      });
    } catch (e) {
      this.messages.add({ severity: 'error', summary: 'Beschreibungen ergänzen fehlgeschlagen', detail: (e as Error)?.message });
    } finally {
      this.describing.set(false);
      this.describeProgress.set(null);
    }
  }

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.products.set(await this.catalogService.listProducts());
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
