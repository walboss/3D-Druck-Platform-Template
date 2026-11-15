import { catalogQueryParams, parseCatalogQuery } from './catalog-query.util';

const params = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });

describe('catalog-query', () => {
  it('liest Suche, Kategorien und gültige Sortierung', () => {
    expect(parseCatalogQuery(params({ q: 'hirsch', kategorie: 'Herbst,winter', sort: 'popular' }))).toEqual({
      q: 'hirsch',
      categories: ['herbst', 'winter'],
      sort: 'popular',
    });
  });

  it('ignoriert unbekannte Sortierung und leere Werte', () => {
    expect(parseCatalogQuery(params({ sort: 'quatsch' }))).toEqual({});
  });

  it('schreibt nur Abweichungen vom Standard', () => {
    expect(catalogQueryParams({ q: ' ', categories: [], sort: 'newest' })).toEqual({ q: null, kategorie: null, sort: null });
    expect(catalogQueryParams({ q: 'pilz', categories: ['herbst'], sort: 'price_asc' })).toEqual({
      q: 'pilz',
      kategorie: 'herbst',
      sort: 'price_asc',
    });
  });
});
