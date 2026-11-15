import { hasDifferentPrices } from './price-prefix.util';

describe('hasDifferentPrices', () => {
  it('false bei gleichen Preisen oder nur einer Variante', () => {
    expect(hasDifferentPrices([{ final_price: 5 }, { final_price: 5 }])).toBe(false);
    expect(hasDifferentPrices([{ final_price: 5 }])).toBe(false);
    expect(hasDifferentPrices([{ final_price: null }, { final_price: 5 }])).toBe(false);
  });

  it('true bei verschiedenen Preisen', () => {
    expect(hasDifferentPrices([{ final_price: 5 }, { final_price: 7.5 }])).toBe(true);
  });
});
