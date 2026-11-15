import { formatConfigurationLabel, parseConfigurationDraft } from './cart-configuration.util';

describe('cart-configuration.util', () => {
  it('filtert ungültige Einträge', () => {
    expect(parseConfigurationDraft('x')).toEqual([]);
    expect(
      parseConfigurationDraft([{ color_id: 'c', finish_id: 'f', product_part_id: null }, { color_id: 1 }, null]),
    ).toEqual([{ color_id: 'c', finish_id: 'f', product_part_id: null }]);
  });

  it('baut Beschriftung einfarbig und mehrfarbig', () => {
    const colors = new Map([['c1', 'Rot'], ['c2', 'Weiß']]);
    const finishes = new Map([['f1', 'Matt'], ['f2', 'Glänzend']]);
    const parts = new Map([['p1', 'Kopf']]);
    expect(formatConfigurationLabel([{ product_part_id: null, color_id: 'c1', finish_id: 'f1' }], colors, finishes, parts)).toBe('Rot / Matt');
    expect(
      formatConfigurationLabel(
        [
          { product_part_id: 'p1', color_id: 'c1', finish_id: 'f1' },
          { product_part_id: null, color_id: 'c2', finish_id: 'f2' },
        ],
        colors,
        finishes,
        parts,
      ),
    ).toBe('Kopf: Rot / Matt, Weiß / Glänzend');
    expect(formatConfigurationLabel([], colors, finishes, parts)).toBe('');
  });
});
