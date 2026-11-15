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

import { CartService } from '../../../core/services/cart.service';
import { CartDetailsService } from '../../../core/services/cart-details.service';
import { WorkerApiService } from '../../../core/services/worker-api.service';
import { TurnstileWidget } from '../../../shared/turnstile/turnstile-widget';
import { PricingService } from '../../../core/services/pricing.service';
import { LEGAL_PAGES_ENABLED } from '../../../core/legal-pages';
import { priceSummary, unpricedHint } from '../../../core/utils/price-summary.util';
import { isEmailFormatValid } from '../../../core/utils/email.util';

interface CheckoutRow {
  cartItemId: string;
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
  private readonly cartDetails = inject(CartDetailsService);
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

  private readonly orderTurnstile = viewChild<TurnstileWidget>('orderTurnstile');

  readonly firstName = signal('');
  readonly lastName = signal('');
  readonly phone = signal('');
  readonly email = signal('');

  readonly turnstileToken = signal<string | null>(null);

  readonly summary = computed(() => priceSummary(this.rows()));
  readonly unpricedHint = unpricedHint;

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

  // Fehlendes rot markieren und auflisten statt nur grauem Knopf (Review B13,
  // gleiches Muster wie die Individualanfrage).
  readonly attempted = signal(false);
  readonly invalidFirstName = computed(() => !this.firstName().trim());
  readonly invalidLastName = computed(() => this.lastNameRequired() && !this.lastName().trim());
  readonly invalidContact = computed(
    () => this.contactRequired() && !this.phone().trim() && !this.email().trim(),
  );
  readonly invalidEmail = computed(() => !isEmailFormatValid(this.email()));

  readonly missingFields = computed(() => {
    const missing: string[] = [];
    if (this.invalidFirstName()) missing.push('Vorname');
    if (this.invalidLastName()) missing.push('Nachname');
    if (this.invalidContact()) missing.push('Telefon oder E-Mail');
    if (this.invalidEmail()) missing.push('gültige E-Mail-Adresse');
    return missing;
  });

  readonly canSubmit = computed(
    () =>
      this.rows().length > 0 &&
      !this.hasQtyViolation() &&
      this.missingFields().length === 0 &&
      this.turnstileToken() !== null &&
      !this.submitting(),
  );

  /** Knopf nur bei echten Blockern gesperrt; fehlende Angaben meldet onSubmitClick. */
  readonly submitBlocked = computed(() => this.submitting() || this.rows().length === 0 || this.hasQtyViolation());

  onSubmitClick(): void {
    this.attempted.set(true);
    const missing = this.missingFields();
    if (missing.length > 0) {
      this.error.set(`Bitte noch ausfüllen: ${missing.join(', ')}.`);
      return;
    }
    if (!this.turnstileToken()) {
      this.error.set('Bitte bestätige zuerst die Sicherheitsabfrage.');
      return;
    }
    this.error.set(null);
    void this.submitOrder();
  }

  constructor(
    private readonly cartService: CartService,
    private readonly workerApi: WorkerApiService,
    private readonly router: Router,
    private readonly messageService: MessageService,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const { cartSessionId, rows } = await this.cartDetails.load();
      if (!cartSessionId || rows.length === 0) {
        this.router.navigate([this.pricing.listPath()]);
        return;
      }
      this.cartSessionId.set(cartSessionId);
      this.rows.set(
        rows.map((r) => ({
          cartItemId: r.cartItemId,
          productName: r.productName,
          sizeLabel: r.sizeLabel,
          configLabel: r.configLabel,
          qty: r.qty,
          minQty: r.minQty,
          maxQty: r.maxQty,
          stepQty: r.stepQty,
          finalPrice: r.finalPrice,
        })),
      );
    } catch {
      this.error.set(this.pricing.listLoadErrorLabel());
    } finally {
      this.loading.set(false);
    }
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
      // Turnstile-Token ist verbraucht -- für den nächsten Versuch neues anfordern.
      this.turnstileToken.set(null);
      this.orderTurnstile()?.reset();
    } finally {
      this.submitting.set(false);
    }
  }
}
