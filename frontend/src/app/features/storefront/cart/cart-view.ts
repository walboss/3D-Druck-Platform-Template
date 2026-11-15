import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';

import { CartService } from '../../../core/services/cart.service';
import { CartDetailsService } from '../../../core/services/cart-details.service';
import { PricingService } from '../../../core/services/pricing.service';
import { parseQtyInput } from '../../../core/utils/qty-input.util';

interface CartRow {
  cartItemId: string;
  productId: string;
  variantId: string;
  productName: string;
  sizeLabel: string;
  configLabel: string;
  images: { url: string }[];
  qty: number;
  minQty: number;
  maxQty: number;
  stepQty: number;
  finalPrice: number | null;
  /** Zähler für das Neuaufbauen der Zeile, damit das Mengenfeld nach verworfener Eingabe die echte Menge zeigt. */
  rev: number;
}

import { SizedImage } from '../../../shared/sized-image/sized-image';
import { priceSummary, unpricedHint } from '../../../core/utils/price-summary.util';
@Component({
  selector: 'app-cart-view',
  standalone: true,
  imports: [SizedImage, CurrencyPipe, FormsModule, RouterLink, ButtonModule, InputNumberModule, MessageModule, SkeletonModule],
  templateUrl: './cart-view.html',
  styleUrl: './cart-view.scss',
})
export class CartView implements OnInit {
  private readonly cartDetails = inject(CartDetailsService);
  private readonly pricing = inject(PricingService);
  readonly showPrices = this.pricing.showPrices;
  readonly qtyInvalidLabel = this.pricing.qtyInvalidLabel;
  readonly listLabel = this.pricing.listLabel;
  readonly checkoutLabel = this.pricing.checkoutLabel;
  readonly continueBrowsingLabel = this.pricing.continueBrowsingLabel;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  /** Fehler bei Menge ändern/Entfernen -- Liste bleibt sichtbar. */
  readonly actionError = signal<string | null>(null);
  readonly rows = signal<CartRow[]>([]);
  private readonly invalidQtyInput = new Set<string>();

  readonly summary = computed(() => priceSummary(this.rows()));
  readonly unpricedHint = unpricedHint;

  isQtyInvalid(row: CartRow): boolean {
    return (
      row.qty < row.minQty || row.qty > row.maxQty || (row.qty - row.minQty) % row.stepQty !== 0
    );
  }

  constructor(
    private readonly cartService: CartService,
    private readonly router: Router,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const { rows } = await this.cartDetails.load();
      this.rows.set(rows.map((r) => ({ ...r, rev: 0 })));
    } catch {
      this.error.set(this.pricing.listLoadErrorLabel());
    } finally {
      this.loading.set(false);
    }
  }

  async updateQty(row: CartRow, value: unknown): Promise<void> {
    const qty = parseQtyInput(value);
    if (qty === null) {
      // Leeres/ungültiges Feld: nichts senden. Beim Verlassen des Felds wird die
      // gespeicherte Menge wieder angezeigt (onQtyBlur) -- nicht sofort, sonst
      // verliert das Feld beim Löschen-und-neu-Tippen den Fokus.
      this.invalidQtyInput.add(row.cartItemId);
      return;
    }
    this.invalidQtyInput.delete(row.cartItemId);
    if (qty === row.qty) return;
    this.actionError.set(null);
    try {
      await this.cartService.updateItemQty(row.cartItemId, qty);
      this.rows.set(this.rows().map((r) => (r.cartItemId === row.cartItemId ? { ...r, qty } : r)));
    } catch {
      this.actionError.set('Menge konnte nicht aktualisiert werden. Bitte erneut versuchen.');
      this.patchRow(row.cartItemId, {});
    }
  }

  onQtyBlur(row: CartRow): void {
    if (this.invalidQtyInput.delete(row.cartItemId)) this.patchRow(row.cartItemId, {});
  }

  async removeItem(row: CartRow): Promise<void> {
    this.actionError.set(null);
    try {
      await this.cartService.removeItem(row.cartItemId);
      this.rows.set(this.rows().filter((r) => r.cartItemId !== row.cartItemId));
    } catch {
      this.actionError.set('Position konnte nicht entfernt werden. Bitte erneut versuchen.');
    }
  }

  /** Zeile ersetzen und neu aufbauen (rev+1), damit das Mengenfeld den gespeicherten Wert zeigt. */
  private patchRow(cartItemId: string, patch: Partial<CartRow>): void {
    this.rows.set(this.rows().map((r) => (r.cartItemId === cartItemId ? { ...r, ...patch, rev: r.rev + 1 } : r)));
  }

  goToCheckout(): void {
    this.router.navigate([this.pricing.checkoutPath()]);
  }

  continueBrowsing(): void {
    this.router.navigate(['/katalog']);
  }
}
