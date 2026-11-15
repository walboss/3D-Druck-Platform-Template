import { CatalogProduct, ProductImage, VCatalogRow } from '../models/db-types';
import { hasDifferentPrices } from './price-prefix.util';

/**
 * v_catalog-Zeilen (eine je Variante) zu Produkten zusammenfassen — gemeinsam
 * für Katalog und Likes (Review D28, vorher doppelt). Reihenfolge = erste
 * Zeile je Produkt; minPrice/„ab“ aus den Variantenpreisen.
 */
export function groupCatalogRows(rows: VCatalogRow[], likedByMe = false): CatalogProduct[] {
  const byProduct = new Map<string, CatalogProduct>();
  for (const row of rows) {
    let product = byProduct.get(row.product_id);
    if (!product) {
      product = {
        product_id: row.product_id,
        name: row.name,
        description: row.description,
        category: row.category,
        tags: row.tags ?? [],
        images: (row.images ?? []) as ProductImage[],
        created_at: row.created_at,
        variants: [],
        minPrice: null,
        hasMultiplePrices: false,
        likesCount: 0,
        likedByMe,
      };
      byProduct.set(row.product_id, product);
    }
    product.variants.push(row);
  }
  for (const product of byProduct.values()) {
    const prices = product.variants.map((v) => v.final_price).filter((p): p is number => p !== null);
    product.minPrice = prices.length > 0 ? Math.min(...prices) : null;
    product.hasMultiplePrices = hasDifferentPrices(product.variants);
  }
  return Array.from(byProduct.values());
}
