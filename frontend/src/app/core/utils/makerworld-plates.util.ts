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
  // Plattenname des Erstellers und deutsche Übersetzung (fehlt bei älterem Worker)
  name?: string | null;
  nameDe?: string | null;
}

// Anzeigename einer Platte: deutsche Übersetzung, sonst Original, sonst null.
export function plateLabel(plate: MakerworldPlate): string | null {
  return plate.nameDe?.trim() || plate.name?.trim() || null;
}

// combined = ein einfarbiges Produkt (Summe wie bisher)
// parts    = ein Produkt mit Farbteilen
// perPlate = je Platte ein eigenes Produkt (Massenimport)
// onePlate = nur eine ausgewählte Platte (Produkt-Editor)
// variants = ein Produkt, Platten-Gruppen als Varianten (Alternativen, 00204)
export type PlateMode = 'combined' | 'parts' | 'perPlate' | 'onePlate' | 'variants';

// Variante aus Platten (Pinguin „Einteilig“ = [1], „Zweifarbig“ = [2, 3])
export interface VariantGroup {
  name: string;
  plateNos: number[];
}

// KI-Einordnung der Platten (Worker, Entscheidung Betreiber 2026-11-15) — nur Vorschlag
export interface PlateAnalysis {
  mode: 'parts' | 'variants' | 'perPlate' | 'combined';
  confident: boolean;
  reason: string;
  partNames: Record<string, string>;
  variants: VariantGroup[];
}

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
  // Entfernte Farbbereiche (Keys): ihre Gramm/Zeit gehen an die größte
  // verbleibende Farbe derselben Platte (Wunsch des Betreibers, 2026-11-14).
  removedAreas?: string[];
  // 00204: Varianten aus Platten-Gruppen (Modus 'variants')
  variantGroups?: VariantGroup[];
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
  // 00204: gesetzt im Modus 'variants' — je Variante eigene Teile
  variants?: { sizeLabel: string; parts: PlannedPart[] }[];
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

// Farbbereiche nach dem Entfernen: Gramm und Zeit entfernter Bereiche werden
// der größten verbleibenden Farbe derselben Platte zugeschlagen. Die letzte
// Farbe einer Platte kann nicht entfernt werden (wird ignoriert).
export function effectiveAreas(plates: MakerworldPlate[], removed: readonly string[] = []): ColorArea[] {
  const areas = colorAreas(plates);
  const out: ColorArea[] = [];
  for (const plate of plates) {
    const onPlate = areas.filter((a) => a.plateNo === plate.plateNo);
    const kept = onPlate.filter((a) => !removed.includes(a.key));
    if (kept.length === 0 || kept.length === onPlate.length) {
      out.push(...onPlate.map((a) => ({ ...a })));
      continue;
    }
    const target = mergeTarget(onPlate, removed)!;
    for (const area of kept) {
      if (area.key !== target.key) {
        out.push({ ...area });
        continue;
      }
      const gone = onPlate.filter((a) => removed.includes(a.key));
      out.push({
        ...area,
        usedG: round1(area.usedG + gone.reduce((s, a) => s + a.usedG, 0)),
        printMinutes: area.printMinutes + gone.reduce((s, a) => s + a.printMinutes, 0),
      });
    }
  }
  return out;
}

// Größte verbleibende Farbe der Platte (bei Gleichstand die erste).
export function mergeTarget(onPlate: ColorArea[], removed: readonly string[]): ColorArea | null {
  const kept = onPlate.filter((a) => !removed.includes(a.key));
  return kept.reduce<ColorArea | null>((best, a) => (best === null || a.usedG > best.usedG ? a : best), null);
}

// Mehrfarbdruck (AMS): mindestens eine Platte druckt mehrere Filamente
// gleichzeitig. Getrennte Platten je Farbe zählen nicht (Entscheidung Betreiber
// 2026-11-15: solche Zeilen beim Import automatisch abwählen).
export function multicolorPlateNos(plates: MakerworldPlate[], removed: readonly string[] = []): number[] {
  return plates
    .filter((p) => p.filaments.filter((f) => !removed.includes(`${p.plateNo}:${f.slot}`)).length >= 2)
    .map((p) => p.plateNo);
}

// Lohnt sich die Aufteilung überhaupt (mehr als eine Platte oder Farbe)?
export function hasPlateChoice(plates: MakerworldPlate[]): boolean {
  return colorAreas(plates).length > 1;
}

export function defaultMappingState(plates: MakerworldPlate[], baseName: string): PlateMappingState {
  const areas = colorAreas(plates);
  const multiPlate = plates.length > 1;
  // Plattennamen von MakerWorld (übersetzt) als Vorschlag, sonst „Platte N“.
  const labels = new Map(plates.map((p) => [p.plateNo, plateLabel(p)]));
  const areaNames: Record<string, string> = {};
  for (const area of areas) {
    const onPlate = areas.filter((a) => a.plateNo === area.plateNo);
    const idx = onPlate.indexOf(area) + 1;
    const label = labels.get(area.plateNo) ?? null;
    const plateText = label ?? `Platte ${area.plateNo}`;
    areaNames[area.key] = onPlate.length === 1
      ? plateText
      : multiPlate || label ? `${plateText} · Farbe ${idx}` : `Farbe ${idx}`;
  }
  const plateNames: Record<number, string> = {};
  for (const plate of plates) {
    plateNames[plate.plateNo] = `${baseName} – ${labels.get(plate.plateNo) ?? `Platte ${plate.plateNo}`}`.trim();
  }
  return {
    mode: areas.length > 1 ? 'parts' : 'combined',
    areaNames,
    plateNames,
    selectedPlate: plates[0]?.plateNo ?? null,
  };
}

