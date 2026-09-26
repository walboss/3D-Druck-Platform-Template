import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { InputNumberModule } from 'primeng/inputnumber';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';

import { AdminSettingsService, SettingsData } from '../../../core/services/admin-settings.service';

// Shop-Modus = feste Kombination der drei unabhängigen Storefront-Flags
// (specs/privatmodus-schalter.md §2, Entscheidung Betreiber 2026-09-24). Die Flags
// bleiben einzeln gespeichert und unter "Erweitert" einzeln schaltbar.
type ShopModeId = 'catalog' | 'private' | 'commercial';

interface ShopMode {
  id: ShopModeId;
  label: string;
  description: string;
  shop: boolean;
  prices: boolean;
  customRequest: boolean;
}

export const SHOP_MODES: ShopMode[] = [
  {
    id: 'catalog',
    label: 'Nur Katalog',
    description: 'Besucher sehen nur die Produkte. Keine Wunschliste, keine Preise, keine Anfragen.',
    shop: false,
    prices: false,
    customRequest: false,
  },
  {
    id: 'private',
    label: 'Privat mit Wunschliste',
    description: 'Wunschliste mit Kontaktformular, ohne Preise und ohne Individualanfrage.',
    shop: true,
    prices: false,
    customRequest: false,
  },
  {
    id: 'commercial',
    label: 'Gewerblicher Shop',
    description: 'Preise, Warenkorb mit Kasse und Individualanfrage sind aktiv.',
    shop: true,
    prices: true,
    customRequest: true,
  },
];

@Component({
  selector: 'app-admin-settings',
  standalone: true,
  imports: [FormsModule, ButtonModule, ToggleSwitchModule, InputNumberModule, SkeletonModule, MessageModule],
  templateUrl: './admin-settings.html',
  styleUrl: './admin-settings.scss',
})
export class AdminSettings implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly saved = signal(false);

  readonly settings = signal<SettingsData | null>(null);

  readonly emailSystemEnabled = signal(false);
  readonly emailRequiredAtOrder = signal(false);
  readonly electricityPricePerKwh = signal(0);
  readonly defaultLaborRatePerHour = signal(0);
  readonly minOrderValue = signal<number | null>(null);
  readonly customerDataRetentionDays = signal(730);
  // storefront_shop_enabled und storefront_prices_visible sind zwei
  // unabhaengige Flags (specs/privatmodus-schalter.md §2) -- bewusst
  // getrennte Schalter, damit "Wunschliste an, Preise aus" (Privatmodus)
  // ueber die UI weiterhin waehlbar bleibt (Entscheidung 2026-09-20,
  // Migration 00172/00173 -- vorher kurzzeitig zu einem Schalter
  // zusammengefasst, dadurch war dieser Zustand nicht mehr erreichbar).
  readonly storefrontShopEnabled = signal(false);
  readonly storefrontPricesVisible = signal(false);
  readonly storefrontCustomRequestEnabled = signal(false);
  // Saison-Funktion im Katalog (Migration 00189)
  readonly storefrontSeasonsEnabled = signal(true);

  readonly shopModes = SHOP_MODES;
  /** Passender Modus zu den aktuellen Flags, null = eigene Einstellung */
  readonly shopMode = computed<ShopModeId | null>(
    () =>
      SHOP_MODES.find(
        (m) =>
          m.shop === this.storefrontShopEnabled() &&
          m.prices === this.storefrontPricesVisible() &&
          m.customRequest === this.storefrontCustomRequestEnabled(),
      )?.id ?? null,
  );
  readonly advancedOpen = signal(false);

  constructor(private readonly settingsService: AdminSettingsService) {}

  ngOnInit(): void {
    this.load();
  }

  selectShopMode(mode: ShopMode): void {
    this.storefrontShopEnabled.set(mode.shop);
    this.storefrontPricesVisible.set(mode.prices);
    this.storefrontCustomRequestEnabled.set(mode.customRequest);
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await this.settingsService.getSettings();
      this.settings.set(data);
      this.emailSystemEnabled.set(data.emailSystemEnabled);
      this.emailRequiredAtOrder.set(data.emailRequiredAtOrder);
      this.electricityPricePerKwh.set(data.electricityPricePerKwh);
      this.defaultLaborRatePerHour.set(data.defaultLaborRatePerHour);
      this.minOrderValue.set(data.minOrderValue);
      this.customerDataRetentionDays.set(data.customerDataRetentionDays);
      this.storefrontShopEnabled.set(data.storefrontShopEnabled);
      this.storefrontPricesVisible.set(data.storefrontPricesVisible);
      this.storefrontCustomRequestEnabled.set(data.storefrontCustomRequestEnabled);
      this.storefrontSeasonsEnabled.set(data.storefrontSeasonsEnabled);
      // Abweichende Kombination → Einzelschalter gleich aufgeklappt zeigen
      this.advancedOpen.set(this.shopMode() === null);
    } catch {
      this.error.set('Einstellungen konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  async save(): Promise<void> {
    const previous = this.settings();
    if (!previous) return;
    this.saving.set(true);
    this.error.set(null);
    this.saved.set(false);
    try {
      const next = {
        emailSystemEnabled: this.emailSystemEnabled(),
        emailRequiredAtOrder: this.emailRequiredAtOrder(),
        electricityPricePerKwh: this.electricityPricePerKwh(),
        defaultLaborRatePerHour: this.defaultLaborRatePerHour(),
        minOrderValue: this.minOrderValue(),
        customerDataRetentionDays: this.customerDataRetentionDays(),
        storefrontPricesVisible: this.storefrontPricesVisible(),
        storefrontShopEnabled: this.storefrontShopEnabled(),
        storefrontCustomRequestEnabled: this.storefrontCustomRequestEnabled(),
        storefrontSeasonsEnabled: this.storefrontSeasonsEnabled(),
      };
      await this.settingsService.updateSettings(previous, next);
      this.settings.set({ ...previous, ...next });
      this.saved.set(true);
    } catch {
      this.error.set('Einstellungen konnten nicht gespeichert werden.');
    } finally {
      this.saving.set(false);
    }
  }
}
