import { Injectable, signal } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';

const CART_TOKEN_KEY = 'cart_session_token';

export interface RawCartItem {
  cart_item_id: string;
  qty: number;
  configuration_draft: unknown;
  product: { id: string; name: string; images: unknown; is_multicolor: boolean };
  variant: { id: string; size_label: string; min_qty: number; max_qty: number; step_qty: number };
}

@Injectable({ providedIn: 'root' })
export class CartService {
  readonly itemCount = signal(0);

  constructor(private readonly supabase: SupabaseClientService) {}

  private getToken(): string {
    let token = localStorage.getItem(CART_TOKEN_KEY);
    if (!token) {
      token = crypto.randomUUID();
      localStorage.setItem(CART_TOKEN_KEY, token);
    }
    return token;
  }

  async getCart(): Promise<{ cartSessionId: string | null; items: RawCartItem[] }> {
    const { data, error } = await this.supabase.client.rpc('fn_cart_get', {
      p_session_token: this.getToken(),
    });
    if (error) throw error;
    const result = data as { cart_session_id: string | null; items: RawCartItem[] };
    this.itemCount.set(result.items?.length ?? 0);
    return { cartSessionId: result.cart_session_id, items: result.items ?? [] };
  }

  async addItem(
    productId: string,
    variantId: string,
    configurationDraft: unknown,
    qty: number,
  ): Promise<string> {
    const { data, error } = await this.supabase.client.rpc('fn_cart_add_item', {
      p_session_token: this.getToken(),
      p_product_id: productId,
      p_variant_id: variantId,
      p_configuration_draft: configurationDraft,
      p_qty: qty,
    });
    if (error) throw error;
    await this.getCart();
    return data as string;
  }

  async updateItemQty(cartItemId: string, qty: number): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_cart_update_item', {
      p_session_token: this.getToken(),
      p_cart_item_id: cartItemId,
      p_qty: qty,
    });
    if (error) throw error;
    await this.getCart();
  }

  async removeItem(cartItemId: string): Promise<void> {
    await this.updateItemQty(cartItemId, 0);
  }

  getSessionToken(): string {
    return this.getToken();
  }

  clearLocalSession(): void {
    localStorage.removeItem(CART_TOKEN_KEY);
    this.itemCount.set(0);
  }
}
