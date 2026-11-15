import { parseQtyInput } from './qty-input.util';

describe('parseQtyInput', () => {
  it('lässt ganze Zahlen ab 1 durch', () => {
    expect(parseQtyInput(1)).toBe(1);
    expect(parseQtyInput(12)).toBe(12);
  });

  it('verwirft leeres Feld', () => {
    expect(parseQtyInput(null)).toBeNull();
    expect(parseQtyInput(undefined)).toBeNull();
    expect(parseQtyInput('')).toBeNull();
  });

  it('verwirft 0, negative Werte, Bruchzahlen und NaN', () => {
    expect(parseQtyInput(0)).toBeNull();
    expect(parseQtyInput(-2)).toBeNull();
    expect(parseQtyInput(1.5)).toBeNull();
    expect(parseQtyInput(Number.NaN)).toBeNull();
  });
});
