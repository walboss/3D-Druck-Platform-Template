import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';

import { CartService, RawCartItem } from '../../../core/services/cart.service';
import { SupabaseClientService } from '../../../core/services/supabase-client.service';
import { PricingService } from '../../../core/services/pricing.service';
import { StockOptionsService } from '../../../core/services/stock-options.service';
import { parseConfigurationDraft, formatConfigurationLabel } from '../../../core/utils/cart-configuration.util';

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
}

@Component({
  selector: 'app-cart-view',
  standalone: true,
  imports: [CurrencyPipe, FormsModule, RouterLink, ButtonModule, InputNumberModule, MessageModule, SkeletonModule],
  templateUrl: './cart-view.html',
  styleUrl: './cart-view.scss',
})
export class CartView implements OnInit {
  private readonly pricing = inject(PricingService);
  readonly showPrices = this.pricing.showPrices;
  readonly qtyInvalidLabel = this.pricing.qtyInvalidLabel;
  readonly listLabel = this.pricing.listLabel;
  readonly checkoutLabel = this.pricing.checkoutLabel;
  readonly continueBrowsingLabel = this.pricing.continueBrowsingLabel;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly rows = signal<CartRow[]>([]);

  readonly total = computed(() =>
    this.rows().reduce((sum, r) => sum + (r.finalPrice ?? 0) * r.qty, 0),
  );

  readonly hasUnpricedItems = computed(() => this.rows().some((r) => r.finalPrice === null));

  isQtyInvalid(row: CartRow): boolean {
    return (
      row.qty < row.minQty || row.qty > row.maxQty || (row.qty - row.minQty) % row.stepQty !== 0
    );
  }

  constructor(
    private readonly cartService: CartService,
    private readonly supabase: SupabaseClientService,
    private readonly router: Router,
    private readonly stockOptions: StockOptionsService,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [{ items }] = await Promise.all([this.cartService.getCart(), this.stockOptions.load()]);
      const variantIds = Array.from(new Set(items.map((i) => i.variant.id)));

      let priceByVariant = new Map<string, number | null>();
      if (variantIds.length > 0) {
        const { data, error } = await this.supabase.client
          .from('v_catalog')
          .select('variant_id, final_price')
          .in('variant_id', variantIds);
        if (error) throw error;
        priceByVariant = new Map((data ?? []).map((r) => [r['variant_id'], r['final_price']]));
      }

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
        const { data, error } = await this.supabase.client
          .from('product_parts')
          .select('id, name')
          .in('product_id', productIdsWithParts);
        if (error) throw error;
        partNameById = new Map((data ?? []).map((p) => [p['id'], p['name']]));
      }

      this.rows.set(
        items.map((i: RawCartItem) => ({
          cartItemId: i.cart_item_id,
          productId: i.product.id,
          variantId: i.variant.id,
          productName: i.product.name,
          sizeLabel: i.variant.size_label,
          configLabel: formatConfigurationLabel(
            parseConfigurationDraft(i.configuration_draft),
            colorNameById,
            finishNameById,
            partNameById,
          ),
          images: (i.product.images as { url: string }[]) ?? [],
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

  async updateQty(row: CartRow, qty: number): Promise<void> {
    try {
      await this.cartService.updateItemQty(row.cartItemId, qty);
      row.qty = qty;
      this.rows.set([...this.rows()]);
    } catch {
      this.error.set('Menge konnte nicht aktualisiert werden.');
    }
  }

  async removeItem(row: CartRow): Promise<void> {
    try {
      await this.cartService.removeItem(row.cartItemId);
      this.rows.set(this.rows().filter((r) => r.cartItemId !== row.cartItemId));
    } catch {
      this.error.set('Position konnte nicht entfernt werden.');
    }
  }

  goToCheckout(): void {
    this.router.navigate([this.pricing.checkoutPath()]);
  }

  continueBrowsing(): void {
    this.router.navigate(['/katalog']);
  }
}
