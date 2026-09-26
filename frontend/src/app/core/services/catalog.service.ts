import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { CatalogProduct, ProductImage, VCatalogRow } from '../models/db-types';
import { CategorySeason } from '../utils/season.util';

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
    const [{ data: rows, error: catalogError }, { data: productMeta, error: metaError }] = await Promise.all([
      this.supabase.client.from('v_catalog').select('*'),
      this.supabase.client.from('products').select('id, created_at').eq('active', true),
    ]);

    if (catalogError) throw catalogError;
    if (metaError) throw metaError;

    const createdAtByProduct = new Map<string, string>();
    for (const p of productMeta ?? []) {
      createdAtByProduct.set(p['id'], p['created_at']);
    }

    const byProduct = new Map<string, CatalogProduct>();
    for (const row of (rows ?? []) as VCatalogRow[]) {
      let product = byProduct.get(row.product_id);
      if (!product) {
        product = {
          product_id: row.product_id,
          name: row.name,
          description: row.description,
          category: row.category,
          tags: row.tags ?? [],
          images: (row.images ?? []) as ProductImage[],
          created_at: createdAtByProduct.get(row.product_id),
          variants: [],
          minPrice: null,
          hasMultiplePrices: false,
          likesCount: 0,
          likedByMe: false,
        };
        byProduct.set(row.product_id, product);
      }
      product.variants.push(row);
    }

    for (const product of byProduct.values()) {
      const prices = product.variants.map((v) => v.final_price).filter((p): p is number => p !== null);
      product.minPrice = prices.length > 0 ? Math.min(...prices) : null;
      product.hasMultiplePrices = product.variants.length > 1;
    }

    return Array.from(byProduct.values());
  }

  async getProductDetail(productId: string): Promise<{
    product: CatalogProduct;
    parts: { id: string; product_id: string; name: string; sort_order: number }[];
    isMulticolor: boolean;
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
      hasMultiplePrices: rows.length > 1,
      likesCount: 0,
      likedByMe: false,
    };

    return {
      product,
      parts: parts ?? [],
      isMulticolor: !!productRow?.['is_multicolor'],
    };
  }
}
