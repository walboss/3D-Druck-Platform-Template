import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { CatalogProduct, ProductImage, VCatalogRow } from '../models/db-types';
import { CategorySeason } from '../utils/season.util';
import { hasDifferentPrices } from '../utils/price-prefix.util';
import { groupCatalogRows } from '../utils/catalog-group.util';

@Injectable({ providedIn: 'root' })
export class CatalogService {
  constructor(private readonly supabase: SupabaseClientService) {}

  // Saison-Kategorien (Migration 00187) — anon sieht nur aktive.
  async getCategorySeasons(): Promise<CategorySeason[]> {
    const { data, error } = await this.supabase.client
      .from('category_seasons')
      .select('id, category, start_month, start_day, end_month, end_day, active, banner_title, banner_text')
      .eq('active', true);
    if (error) throw error;
    return (data ?? []) as CategorySeason[];
  }

  async getCatalog(): Promise<CatalogProduct[]> {
    // created_at kommt seit 00205 aus v_catalog — ein Request statt zwei (Review D29)
    const { data: rows, error } = await this.supabase.client.from('v_catalog').select('*');
    if (error) throw error;
    return groupCatalogRows((rows ?? []) as VCatalogRow[]);
  }


  async getProductDetail(productId: string): Promise<{
    product: CatalogProduct;
    parts: { id: string; product_id: string; name: string; sort_order: number }[];
    isMulticolor: boolean;
    // Teile je Variante (variant_id -> product_part_ids); fehlt eine Variante,
    // gelten alle Teile des Produkts.
    partIdsByVariant: Record<string, string[]>;
  }> {
    const [
      { data: catalogRows, error: catalogError },
      { data: productRow, error: productError },
      { data: parts, error: partsError },
    ] = await Promise.all([
      this.supabase.client.from('v_catalog').select('*').eq('product_id', productId),
      this.supabase.client.from('products').select('id, is_multicolor').eq('id', productId).single(),
      this.supabase.client.from('product_parts').select('*').eq('product_id', productId).order('sort_order'),
    ]);

    if (catalogError) throw catalogError;
    if (productError) throw productError;
    if (partsError) throw partsError;

    const rows = (catalogRows ?? []) as VCatalogRow[];
    if (rows.length === 0) {
      throw new Error('Produkt nicht gefunden');
    }

    const first = rows[0];
    const product: CatalogProduct = {
      product_id: first.product_id,
      name: first.name,
      description: first.description,
      category: first.category,
      tags: first.tags ?? [],
      images: (first.images ?? []) as ProductImage[],
      variants: rows,
      minPrice: null,
      hasMultiplePrices: hasDifferentPrices(rows),
      likesCount: 0,
      likedByMe: false,
    };

    const variantIds = rows.map((r) => r.variant_id);
    const { data: variantParts, error: vpError } = await this.supabase.client
      .from('variant_parts')
      .select('variant_id, product_part_id')
      .in('variant_id', variantIds);
    if (vpError) throw vpError;
    const partIdsByVariant: Record<string, string[]> = {};
    for (const vp of variantParts ?? []) {
      (partIdsByVariant[vp['variant_id'] as string] ??= []).push(vp['product_part_id'] as string);
    }

    return {
      product,
      parts: parts ?? [],
      isMulticolor: !!productRow?.['is_multicolor'],
      partIdsByVariant,
    };
  }
}
