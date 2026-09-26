// MakerWorld-Druckplatten → Produkte/Farbteile (Migration 00198).
// Eine Platte = 1 verkauftes Stück. Ein "Farbbereich" ist eine Kombination
// aus Platte und Filament-Slot; der Admin benennt die Bereiche, gleicher Name
// = gleiches Teil (Gramm/Druckzeit werden addiert).

export interface MakerworldPlateFilament {
  slot: string;
  type: string | null;
  color: string | null;
  usedG: number;
}

export interface MakerworldPlate {
  plateNo: number;
  printMinutes: number | null;
  weightG: number | null;
  imageUrl: string | null;
  filaments: MakerworldPlateFilament[];
}

// combined = ein einfarbiges Produkt (Summe wie bisher)
// parts    = ein Produkt mit Farbteilen
// perPlate = je Platte ein eigenes Produkt (Massenimport)
// onePlate = nur eine ausgewählte Platte (Produkt-Editor)
export type PlateMode = 'combined' | 'parts' | 'perPlate' | 'onePlate';

export interface ColorArea {
  key: string;
  plateNo: number;
  slot: string;
  color: string | null;
  type: string | null;
  usedG: number;
  printMinutes: number;
}

export interface PlateMappingState {
  mode: PlateMode;
  areaNames: Record<string, string>;
  plateNames: Record<number, string>;
  selectedPlate: number | null;
}

export interface PlannedPart {
  name: string;
  weightG: number;
  printTimeMin: number;
}

export interface PlannedProduct {
  plateNo: number | null;
  name: string;
  weightG: number;
  printTimeMin: number;
  imageUrl: string | null;
  parts: PlannedPart[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

// Farbbereiche je Platte. Ohne Filamentangaben zählt die ganze Platte als
// ein Bereich. Die Plattenzeit wird nach Gramm auf die Bereiche verteilt.
export function colorAreas(plates: MakerworldPlate[]): ColorArea[] {
  const areas: ColorArea[] = [];
  for (const plate of plates) {
    const minutes = plate.printMinutes ?? 0;
    const fils = plate.filaments.length > 0
      ? plate.filaments
      : [{ slot: '-', type: null, color: null, usedG: plate.weightG ?? 0 }];
    const total = fils.reduce((sum, f) => sum + f.usedG, 0);
    for (const f of fils) {
      areas.push({
        key: `${plate.plateNo}:${f.slot}`,
        plateNo: plate.plateNo,
        slot: f.slot,
        color: f.color,
        type: f.type,
        usedG: f.usedG,
        printMinutes: total > 0 ? (minutes * f.usedG) / total : minutes / fils.length,
      });
    }
  }
  return areas;
}

// Lohnt sich die Aufteilung überhaupt (mehr als eine Platte oder Farbe)?
export function hasPlateChoice(plates: MakerworldPlate[]): boolean {
  return colorAreas(plates).length > 1;
}

export function defaultMappingState(plates: MakerworldPlate[], baseName: string): PlateMappingState {
  const areas = colorAreas(plates);
  const multiPlate = plates.length > 1;
  const areaNames: Record<string, string> = {};
  for (const area of areas) {
    const onPlate = areas.filter((a) => a.plateNo === area.plateNo);
    const idx = onPlate.indexOf(area) + 1;
    areaNames[area.key] = onPlate.length === 1
      ? `Platte ${area.plateNo}`
      : multiPlate ? `Platte ${area.plateNo} · Farbe ${idx}` : `Farbe ${idx}`;
  }
  const plateNames: Record<number, string> = {};
  for (const plate of plates) {
    plateNames[plate.plateNo] = `${baseName} – Platte ${plate.plateNo}`.trim();
  }
  return {
    mode: areas.length > 1 ? 'parts' : 'combined',
    areaNames,
    plateNames,
    selectedPlate: plates[0]?.plateNo ?? null,
  };
}

function mergeParts(areas: ColorArea[], names: Record<string, string>): PlannedPart[] {
  const byName = new Map<string, PlannedPart>();
  for (const area of areas) {
    const name = (names[area.key] ?? '').trim();
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.weightG += area.usedG;
      existing.printTimeMin += area.printMinutes;
    } else {
      byName.set(key, { name, weightG: area.usedG, printTimeMin: area.printMinutes });
    }
  }
  const parts = Array.from(byName.values()).map((p) => ({
    ...p,
    weightG: round1(p.weightG),
    printTimeMin: Math.max(1, Math.round(p.printTimeMin)),
  }));
  // Nur ein Teil = einfarbig
  return parts.length >= 2 ? parts : [];
}

function sumPlates(plates: MakerworldPlate[]): { weightG: number; printTimeMin: number } {
  return {
    weightG: round1(plates.reduce((s, p) => s + (p.weightG ?? 0), 0)),
    printTimeMin: plates.reduce((s, p) => s + (p.printMinutes ?? 0), 0),
  };
}

// Ergebnis der Zuordnung: welche Produkte (mit welchen Teilen) angelegt werden.
// fallback = Summenwerte des Modells, falls keine Platten geliefert wurden.
export function planProducts(
  state: PlateMappingState,
  baseName: string,
  plates: MakerworldPlate[],
  fallback: { weightG: number | null; printTimeMin: number | null; imageUrl: string | null },
): PlannedProduct[] {
  const areas = colorAreas(plates);
  if (plates.length === 0 || state.mode === 'combined') {
    const sum = plates.length > 0 ? sumPlates(plates) : { weightG: fallback.weightG ?? 0, printTimeMin: fallback.printTimeMin ?? 0 };
    return [{ plateNo: null, name: baseName.trim(), ...sum, imageUrl: fallback.imageUrl, parts: [] }];
  }
  if (state.mode === 'parts') {
    return [{ plateNo: null, name: baseName.trim(), ...sumPlates(plates), imageUrl: fallback.imageUrl, parts: mergeParts(areas, state.areaNames) }];
  }
  const selected = state.mode === 'onePlate'
    ? plates.filter((p) => p.plateNo === state.selectedPlate)
    : plates;
  return selected.map((plate) => ({
    plateNo: plate.plateNo,
    name: state.mode === 'onePlate' ? baseName.trim() : (state.plateNames[plate.plateNo] ?? '').trim(),
    ...sumPlates([plate]),
    imageUrl: plate.imageUrl ?? fallback.imageUrl,
    parts: mergeParts(areas.filter((a) => a.plateNo === plate.plateNo), state.areaNames),
  }));
}

// Fehlertext für die Anzeige, null = alles ausgefüllt.
export function planError(products: PlannedProduct[]): string | null {
  if (products.length === 0) return 'Keine Platte ausgewählt.';
  if (products.some((p) => !p.name)) return 'Bitte für jedes Produkt einen Namen vergeben.';
  if (products.some((p) => p.parts.some((part) => !part.name))) return 'Bitte jedem Farbbereich einen Teil-Namen geben.';
  return null;
}

export function formatMinutes(min: number | null): string {
  if (min === null) return '–';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}
