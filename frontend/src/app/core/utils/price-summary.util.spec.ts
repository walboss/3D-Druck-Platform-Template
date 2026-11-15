import { priceSummary, unpricedHint } from './price-summary.util';

describe('priceSummary', () => {
  it('summiert nur Positionen mit Preis und zählt die ohne', () => {
    expect(
      priceSummary([
        { finalPrice: 9.99, qty: 2 },
        { finalPrice: null, qty: 3 },
        { finalPrice: 1.5, qty: 1 },
      ]),
    ).toEqual({ total: 21.48, unpricedCount: 1 });
  });

  it('ohne fehlende Preise ist unpricedCount 0', () => {
    expect(priceSummary([{ finalPrice: 5, qty: 1 }]).unpricedCount).toBe(0);
  });
});

describe('unpricedHint', () => {
  it('Einzahl und Mehrzahl', () => {
    expect(unpricedHint(1)).toBe('+ 1 Position, deren Preis wir dir noch mitteilen');
    expect(unpricedHint(3)).toBe('+ 3 Positionen, deren Preis wir dir noch mitteilen');
  });
});
