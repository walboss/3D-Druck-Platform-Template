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
  readonly newOrdersCount = computed(() => (this.openOrders()?.orders ?? []).filter((o) => o.status === 'New').length);

  // „Was ist zu tun?“-Kacheln (Spec 19, Entscheidung 2026-11-14, Review C23/F9)
  readonly pickupLoading = signal(true);
  readonly pickupError = signal(false);
  readonly pickupCount = signal(0);

  readonly requestsLoading = signal(true);
  readonly requestsError = signal(false);
  readonly newRequestsCount = signal(0);

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

  // Polling ohne Lade-Skelett und nur bei sichtbarem Tab; beim Zurückkehren
  // sofort aktualisieren (Spec 19, Review C23).
  private readonly onVisibilityChange = (): void => {
    if (!document.hidden) this.loadAll(true);
  };

  ngOnInit(): void {
    this.loadAll();
    this.pollHandle = setInterval(() => {
      if (!document.hidden) this.loadAll(true);
    }, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** silent = Hintergrund-Aktualisierung: alte Werte bleiben stehen, kein Skelett. */
  loadAll(silent = false): void {
    void this.loadOpenOrders(silent);
    void this.loadReadyForPickup(silent);
    void this.loadNewRequests(silent);
    void this.loadLowStock(silent);
    void this.loadProduction(silent);
    void this.loadSeason(silent);
    void this.loadNoCategory(silent);
    void this.loadDefaultPrinter(silent);
  }

  async loadReadyForPickup(silent = false): Promise<void> {
    if (!silent) this.pickupLoading.set(true);
    this.pickupError.set(false);
    try {
      this.pickupCount.set(await this.dashboardService.getReadyForPickupCount());
    } catch {
      this.pickupError.set(true);
    } finally {
      this.pickupLoading.set(false);
    }
  }

  async loadNewRequests(silent = false): Promise<void> {
    if (!silent) this.requestsLoading.set(true);
    this.requestsError.set(false);
    try {
      this.newRequestsCount.set(await this.dashboardService.getNewRequestsCount());
    } catch {
      this.requestsError.set(true);
    } finally {
      this.requestsLoading.set(false);
    }
  }

  async loadSeason(silent = false): Promise<void> {
    if (!silent) this.seasonLoading.set(true);
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

  async loadNoCategory(silent = false): Promise<void> {
    if (!silent) this.noCategoryLoading.set(true);
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

  async loadDefaultPrinter(silent = false): Promise<void> {
    if (!silent) this.printerLoading.set(true);
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

  async loadOpenOrders(silent = false): Promise<void> {
    if (!silent) this.openOrdersLoading.set(true);
    this.openOrdersError.set(false);
    try {
      this.openOrders.set(await this.dashboardService.getOpenOrders());
    } catch {
      this.openOrdersError.set(true);
    } finally {
      this.openOrdersLoading.set(false);
    }
  }

  async loadLowStock(silent = false): Promise<void> {
    if (!silent) this.lowStockLoading.set(true);
    this.lowStockError.set(false);
    try {
      this.lowStock.set(await this.dashboardService.getLowStock());
    } catch {
      this.lowStockError.set(true);
    } finally {
      this.lowStockLoading.set(false);
    }
  }

  async loadProduction(silent = false): Promise<void> {
    if (!silent) this.productionLoading.set(true);
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
