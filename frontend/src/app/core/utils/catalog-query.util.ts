import { CatalogSortOption } from '../services/catalog-state.service';

/** Katalog-Filter ⇄ Adresszeile (Review B20): teilbar und nach Neuladen erhalten. */
export interface CatalogQuery {
  q: string;
  categories: string[];
  sort: CatalogSortOption;
}

const SORTS: CatalogSortOption[] = ['price_asc', 'price_desc', 'newest', 'popular'];

export function parseCatalogQuery(params: { get(name: string): string | null }): Partial<CatalogQuery> {
  const out: Partial<CatalogQuery> = {};
  const q = params.get('q');
  if (q) out.q = q;
  const cats = params.get('kategorie');
  if (cats) out.categories = cats.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  const sort = params.get('sort') as CatalogSortOption | null;
  if (sort && SORTS.includes(sort)) out.sort = sort;
  return out;
}

export function catalogQueryParams(query: CatalogQuery): Record<string, string | null> {
  return {
    q: query.q.trim() || null,
    kategorie: query.categories.length > 0 ? query.categories.join(',') : null,
    sort: query.sort !== 'newest' ? query.sort : null,
  };
}
