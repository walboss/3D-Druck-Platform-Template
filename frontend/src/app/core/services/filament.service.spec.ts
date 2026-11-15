import { disambiguateSpoolLabels } from './filament.service';

describe('disambiguateSpoolLabels', () => {
  it('nummeriert gleiche Spulen nach Kaufdatum und hängt das Datum an', () => {
    const out = disambiguateSpoolLabels([
      { label: 'Bambu PLA Matte (PLA, Weiß)', purchaseDate: '2026-10-03' },
      { label: 'Bambu PLA Basic (PLA, Rot)', purchaseDate: '2026-09-01' },
      { label: 'Bambu PLA Matte (PLA, Weiß)', purchaseDate: '2026-08-15' },
    ]);
    expect(out.map((s) => s.label)).toEqual([
      'Bambu PLA Matte (PLA, Weiß) – Spule 2, gekauft 03.10.2026',
      'Bambu PLA Basic (PLA, Rot)',
      'Bambu PLA Matte (PLA, Weiß) – Spule 1, gekauft 15.08.2026',
    ]);
  });

  it('ohne Kaufdatum nur die Nummer', () => {
    const out = disambiguateSpoolLabels([{ label: 'X' }, { label: 'X' }]);
    expect(out.map((s) => s.label)).toEqual(['X – Spule 1', 'X – Spule 2']);
  });
});
