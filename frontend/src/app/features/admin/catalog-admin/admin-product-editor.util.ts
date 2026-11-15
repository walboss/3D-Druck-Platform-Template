import { AdminVariant, CostComponents } from '../../../core/services/admin-catalog.service';
import { MakerworldImportResult } from '../../../core/services/worker-api.service';

// Reine Hilfsfunktionen und Konstanten des Produkt-Editors (aus
// admin-product-editor.ts ausgelagert, Verhalten unverändert).

// Grundstock an Kategorien (Entscheidung 2026-09-19). Kategorie bleibt
// Freitext — diese Liste ergänzt nur die Vorschläge um Werte, die noch von
// keinem Produkt benutzt werden.
export const BASE_CATEGORIES = ['Frühling', 'Sommer', 'Herbst', 'Winter', 'Ostern', 'Weihnachten', 'Halloween'];

export const EMPTY_COSTS: CostComponents = {
  filament_cost: 0,
  energy_cost: 0,
  machine_cost: 0,
  labor_cost: 0,
  packaging_cost: 0,
  license_cost: 0,
  scrap_allowance: 0,
  other_cost: 0,
};

export function newVariantForm(): Omit<AdminVariant, 'id'> {
  return {
    sizeLabel: '',
    weightG: 0,
    printTimeMin: 0,
    workTimeMin: 0,
    materialNeedG: 0,
    minQty: 1,
    maxQty: 10,
    stepQty: 1,
    active: true,
  };
}

export interface ProductImportAnalysis {
  title: string | null;
  titleDe: string | null;
  plates: NonNullable<MakerworldImportResult['plates']>;
  images: string[];
  /** Name, der ins Namensfeld kommt (Übersetzung vor Original), null = nichts ändern. */
  suggestedName: string | null;
  /** true = weder Titel noch Bilder gefunden. */
  empty: boolean;
  hint: string;
}

// Normalisiert das Worker-Ergebnis defensiv (ein Worker ohne title/images,
// älterer Stand, darf das Rendering nicht zum Absturz bringen) und baut den
// Hinweistext. Spec 27 §4: deutsche Übersetzung als Namensvorschlag, Original
// als Hinweis; ohne Übersetzung das Original.
export function analyzeProductImport(result: MakerworldImportResult, isNew: boolean): ProductImportAnalysis {
  const title = typeof result.title === 'string' && result.title.trim() ? result.title.trim() : null;
  const titleDe = typeof result.titleDe === 'string' && result.titleDe.trim() ? result.titleDe.trim() : null;
  const plates = Array.isArray(result.plates) ? result.plates : [];
  const plateImages = plates.map((p) => p.imageUrl).filter((u): u is string => !!u);
  const modelImages = Array.isArray(result.images) ? result.images.filter((u) => typeof u === 'string' && u) : [];
  const images = [...modelImages, ...plateImages.filter((u) => !modelImages.includes(u))];

  if (title === null && images.length === 0) {
    return {
      title,
      titleDe,
      plates,
      images,
      suggestedName: null,
      empty: true,
      hint: 'Kein Titel und keine Bilder in MakerWorld gefunden — bitte manuell eintragen.',
    };
  }

  const sizeHint = result.sizeHint?.trim();
  const variantHint = isNew
    ? ` Beim Anlegen wird eine Variante „${sizeHint || 'Standard'}" mit Gewicht/Druckzeit aus MakerWorld erstellt${sizeHint ? ' (Größe aus der Beschreibung, bitte prüfen)' : ''}.`
    : '';
  const base =
    title === null
      ? 'Kein Titel gefunden. Bilder unten einzeln übernehmen.'
      : titleDe !== null
        ? `Name aus MakerWorld übersetzt übernommen (Original: „${title}"), bitte prüfen. Bilder unten einzeln übernehmen.`
        : 'Name aus MakerWorld übernommen (keine Übersetzung verfügbar), bitte prüfen. Bilder unten einzeln übernehmen.';

  return {
    title,
    titleDe,
    plates,
    images,
    suggestedName: title !== null ? (titleDe ?? title) : null,
    empty: false,
    hint: base + variantHint,
  };
}

// Übernimmt Gewicht/Druckzeit/Größe aus dem MakerWorld-Ergebnis in den
// Varianten-Dialog. Vorhandene Größenangabe bleibt, fehlende Werte ebenso.
// null = MakerWorld hat nichts geliefert.
export function applyEstimatesToVariantForm(
  form: Omit<AdminVariant, 'id'>,
  result: Pick<MakerworldImportResult, 'sizeHint' | 'estimatedPrintMinutes' | 'estimatedWeightG'>,
): Omit<AdminVariant, 'id'> | null {
  const sizeHint = result.sizeHint?.trim() || null;
  if (result.estimatedPrintMinutes === null && result.estimatedWeightG === null && sizeHint === null) {
    return null;
  }
  return {
    ...form,
    sizeLabel: form.sizeLabel.trim() ? form.sizeLabel : (sizeHint ?? form.sizeLabel),
    weightG: result.estimatedWeightG ?? form.weightG,
    printTimeMin: result.estimatedPrintMinutes ?? form.printTimeMin,
  };
}

export function productSaveErrorMessage(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  return code === '23505'
    ? 'Dieses MakerWorld-Modell existiert bereits als Produkt.'
    : 'Produkt konnte nicht gespeichert werden.';
}
