import { Injectable, inject } from '@angular/core';

import { CartService } from './cart.service';
import { StockOptionsService } from './stock-options.service';
import { SupabaseClientService } from './supabase-client.service';
import { formatConfigurationLabel, parseConfigurationDraft } from '../utils/cart-configuration.util';

/** Eine Warenkorb-Zeile mit Preis und lesbarer Farbangabe. */
export interface CartDetailRow {
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

/**
 * Lädt den Warenkorb mit Preisen (v_catalog), Farb-/Finish- und Teilnamen —
 * gemeinsam für Warenkorb und Kasse (Review D28, vorher ~60 Zeilen doppelt).
 */
@Injectable({ providedIn: 'root' })
export class CartDetailsService {
  private readonly cartService = inject(CartService);
  private readonly stockOptions = inject(StockOptionsService);
  private readonly supabase = inject(SupabaseClientService);

  async load(): Promise<{ cartSessionId: string | null; rows: CartDetailRow[] }> {
    const [{ cartSessionId, items }] = await Promise.all([this.cartService.getCart(), this.stockOptions.load()]);
    if (items.length === 0) return { cartSessionId, rows: [] };

    const variantIds = Array.from(new Set(items.map((i) => i.variant.id)));
    const drafts = items.map((i) => ({ productId: i.product.id, entries: parseConfigurationDraft(i.configuration_draft) }));
    const productIdsWithParts = Array.from(
      new Set(drafts.filter((d) => d.entries.some((e) => e.product_part_id !== null)).map((d) => d.productId)),
    );

    const [prices, parts] = await Promise.all([
      this.supabase.client.from('v_catalog').select('variant_id, final_price').in('variant_id', variantIds),
      productIdsWithParts.length > 0
        ? this.supabase.client.from('product_parts').select('id, name').in('product_id', productIdsWithParts)
        : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    ]);
    if (prices.error) throw prices.error;
    if (parts.error) throw parts.error;

    const priceByVariant = new Map((prices.data ?? []).map((r) => [r['variant_id'] as string, r['final_price'] as number | null]));
    const partNameById = new Map((parts.data ?? []).map((p) => [p['id'] as string, p['name'] as string]));
    const colorNameById = new Map(this.stockOptions.colors().map((c) => [c.id, c.name]));
    const finishNameById = new Map(this.stockOptions.finishes().map((f) => [f.id, f.name]));

    const rows = items.map((i, idx) => ({
      cartItemId: i.cart_item_id,
      productId: i.product.id,
      variantId: i.variant.id,
      productName: i.product.name,
      sizeLabel: i.variant.size_label,
      configLabel: formatConfigurationLabel(drafts[idx].entries, colorNameById, finishNameById, partNameById),
      images: (i.product.images as { url: string }[]) ?? [],
      qty: i.qty,
      minQty: i.variant.min_qty,
      maxQty: i.variant.max_qty,
      stepQty: i.variant.step_qty,
      finalPrice: priceByVariant.get(i.variant.id) ?? null,
    }));
    return { cartSessionId, rows };
  }
}
