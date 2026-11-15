import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { VisitorService } from './visitor.service';
import { CatalogProduct, VCatalogRow } from '../models/db-types';
import { groupCatalogRows } from '../utils/catalog-group.util';

// Spec like-system.md §4/§5a: Toggle + eigene Likes, immer unabhängig vom
// Privatmodus nutzbar (kein Account nötig).
@Injectable({ providedIn: 'root' })
export class LikesService {
  constructor(
    private readonly supabase: SupabaseClientService,
    private readonly visitor: VisitorService,
  ) {}

  /** Like-Zähler; mit productIds nur für diese Produkte (Review D29). */
  async getCounts(productIds?: string[]): Promise<Map<string, number>> {
    if (productIds && productIds.length === 0) return new Map();
    let query = this.supabase.client.from('v_product_like_counts').select('product_id, likes_count');
    if (productIds) query = query.in('product_id', productIds);
    const { data, error } = await query;
    if (error) throw error;
    const map = new Map<string, number>();
    for (const row of data ?? []) {
      map.set(row['product_id'] as string, row['likes_count'] as number);
    }
    return map;
  }

  async getMyLikedIds(): Promise<Set<string>> {
    const { data, error } = await this.supabase.client.rpc('fn_get_my_liked_product_ids', {
      p_visitor_token: this.visitor.getToken(),
    });
    if (error) throw error;
    return new Set((data ?? []) as string[]);
  }

  // Schreibt likesCount/likedByMe direkt in die übergebenen Produkte (mutiert
  // absichtlich, damit Aufrufer nur den Signal-Wert neu zuweisen müssen).
  applyLikeState(products: CatalogProduct[], counts: Map<string, number>, likedIds: Set<string>): void {
    for (const product of products) {
      product.likesCount = counts.get(product.product_id) ?? 0;
      product.likedByMe = likedIds.has(product.product_id);
    }
  }

  async toggle(productId: string): Promise<{ likesCount: number; liked: boolean }> {
    const { data, error } = await this.supabase.client.rpc('fn_toggle_like', {
      p_product_id: productId,
      p_visitor_token: this.visitor.getToken(),
    });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as { likes_count: number; liked: boolean };
    return { likesCount: row.likes_count, liked: row.liked };
  }

  async getLikedProducts(): Promise<CatalogProduct[]> {
    const { data, error } = await this.supabase.client.rpc('fn_get_liked_products', {
      p_visitor_token: this.visitor.getToken(),
    });
    if (error) throw error;
    return groupCatalogRows((data ?? []) as VCatalogRow[], true);
  }
}
