import { MakerworldImportResult } from '../../../core/services/worker-api.service';
import {
  analyzeProductImport,
  applyEstimatesToVariantForm,
  newVariantForm,
  productSaveErrorMessage,
} from './admin-product-editor.util';

const result = (partial: Record<string, unknown>) => partial as unknown as MakerworldImportResult;

describe('admin-product-editor.util', () => {
  it('nimmt die Übersetzung als Namensvorschlag', () => {
    const a = analyzeProductImport(result({ title: 'Dog', titleDe: 'Hund', images: ['u1'], plates: [] }), false);
    expect(a.suggestedName).toBe('Hund');
    expect(a.hint).toContain('übersetzt');
    expect(a.images).toEqual(['u1']);
  });

  it('nimmt das Original ohne Übersetzung', () => {
    const a = analyzeProductImport(result({ title: 'Dog', titleDe: null, images: [] }), false);
    expect(a.suggestedName).toBe('Dog');
    expect(a.hint).toContain('keine Übersetzung');
  });

  it('meldet leeres Ergebnis und übersteht fehlende Felder', () => {
    const a = analyzeProductImport(result({}), true);
    expect(a.empty).toBe(true);
    expect(a.plates).toEqual([]);
  });

  it('hängt Platten-Bilder ohne Duplikate an und ergänzt Varianten-Hinweis bei neuem Produkt', () => {
    const a = analyzeProductImport(
      result({
        title: 'Dog',
        images: ['u1'],
        sizeHint: '8 cm',
        plates: [{ plateNo: 1, printMinutes: 1, weightG: 1, imageUrl: 'u1', filaments: [] }, { plateNo: 2, printMinutes: 1, weightG: 1, imageUrl: 'u2', filaments: [] }],
      }),
      true,
    );
    expect(a.images).toEqual(['u1', 'u2']);
    expect(a.hint).toContain('„8 cm"');
  });

  it('übernimmt Schätzwerte in die Variante und behält vorhandene Größe', () => {
    const form = { ...newVariantForm(), sizeLabel: '10 cm' };
    const updated = applyEstimatesToVariantForm(form, { sizeHint: '8 cm', estimatedPrintMinutes: 90, estimatedWeightG: null });
    expect(updated).toMatchObject({ sizeLabel: '10 cm', printTimeMin: 90, weightG: 0 });
    expect(applyEstimatesToVariantForm(form, { sizeHint: null, estimatedPrintMinutes: null, estimatedWeightG: null })).toBeNull();
  });

  it('übersetzt den Duplikat-Fehlercode', () => {
    expect(productSaveErrorMessage({ code: '23505' })).toContain('existiert bereits');
    expect(productSaveErrorMessage(new Error('x'))).toBe('Produkt konnte nicht gespeichert werden.');
  });
});