const ANALYSIS_LABELS: Record<PlateAnalysis['mode'], string> = {
  parts: 'Teile eines Stücks',
  variants: 'Varianten (Alternativen)',
  perPlate: 'je Platte ein Produkt',
  combined: 'einfarbig, alles zusammen',
};

/** Hinweistext zum KI-Vorschlag (null = keiner). */
export function plateAnalysisHint(analysis: PlateAnalysis | null | undefined, allowVariants: boolean): string | null {
  if (!analysis) return null;
  let text = `KI-Vorschlag: ${ANALYSIS_LABELS[analysis.mode] ?? analysis.mode}`;
  if (analysis.reason) text += ` – ${analysis.reason}`;
  if (!analysis.confident) text += ' (unsicher, bitte prüfen)';
  if (analysis.mode === 'variants' && !allowVariants) text += '. Varianten gehen nur im MakerWorld-Import.';
  return text;
}

// KI-Vorschlag auf den Standard-Zustand anwenden (nur bekannte Platten/Bereiche).
export function applyPlateAnalysis(
  state: PlateMappingState,
  plates: MakerworldPlate[],
  analysis: PlateAnalysis | null | undefined,
  allowVariants: boolean,
): PlateMappingState {
  if (!analysis) return state;
  const plateNos = new Set(plates.map((p) => p.plateNo));
  const areaNames = { ...state.areaNames };
  const allAreas = colorAreas(plates);
  for (const area of allAreas) {
    const name = analysis.partNames[String(area.plateNo)]?.trim();
    if (!name) continue;
    const onPlate = allAreas.filter((a) => a.plateNo === area.plateNo);
    areaNames[area.key] = onPlate.length === 1 ? name : `${name} · Farbe ${onPlate.indexOf(area) + 1}`;
  }
  let mode: PlateMode = state.mode;
  let variantGroups = state.variantGroups;
  if (analysis.mode === 'variants' && allowVariants) {
    const groups = analysis.variants
      .map((v) => ({ name: v.name.trim(), plateNos: v.plateNos.filter((n) => plateNos.has(n)) }))
      .filter((v) => v.name && v.plateNos.length > 0);
    if (groups.length >= 2) {
      mode = 'variants';
      variantGroups = groups;
    }
  } else if (analysis.mode === 'combined') {
    mode = 'combined';
  } else if (analysis.mode === 'parts') {
    mode = 'parts';
  } else if (analysis.mode === 'perPlate' && allowVariants) {
    mode = 'perPlate';
  }
  return { ...state, mode, areaNames, variantGroups };
}

function mergeParts(areas: ColorArea[], names: Record<string, string>): PlannedPart[] {
  const parts = mergeAllParts(areas, names);
  // Nur ein Teil = einfarbig
  return parts.length >= 2 ? parts : [];
}

// Wie mergeParts, aber auch ein einzelnes Teil bleibt (Varianten brauchen es).
function mergeAllParts(areas: ColorArea[], names: Record<string, string>): PlannedPart[] {
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
  return parts;
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
  const areas = effectiveAreas(plates, state.removedAreas ?? []);
  if (plates.length === 0 || state.mode === 'combined') {
    const sum = plates.length > 0 ? sumPlates(plates) : { weightG: fallback.weightG ?? 0, printTimeMin: fallback.printTimeMin ?? 0 };
    return [{ plateNo: null, name: baseName.trim(), ...sum, imageUrl: fallback.imageUrl, parts: [] }];
  }
  if (state.mode === 'variants') {
    const groups = state.variantGroups ?? [];
    const variants = groups.map((g) => ({
      sizeLabel: g.name.trim(),
      parts: mergeAllParts(areas.filter((a) => g.plateNos.includes(a.plateNo)), state.areaNames),
    }));
    const first = variants[0]?.parts ?? [];
    return [{
      plateNo: null,
      name: baseName.trim(),
      weightG: round1(first.reduce((s, p) => s + p.weightG, 0)),
      printTimeMin: first.reduce((s, p) => s + p.printTimeMin, 0),
      imageUrl: fallback.imageUrl,
      parts: [],
      variants,
    }];
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
  for (const p of products) {
    if (!p.variants) continue;
    if (p.variants.length === 0) return 'Bitte mindestens eine Variante anlegen.';
    if (p.variants.some((v) => !v.sizeLabel)) return 'Bitte jeder Variante einen Namen geben.';
    if (new Set(p.variants.map((v) => v.sizeLabel.toLowerCase())).size !== p.variants.length) {
      return 'Variantennamen müssen verschieden sein.';
    }
    if (p.variants.some((v) => v.parts.length === 0)) return 'Jede Variante braucht mindestens eine Platte.';
    if (p.variants.some((v) => v.parts.some((part) => !part.name))) return 'Bitte jedem Farbbereich einen Teil-Namen geben.';
  }
  return null;
}

export function formatMinutes(min: number | null): string {
  if (min === null) return '–';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

// Link zur 3D-Ansicht auf MakerWorld (Einbetten sperrt MakerWorld per
// X-Frame-Options). Mit Profil-ID öffnet sich das gewählte Druckprofil.
export function makerworldViewerUrl(sourceUrl: string | null | undefined, profileId: number | null | undefined): string | null {
  if (!sourceUrl) return null;
  const base = sourceUrl.split('#')[0];
  return profileId ? `${base}#profileId-${profileId}` : base;
}
