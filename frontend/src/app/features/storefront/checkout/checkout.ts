import { Component, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';

import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';

import { CartService, RawCartItem } from '../../../core/services/cart.service';
import { SupabaseClientService } from '../../../core/services/supabase-client.service';
import { WorkerApiService } from '../../../core/services/worker-api.service';
import { TurnstileWidget } from '../../../shared/turnstile/turnstile-widget';
import { PricingService } from '../../../core/services/pricing.service';
import { StockOptionsService } from '../../../core/services/stock-options.service';
import { parseConfigurationDraft, formatConfigurationLabel } from '../../../core/utils/cart-configuration.util';
import { LEGAL_PAGES_ENABLED } from '../../../core/legal-pages';

interface CheckoutRow {
  productName: string;
  sizeLabel: string;
  configLabel: string;
  qty: number;
  minQty: number;
  maxQty: number;
  stepQty: number;
  finalPrice: number | null;
}

@Component({
  selector: 'app-checkout',
  standalone: true,
  imports: [CurrencyPipe, FormsModule, RouterLink, ButtonModule, InputTextModule, TextareaModule, MessageModule, SkeletonModule, TurnstileWidget],
  templateUrl: './checkout.html',
  styleUrl: './checkout.scss',
})
export class Checkout implements OnInit {
  readonly legalPagesEnabled = LEGAL_PAGES_ENABLED;
  readonly messageMaxLength = 500;
  readonly customerMessage = signal('');
  private readonly pricing = inject(PricingService);
  readonly showPrices = this.pricing.showPrices;
  readonly qtyInvalidLabel = this.pricing.qtyInvalidLabel;
  readonly checkoutLabel = this.pricing.checkoutLabel;
  readonly submitOrderLabel = this.pricing.submitOrderLabel;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly submitting = signal(false);

  readonly cartSessionId = signal<string | null>(null);
  readonly rows = signal<CheckoutRow[]>([]);

  readonly searchPhone = signal('');
  readonly searchEmail = signal('');
  readonly searching = signal(false);
  readonly searchDone = signal(false);
  readonly customerFound = signal(false);
  readonly searchValidationError = signal(false);
  // Eigenes Turnstile-Token für die Kundensuche (OFFENE-SECURITY-FIXES.md §5)
  // — ein Token gilt nur einmal, das Bestell-Token bleibt davon unberührt.
  readonly searchTurnstileToken = signal<string | null>(null);
  readonly searchError = signal(false);
  private readonly searchTurnstile = viewChild<TurnstileWidget>('searchTurnstile');

  readonly firstName = signal('');
  readonly lastName = signal('');
  readonly phone = signal('');
  readonly email = signal('');

  readonly turnstileToken = signal<string | null>(null);

  readonly total = computed(() => this.rows().reduce((sum, r) => sum + (r.finalPrice ?? 0) * r.qty, 0));

  readonly hasQtyViolation = computed(() =>
    this.rows().some(
      (r) => r.qty < r.minQty || r.qty > r.maxQty || (r.qty - r.minQty) % r.stepQty !== 0,
    ),
  );

  // Nachname nur im gewerblichen Modus (showPrices) Pflicht -- im Privatmodus
  // reicht der Vorname (Entscheidung 2026-09-20).
  readonly lastNameRequired = this.pricing.showPrices;

  // Telefon/E-Mail nur im gewerblichen Modus Pflicht (min. eins von beiden) --
  // im Privatmodus reicht der Vorname, keine Kontaktpflicht (Entscheidung
  // 2026-09-21).
  readonly contactRequired = this.pricing.showPrices;

  readonly canSubmit = computed(
    () =>
      this.rows().length > 0 &&
      !this.hasQtyViolation() &&
      this.firstName().trim().length > 0 &&
      (!this.lastNameRequired() || this.lastName().trim().length > 0) &&
      (!this.contactRequired() || this.phone().trim().length > 0 || this.email().trim().length > 0) &&
      this.turnstileToken() !== null &&
      !this.submitting(),
  );

  constructor(
    private readonly cartService: CartService,
    private readonly supabase: SupabaseClientService,
    private readonly workerApi: WorkerApiService,
    private readonly router: Router,
    private readonly messageService: MessageService,
    private readonly stockOptions: StockOptionsService,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [{ cartSessionId, items }] = await Promise.all([this.cartService.getCart(), this.stockOptions.load()]);
      if (!cartSessionId || items.length === 0) {
        this.router.navigate([this.pricing.listPath()]);
        return;
      }
      this.cartSessionId.set(cartSessionId);

      const variantIds = Array.from(new Set(items.map((i) => i.variant.id)));
      const { data, error } = await this.supabase.client
        .from('v_catalog')
        .select('variant_id, final_price')
        .in('variant_id', variantIds);
      if (error) throw error;
      const priceByVariant = new Map((data ?? []).map((r) => [r['variant_id'], r['final_price']]));

      const colorNameById = new Map(this.stockOptions.colors().map((c) => [c.id, c.name]));
      const finishNameById = new Map(this.stockOptions.finishes().map((f) => [f.id, f.name]));

      const draftsByProduct = items.map((i) => ({
        productId: i.product.id,
        entries: parseConfigurationDraft(i.configuration_draft),
      }));
      const productIdsWithParts = Array.from(
        new Set(
          draftsByProduct
            .filter((d) => d.entries.some((e) => e.product_part_id !== null))
            .map((d) => d.productId),
        ),
      );
      let partNameById = new Map<string, string>();
      if (productIdsWithParts.length > 0) {
        const { data: parts, error: partsError } = await this.supabase.client
          .from('product_parts')
          .select('id, name')
          .in('product_id', productIdsWithParts);
        if (partsError) throw partsError;
        partNameById = new Map((parts ?? []).map((p) => [p['id'], p['name']]));
      }

      this.rows.set(
        items.map((i: RawCartItem) => ({
          productName: i.product.name,
          sizeLabel: i.variant.size_label,
          configLabel: formatConfigurationLabel(
            parseConfigurationDraft(i.configuration_draft),
            colorNameById,
            finishNameById,
            partNameById,
          ),
          qty: i.qty,
          minQty: i.variant.min_qty,
          maxQty: i.variant.max_qty,
          stepQty: i.variant.step_qty,
          finalPrice: priceByVariant.get(i.variant.id) ?? null,
        })),
      );
    } catch {
      this.error.set(this.pricing.listLoadErrorLabel());
    } finally {
      this.loading.set(false);
    }
  }

  async runCustomerSearch(): Promise<void> {
    if (!this.searchPhone().trim() && !this.searchEmail().trim()) {
      this.searchValidationError.set(true);
      this.searchDone.set(false);
      return;
    }
    const token = this.searchTurnstileToken();
    if (!token) return;
    this.searchValidationError.set(false);
    this.searchError.set(false);
    this.searching.set(true);
    try {
      const found = await this.workerApi.searchCustomer(
        token,
        this.searchPhone().trim() || null,
        this.searchEmail().trim() || null,
      );
      this.customerFound.set(found);
      this.searchDone.set(true);
    } catch {
      this.searchDone.set(false);
      this.searchError.set(true);
    } finally {
      this.searching.set(false);
      // Token ist verbraucht → für die nächste Suche ein neues anfordern.
      this.searchTurnstileToken.set(null);
      this.searchTurnstile()?.reset();
    }
  }

  onSearchTurnstileVerified(token: string): void {
    this.searchTurnstileToken.set(token || null);
  }

  onSearchTurnstileExpired(): void {
    this.searchTurnstileToken.set(null);
  }

  onTurnstileVerified(token: string): void {
    this.turnstileToken.set(token || null);
  }

  onTurnstileExpired(): void {
    this.turnstileToken.set(null);
  }

  async submitOrder(): Promise<void> {
    if (!this.canSubmit()) return;
    const cartSessionId = this.cartSessionId();
    const token = this.turnstileToken();
    if (!cartSessionId || !token) return;

    this.submitting.set(true);
    this.error.set(null);
    try {
      const result = await this.workerApi.placeOrder(token, {
        p_cart_session_id: cartSessionId,
        p_customer: {
          first_name: this.firstName().trim(),
          last_name: this.lastName().trim(),
          phone: this.phone().trim() || null,
          email: this.email().trim() || null,
          pickup_method: 'Abholung',
          message: this.customerMessage().trim() || null,
        },
      });
      this.cartService.clearLocalSession();
      this.messageService.add({ severity: 'success', summary: `${this.pricing.listLabel()} übermittelt` });
      this.router.navigate([this.pricing.confirmationPath()], {
        queryParams: { token: result.tracking_token },
      });
    } catch (err) {
      const httpError = err as HttpErrorResponse;
      const message =
        (httpError?.error && (httpError.error.message || httpError.error.error)) ||
        'Anfrage konnte nicht abgeschickt werden. Bitte versuche es erneut.';
      this.error.set(message);
    } finally {
      this.submitting.set(false);
    }
  }
}
