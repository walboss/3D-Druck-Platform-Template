import {
  MakerworldPlate,
  PlateMappingState,
  colorAreas,
  defaultMappingState,
  effectiveAreas,
  formatMinutes,
  makerworldViewerUrl,
  multicolorPlateNos,
  applyPlateAnalysis,
  plateAnalysisHint,
  plateLabel,
  hasPlateChoice,
  planError,
  planProducts,
} from './makerworld-plates.util';

const plates: MakerworldPlate[] = [
  {
    plateNo: 1,
    printMinutes: 60,
    weightG: 10,
    imageUrl: 'https://x/1.png',
    filaments: [
      { slot: '1', type: 'PLA', color: '#FF0000', usedG: 6 },
      { slot: '2', type: 'PLA', color: '#FFFFFF', usedG: 4 },
    ],
  },
  { plateNo: 2, printMinutes: 30, weightG: 5, imageUrl: null, filaments: [] },
];
const noFallback = { weightG: null, printTimeMin: null, imageUrl: null };

describe('makerworld-plates.util', () => {
  it('verteilt die Plattenzeit nach Gramm auf die Farbbereiche', () => {
    const areas = colorAreas(plates);
    expect(areas.map((a) => [a.key, a.printMinutes])).toEqual([['1:1', 36], ['1:2', 24], ['2:-', 30]]);
  });

  it('erkennt, ob eine Aufteilung sinnvoll ist', () => {
    expect(hasPlateChoice(plates)).toBe(true);
    expect(hasPlateChoice([plates[1]])).toBe(false);
  });

  it('vergibt Standardnamen und wählt Modus parts bei mehreren Bereichen', () => {
    const state = defaultMappingState(plates, 'Hund');
    expect(state.mode).toBe('parts');
    expect(state.areaNames).toEqual({ '1:1': 'Platte 1 · Farbe 1', '1:2': 'Platte 1 · Farbe 2', '2:-': 'Platte 2' });
    expect(state.plateNames[1]).toBe('Hund – Platte 1');
    expect(state.selectedPlate).toBe(1);
  });

  it('combined: Summe über alle Platten', () => {
    const state: PlateMappingState = { mode: 'combined', areaNames: {}, plateNames: {}, selectedPlate: null };
    expect(planProducts(state, ' Hund ', plates, noFallback)).toEqual([
      { plateNo: null, name: 'Hund', weightG: 15, printTimeMin: 90, imageUrl: null, parts: [] },
    ]);
  });

  it('combined ohne Platten: Fallback-Werte', () => {
    const state: PlateMappingState = { mode: 'combined', areaNames: {}, plateNames: {}, selectedPlate: null };
    const [p] = planProducts(state, 'Hund', [], { weightG: 12, printTimeMin: 40, imageUrl: 'u' });
    expect([p.weightG, p.printTimeMin, p.imageUrl]).toEqual([12, 40, 'u']);
  });

  it('parts: gleiche Namen werden addiert', () => {
    const state: PlateMappingState = {
      mode: 'parts',
      areaNames: { '1:1': 'Kopf', '1:2': 'Sockel', '2:-': 'kopf' },
      plateNames: {},
      selectedPlate: null,
    };
    const [p] = planProducts(state, 'Hund', plates, noFallback);
    expect(p.parts).toEqual([
      { name: 'Kopf', weightG: 11, printTimeMin: 66 },
      { name: 'Sockel', weightG: 4, printTimeMin: 24 },
    ]);
  });

  it('perPlate und onePlate', () => {
    const base = defaultMappingState(plates, 'Hund');
    expect(planProducts({ ...base, mode: 'perPlate' }, 'Hund', plates, noFallback).map((p) => p.plateNo)).toEqual([1, 2]);
    const one = planProducts({ ...base, mode: 'onePlate', selectedPlate: 2 }, 'Hund', plates, noFallback);
    expect(one.map((p) => [p.plateNo, p.name])).toEqual([[2, 'Hund']]);
  });

  it('planError meldet fehlende Angaben', () => {
    expect(planError([])).toBe('Keine Platte ausgewählt.');
    expect(planError([{ plateNo: null, name: '', weightG: 1, printTimeMin: 1, imageUrl: null, parts: [] }])).toContain('Namen');
    expect(
      planError([{ plateNo: null, name: 'A', weightG: 1, printTimeMin: 1, imageUrl: null, parts: [{ name: '', weightG: 1, printTimeMin: 1 }] }]),
    ).toContain('Teil-Namen');
    expect(planError([{ plateNo: null, name: 'A', weightG: 1, printTimeMin: 1, imageUrl: null, parts: [] }])).toBeNull();
  });

  it('formatiert Minuten', () => {
    expect(formatMinutes(null)).toBe('–');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(125)).toBe('2 h 5 min');
  });

  it('entfernte Farbe geht an die größte Farbe derselben Platte', () => {
    const areas = effectiveAreas(plates, ['1:2']);
    expect(areas.map((a) => [a.key, a.usedG, a.printMinutes])).toEqual([['1:1', 10, 60], ['2:-', 5, 30]]);
  });

  it('letzte Farbe einer Platte bleibt erhalten', () => {
    expect(effectiveAreas(plates, ['2:-']).map((a) => a.key)).toEqual(['1:1', '1:2', '2:-']);
  });

  it('nach dem Entfernen wird eine zweifarbige Platte einfarbig', () => {
    const state: PlateMappingState = {
      mode: 'onePlate',
      areaNames: { '1:1': 'Körper', '1:2': 'Augen' },
      plateNames: {},
      selectedPlate: 1,
      removedAreas: ['1:2'],
    };
    const [product] = planProducts(state, 'Elch', plates, noFallback);
    expect(product.weightG).toBe(10);
    expect(product.parts).toEqual([]);
  });

  it('baut den Link zur 3D-Ansicht', () => {
    expect(makerworldViewerUrl('https://makerworld.com/de/models/1#x', 42)).toBe('https://makerworld.com/de/models/1#profileId-42');
    expect(makerworldViewerUrl('https://makerworld.com/de/models/1', null)).toBe('https://makerworld.com/de/models/1');
    expect(makerworldViewerUrl(null, 42)).toBeNull();
  });

  it('nutzt übersetzte Plattennamen als Teil- und Produktnamen', () => {
    const named: MakerworldPlate[] = [
      { ...plates[0], name: 'Body & Face', nameDe: 'Körper & Gesicht' },
      { ...plates[1], name: 'Nose', nameDe: null },
    ];
    const state = defaultMappingState(named, 'Schneemann');
    expect(state.areaNames).toEqual({
      '1:1': 'Körper & Gesicht · Farbe 1',
      '1:2': 'Körper & Gesicht · Farbe 2',
      '2:-': 'Nose',
    });
    expect(state.plateNames[1]).toBe('Schneemann – Körper & Gesicht');
    expect(plateLabel({ ...plates[1], name: '  ', nameDe: '' })).toBeNull();
  });

  it('erkennt Mehrfarbdruck nur bei mehreren Filamenten auf einer Platte', () => {
    expect(multicolorPlateNos(plates)).toEqual([1]);
    expect(multicolorPlateNos(plates, ['1:2'])).toEqual([]);
    expect(multicolorPlateNos([plates[1]])).toEqual([]);
  });

  it('plant Varianten aus Platten-Gruppen (Pinguin)', () => {
    const peng: MakerworldPlate[] = [
      { plateNo: 1, printMinutes: 216, weightG: 76, imageUrl: null, filaments: [] },
      { plateNo: 2, printMinutes: 202, weightG: 63, imageUrl: null, filaments: [] },
      { plateNo: 3, printMinutes: 76, weightG: 23, imageUrl: null, filaments: [] },
    ];
    const state: PlateMappingState = {
      mode: 'variants',
      areaNames: { '1:-': 'Komplett', '2:-': 'Außen', '3:-': 'Bauch' },
      plateNames: {},
      selectedPlate: null,
      variantGroups: [
        { name: 'Einteilig', plateNos: [1] },
        { name: 'Zweifarbig', plateNos: [2, 3] },
      ],
    };
    const [product] = planProducts(state, 'Pinguin', peng, noFallback);
    expect(product.variants).toEqual([
      { sizeLabel: 'Einteilig', parts: [{ name: 'Komplett', weightG: 76, printTimeMin: 216 }] },
      {
        sizeLabel: 'Zweifarbig',
        parts: [
          { name: 'Außen', weightG: 63, printTimeMin: 202 },
          { name: 'Bauch', weightG: 23, printTimeMin: 76 },
        ],
      },
    ]);
    expect(planError([product])).toBeNull();
    expect(planError([{ ...product, variants: [{ sizeLabel: 'A', parts: [] }] }])).toContain('mindestens eine Platte');
  });

  it('übernimmt den KI-Vorschlag nur mit bekannten Platten', () => {
    const base = defaultMappingState(plates, 'Hund');
    const next = applyPlateAnalysis(base, plates, {
      mode: 'variants',
      confident: true,
      reason: 'Alternativen',
      partNames: { '2': 'Sockel' },
      variants: [
        { name: 'A', plateNos: [1] },
        { name: 'B', plateNos: [2, 9] },
      ],
    }, true);
    expect(next.mode).toBe('variants');
    expect(next.variantGroups).toEqual([{ name: 'A', plateNos: [1] }, { name: 'B', plateNos: [2] }]);
    expect(next.areaNames['2:-']).toBe('Sockel');
    const named = applyPlateAnalysis(base, plates, { mode: 'parts', confident: true, reason: '', partNames: { '1': 'Kürbis' }, variants: [] }, true);
    expect([named.areaNames['1:1'], named.areaNames['1:2']]).toEqual(['Kürbis · Farbe 1', 'Kürbis · Farbe 2']);
    // im Editor ohne Varianten bleibt der Modus
    expect(applyPlateAnalysis(base, plates, { mode: 'variants', confident: true, reason: '', partNames: {}, variants: [{ name: 'A', plateNos: [1] }, { name: 'B', plateNos: [2] }] }, false).mode).toBe(base.mode);
    expect(plateAnalysisHint({ mode: 'parts', confident: false, reason: 'Körper und Geweih', partNames: {}, variants: [] }, true)).toBe(
      'KI-Vorschlag: Teile eines Stücks – Körper und Geweih (unsicher, bitte prüfen)',
    );
  });
});
