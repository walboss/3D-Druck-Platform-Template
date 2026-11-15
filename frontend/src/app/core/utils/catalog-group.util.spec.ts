import { VCatalogRow } from '../models/db-types';
import { groupCatalogRows } from './catalog-group.util';

const row = (product_id: string, variant_id: string, final_price: number | null): VCatalogRow => ({
  product_id,
  name: 'P' + product_id,
  description: null,
  category: 'Winter',
  tags: [],
  images: [],
  variant_id,
  size_label: 'Standard',
  min_qty: 1,
  max_qty: 10,
  step_qty: 1,
  final_price,
  created_at: '2026-11-15T00:00:00Z',
});

describe('groupCatalogRows', () => {
  it('fasst Varianten je Produkt zusammen und bestimmt den Mindestpreis', () => {
    const products = groupCatalogRows([row('1', 'a', 2.99), row('2', 'c', null), row('1', 'b', 1.99)]);
    expect(products.map((p) => [p.product_id, p.variants.length, p.minPrice, p.hasMultiplePrices])).toEqual([
      ['1', 2, 1.99, true],
      ['2', 1, null, false],
    ]);
    expect(products[0].created_at).toBe('2026-11-15T00:00:00Z');
  });

  it('setzt likedByMe für die Likes-Seite', () => {
    expect(groupCatalogRows([row('1', 'a', 1)], true)[0].likedByMe).toBe(true);
  });
});
