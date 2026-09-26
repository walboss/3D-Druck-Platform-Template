import { Injectable, computed, signal } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';

/**
 * Öffentliche Storefront-Schalter aus settings (fn_get_public_settings), admin-steuerbar:
 * - showPrices: settings.storefront_prices_visible
 * - shopEnabled: settings.storefront_shop_enabled (Wunschliste: Katalog-Auswahl + Kontaktformular)
 * - customRequestEnabled: settings.storefront_custom_request_enabled (freies Anfrage-Formular)
 * - seasonsEnabled: settings.storefront_seasons_enabled (Saison-Banner/-Sortierung im Katalog)
 * Alle starten mit false, bis load() die echten Werte geladen hat.
 */
@Injectable({ providedIn: 'root' })
export class PricingService {
  readonly showPrices = signal(false);
  readonly shopEnabled = signal(false);
  readonly customRequestEnabled = signal(false);
  readonly seasonsEnabled = signal(false);
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  // Zentrale Textmap für Wunschliste/Warenkorb-Terminologie, flag-abhängig
  // via showPrices() statt shopEnabled() (Korrektur 2026-09-20):
  // shopEnabled steuert nur, ob die Liste überhaupt erreichbar ist (auch
  // im Privatmodus "an", damit die Wunschliste nutzbar ist) -- ob
  // kommerzielle Sprache/Preise erscheinen, hängt an showPrices(), nicht
  // an der bloßen Erreichbarkeit. specs/privatmodus-schalter.md §6.3b
  // entsprechend korrigiert.
  readonly listPath = computed(() => (this.showPrices() ? '/warenkorb' : '/wunschliste'));
  readonly checkoutPath = computed(() => (this.showPrices() ? '/checkout' : '/anfrage-abschicken'));
  readonly apiEndpointPath = computed(() => (this.showPrices() ? '/api/checkout' : '/api/wunschliste'));
  readonly listLabel = computed(() => (this.showPrices() ? 'Warenkorb' : 'Wunschliste'));
  readonly checkoutLabel = computed(() => (this.showPrices() ? 'Kasse' : 'Anfrage abschicken'));
  readonly submitOrderLabel = computed(() => (this.showPrices() ? 'Zahlungspflichtig bestellen' : 'Anfrage senden'));
  readonly addToListLabel = computed(() => (this.showPrices() ? 'In den Warenkorb' : 'Hinzufügen'));
  readonly goToListLabel = computed(() => (this.showPrices() ? 'Zum Warenkorb' : 'Zur Wunschliste'));
  readonly continueBrowsingLabel = computed(() => (this.showPrices() ? 'Weiter einkaufen' : 'Weiter stöbern'));
  readonly listLoadErrorLabel = computed(() => `${this.listLabel()} konnte nicht geladen werden.`);
  // Bestätigungsseite nach dem Absenden (privatmodus-schalter.md §6: keine
  // Bestell-Sprache im Privatmodus, auch nicht in der URL).
  readonly confirmationPath = computed(() => (this.showPrices() ? '/bestellbestaetigung' : '/uebermittelt'));
  readonly qtyInvalidLabel = computed(() =>
    this.showPrices()
      ? 'Diese Menge ist aktuell nicht bestellbar. Bitte Menge reduzieren.'
      : 'Diese Menge ist aktuell nicht möglich. Bitte Menge reduzieren.',
  );

  constructor(private readonly supabase: SupabaseClientService) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.fetch();
    }
    await this.loadPromise;
  }

  private async fetch(): Promise<void> {
    const { data, error } = await this.supabase.client.rpc('fn_get_public_settings');
    if (!error && data) {
      this.showPrices.set(!!data['storefront_prices_visible']);
      this.shopEnabled.set(!!data['storefront_shop_enabled']);
      this.customRequestEnabled.set(!!data['storefront_custom_request_enabled']);
      this.seasonsEnabled.set(!!data['storefront_seasons_enabled']);
      this.loaded = true;
    }
  }
}
