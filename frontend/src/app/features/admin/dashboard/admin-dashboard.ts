import { Component, OnDestroy, OnInit, inject, signal, computed } from '@angular/core';
import { Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';

import {
  AdminDashboardService,
  LowStockSpool,
  OpenOrdersSummary,
  RunningProductionSummary,
} from '../../../core/services/admin-dashboard.service';
import { AdminCategorySeasonsService } from '../../../core/services/admin-category-seasons.service';
import { AdminSettingsService } from '../../../core/services/admin-settings.service';
import { AdminCatalogService } from '../../../core/services/admin-catalog.service';
import { AdminPrintersService } from '../../../core/services/admin-printers.service';
import { currentSeasons } from '../../../core/utils/season.util';

interface SeasonSummary {
  enabled: boolean;
  categories: string[];
}

const POLL_INTERVAL_MS = 60_000;

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [ButtonModule, SkeletonModule, MessageModule],
  templateUrl: './admin-dashboard.html',
  styleUrl: './admin-dashboard.scss',
})
export class AdminDashboard implements OnInit, OnDestroy {
  readonly openOrdersLoading = signal(true);
  readonly openOrdersError = signal(false);
  readonly openOrders = signal<OpenOrdersSummary | null>(null);
  readonly ordersWithComment = computed(() => (this.openOrders()?.orders ?? []).filter((o) => !!o.customer_message?.trim()));

  readonly lowStockLoading = signal(true);
  readonly lowStockError = signal(false);
  readonly lowStock = signal<LowStockSpool[]>([]);

  readonly productionLoading = signal(true);
  readonly productionError = signal(false);
  readonly production = signal<RunningProductionSummary | null>(null);

  // Katalog-Kacheln (Entscheidung 2026-09-24): heutige Saison,
  // Produkte ohne Kategorie, Standard-Drucker.
  readonly seasonLoading = signal(true);
  readonly seasonError = signal(false);
  readonly season = signal<SeasonSummary | null>(null);

  readonly noCategoryLoading = signal(true);
  readonly noCategoryError = signal(false);
  readonly noCategoryCount = signal(0);

  readonly printerLoading = signal(true);
  readonly printerError = signal(false);
  readonly defaultPrinter = signal<string | null>(null);

  private readonly seasonsService = inject(AdminCategorySeasonsService);
  private readonly settingsService = inject(AdminSettingsService);
  private readonly catalogService = inject(AdminCatalogService);
  private readonly printersService = inject(AdminPrintersService);

  private pollHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly dashboardService: AdminDashboardService, private readonly router: Router) {}

  ngOnInit(): void {
    this.loadAll();
    this.pollHandle = setInterval(() => this.loadAll(), POLL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  loadAll(): void {
    this.loadOpenOrders();
    this.loadLowStock();
    this.loadProduction();
    this.loadSeason();
    this.loadNoCategory();
    this.loadDefaultPrinter();
  }

  async loadSeason(): Promise<void> {
    this.seasonLoading.set(true);
    this.seasonError.set(false);
    try {
      const [seasons, settings] = await Promise.all([this.seasonsService.list(), this.settingsService.getSettings()]);
      this.season.set({
        enabled: settings.storefrontSeasonsEnabled,
        categories: currentSeasons(seasons).map((s) => s.category.trim()),
      });
    } catch {
      this.seasonError.set(true);
    } finally {
      this.seasonLoading.set(false);
    }
  }

  async loadNoCategory(): Promise<void> {
    this.noCategoryLoading.set(true);
    this.noCategoryError.set(false);
    try {
      const products = await this.catalogService.listProducts();
      this.noCategoryCount.set(products.filter((p) => p.active && !p.category?.trim()).length);
    } catch {
      this.noCategoryError.set(true);
    } finally {
      this.noCategoryLoading.set(false);
    }
  }

  async loadDefaultPrinter(): Promise<void> {
    this.printerLoading.set(true);
    this.printerError.set(false);
    try {
      const printers = await this.printersService.listPrinters();
      this.defaultPrinter.set(printers.find((p) => p.is_default)?.name ?? null);
    } catch {
      this.printerError.set(true);
    } finally {
      this.printerLoading.set(false);
    }
  }

  async loadOpenOrders(): Promise<void> {
    this.openOrdersLoading.set(true);
    this.openOrdersError.set(false);
    try {
      this.openOrders.set(await this.dashboardService.getOpenOrders());
    } catch {
      this.openOrdersError.set(true);
    } finally {
      this.openOrdersLoading.set(false);
    }
  }

  async loadLowStock(): Promise<void> {
    this.lowStockLoading.set(true);
    this.lowStockError.set(false);
    try {
      this.lowStock.set(await this.dashboardService.getLowStock());
    } catch {
      this.lowStockError.set(true);
    } finally {
      this.lowStockLoading.set(false);
    }
  }

  async loadProduction(): Promise<void> {
    this.productionLoading.set(true);
    this.productionError.set(false);
    try {
      this.production.set(await this.dashboardService.getRunningProduction());
    } catch {
      this.productionError.set(true);
    } finally {
      this.productionLoading.set(false);
    }
  }

  goToOrders(): void {
    this.router.navigate(['/admin/bestellungen']);
  }

  goToInventory(): void {
    this.router.navigate(['/admin/lager']);
  }

  goToProduction(): void {
    this.router.navigate(['/admin/produktion']);
  }

  goTo(path: string): void {
    this.router.navigate([path]);
  }
}
