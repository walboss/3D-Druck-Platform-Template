import { Component, DestroyRef, OnInit, computed, signal, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { CheckboxModule } from 'primeng/checkbox';
import { TabsModule } from 'primeng/tabs';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';
import { DialogModule } from 'primeng/dialog';
import { AutoCompleteModule, AutoCompleteCompleteEvent } from 'primeng/autocomplete';

import {
  AdminCatalogService,
  AdminProductPart,
  AdminVariant,
  CostComponents,
} from '../../../core/services/admin-catalog.service';
import { ProductImage, CalcReason } from '../../../core/models/db-types';
import { AuthService } from '../../../core/services/auth.service';
import { MakerworldImportResult, WorkerApiService } from '../../../core/services/worker-api.service';
import { sanitizeTag } from '../../../core/utils/tags.util';
import {
  PlateMappingState,
  defaultMappingState,
  hasPlateChoice,
  planError,
  planProducts,
  makerworldViewerUrl,
  applyPlateAnalysis,
  plateAnalysisHint,
} from '../../../core/utils/makerworld-plates.util';
import { MakerworldPlateMapping } from '../../../shared/makerworld-plates/makerworld-plate-mapping';
import {
  BASE_CATEGORIES,
  EMPTY_COSTS,
  analyzeProductImport,
  applyEstimatesToVariantForm,
  newVariantForm,
  productSaveErrorMessage,
} from './admin-product-editor.util';
import { MessageService } from 'primeng/api';
import { SizedImage } from '../../../shared/sized-image/sized-image';

@Component({
  selector: 'app-admin-product-editor',
  standalone: true,
  imports: [SizedImage, 
    MakerworldPlateMapping,
    CheckboxModule,
    DecimalPipe,
    FormsModule,
    ButtonModule,
    InputTextModule,
    TextareaModule,
    ToggleSwitchModule,
    SelectModule,
    InputNumberModule,
    TabsModule,
    MessageModule,
    SkeletonModule,
    DialogModule,
    AutoCompleteModule,
  ],
  templateUrl: './admin-product-editor.html',
  styleUrl: './admin-product-editor.scss',
})
export class AdminProductEditor implements OnInit {
  // Erfolgsmeldungen (Review C22), Toast sitzt im Admin-Layout
  private readonly messages = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  // Beschreibungsfeld wieder sichtbar (Entscheidung Betreiber 2026-11-14, ersetzt
  // die Ausblendung vom 2026-09-19); MakerWorld-Import füllt einen Vorschlag.
  readonly showDescription = true;

  readonly isNew = signal(true);
  readonly productId = signal<string | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);

  // Stammdaten
  readonly name = signal('');
  readonly description = signal('');
  readonly category = signal('');
  readonly knownCategories = signal<string[]>(BASE_CATEGORIES);
  readonly categorySuggestions = signal<string[]>([]);
  readonly active = signal(true);
  readonly isMulticolor = signal(false);
  readonly tags = signal<string[]>([]);
  readonly newTag = signal('');
  readonly images = signal<ProductImage[]>([]);

  // MakerWorld-Import im Stammdaten-Tab: Titel-Vorschlag ins Namensfeld,
  // Bilder nur als Vorschau — jedes Bild muss der Admin einzeln
  // übernehmen (extern_link, Hotlink auf MakerWorld-CDN). Bewusst
  // getrennt vom gleichnamigen Import im Varianten-Dialog (Gewicht/Druckzeit).
  readonly productMakerworldUrl = signal('');
  readonly productMakerworldImporting = signal(false);
  readonly productMakerworldError = signal<string | null>(null);
  readonly productMakerworldHint = signal<string | null>(null);
  readonly productMakerworldImages = signal<string[]>([]);
  // Letztes Import-Ergebnis (nur bei neuem Produkt relevant): beim Anlegen
  // werden daraus Herkunft (Spec 27 §3) und die Standard-Variante (Spec 27 §2,
  // identisch zum Sammelimport) angelegt.
  readonly productMakerworldImport = signal<MakerworldImportResult | null>(null);
  // Link zur 3D-Ansicht des gewählten Druckprofils auf MakerWorld
  readonly analysisHint = computed(() => plateAnalysisHint(this.productMakerworldImport()?.plateAnalysis, false));
  readonly viewerUrl = computed(() => {
    const r = this.productMakerworldImport();
    return r ? makerworldViewerUrl(r.sourceUrl, r.printProfile?.profileId) : null;
  });
  // 00198: Platten/Farbteile beim Anlegen aus MakerWorld (null = nur eine Platte/Farbe)
  readonly plateMapping = signal<PlateMappingState | null>(null);

  // Spec 27 §6: Herkunft eines importierten Produkts (nur Anzeige).
  readonly sourceMakerworldUrl = signal<string | null>(null);
  readonly sourceMakerworldTitle = signal<string | null>(null);

  // Varianten
  readonly variants = signal<AdminVariant[]>([]);
  readonly variantDialogVisible = signal(false);
  readonly editingVariant = signal<AdminVariant | null>(null);
  readonly variantForm = signal<Omit<AdminVariant, 'id'>>(newVariantForm());
  // Teile je Variante (mehrfarbige Produkte): welche Teile gehören zu dieser
  // Variante, mit Gramm/Druckzeit (z. B. Pinguin „Einteilig“ nur „Komplett“).
  // locked = gehört schon zur gespeicherten Variante, kann nicht entfernt werden (00153)
  readonly variantPartRows = signal<
    { partId: string; name: string; used: boolean; locked: boolean; weightG: number; printTimeMin: number }[]
  >([]);
  readonly showVariantParts = computed(() => this.isMulticolor() && this.parts().length > 0);
  readonly partSums = computed(() => {
    const used = this.variantPartRows().filter((r) => r.used);
    return {
      weightG: Math.round(used.reduce((sum, r) => sum + (r.weightG || 0), 0) * 10) / 10,
      printTimeMin: Math.round(used.reduce((sum, r) => sum + (r.printTimeMin || 0), 0)),
    };
  });

  // Kalkulation
  readonly calcDialogVisible = signal(false);
  readonly calcTargetVariant = signal<AdminVariant | null>(null);
  readonly calcCurrentVersion = signal<{ versionNo: number; finalPrice: number } | null>(null);
  readonly calcCosts = signal<CostComponents>({ ...EMPTY_COSTS });
  readonly calcMargin = signal(20);
  readonly calcReason = signal<CalcReason>('admin_korrektur');
  readonly calcReasonOptions: { label: string; value: CalcReason }[] = [
    { label: 'Kundenwunsch', value: 'kundenwunsch' },
    { label: 'Admin-Korrektur', value: 'admin_korrektur' },
    { label: 'Falsche Variante', value: 'falsche_variante' },
    { label: 'Sonstiger Grund', value: 'sonstiger_grund' },
  ];

  // Teile (nur mehrfarbig)
  readonly parts = signal<AdminProductPart[]>([]);
  readonly newPartName = signal('');
  // Entwürfe für umbenannte Teile (part id -> Name)
  readonly partNameDrafts = signal<Record<string, string>>({});

  // MakerWorld-Import (Task D): Vorschlag fuer Gewicht/Druckzeit im
  // Varianten-Dialog, unverbindlich, Admin kann ueberschreiben.
  readonly makerworldUrl = signal('');
  readonly makerworldImporting = signal(false);
  readonly makerworldError = signal<string | null>(null);
  readonly makerworldHint = signal<string | null>(null);

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly catalogService: AdminCatalogService,
    private readonly authService: AuthService,
    private readonly workerApiService: WorkerApiService,
  ) {}

  ngOnInit(): void {
    void this.loadCategories();
    // Auf jede Änderung der ID reagieren: Angular verwendet die Komponente
    // beim Wechsel zwischen Produkten wieder (Live-Fund 2026-11-15: sonst
    // wurde das vorige Produkt angezeigt und gespeichert).
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('id');
      if (id === this.productId() && !this.isNew()) return;
      this.resetForm();
      if (!id || id === 'neu') {
        this.isNew.set(true);
        this.productId.set(null);
        this.loading.set(false);
        return;
      }
      this.isNew.set(false);
      this.productId.set(id);
      void this.load(id);
    });
  }

  /** Formular auf Anfangszustand (vor dem Laden eines anderen Produkts). */
  private resetForm(): void {
    this.error.set(null);
    this.name.set('');
    this.description.set('');
    this.category.set('');
    this.active.set(true);
    this.isMulticolor.set(false);
    this.tags.set([]);
    this.images.set([]);
    this.sourceMakerworldUrl.set(null);
    this.sourceMakerworldTitle.set(null);
    this.variants.set([]);
    this.parts.set([]);
    this.partNameDrafts.set({});
    this.productMakerworldUrl.set('');
    this.productMakerworldError.set(null);
    this.productMakerworldHint.set(null);
    this.productMakerworldImages.set([]);
    this.productMakerworldImport.set(null);
    this.plateMapping.set(null);
    this.variantDialogVisible.set(false);
    this.calcDialogVisible.set(false);
  }

  async load(id: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const product = await this.catalogService.getProduct(id);
      this.name.set(product.name);
      this.description.set(product.description ?? '');
      this.category.set(product.category ?? '');
      this.active.set(product.active);
      this.isMulticolor.set(product.isMulticolor);
      this.tags.set(product.tags);
      this.images.set(product.images);
      this.sourceMakerworldUrl.set(product.makerworldUrl ?? null);
      this.sourceMakerworldTitle.set(product.makerworldTitle ?? null);

      const [variants, parts] = await Promise.all([
        this.catalogService.listVariants(id),
        this.catalogService.listProductParts(id),
      ]);
      this.variants.set(variants);
      this.parts.set(parts);
    } catch {
      this.error.set('Produkt konnte nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  back(): void {
    this.router.navigate(['/admin/katalog']);
  }

  /** Modell erneut aus MakerWorld einlesen (Import-Seite mit Rückfrage, 00202). */
  reimportFromMakerworld(): void {
    const url = this.sourceMakerworldUrl();
    if (!url) return;
    void this.router.navigate(['/admin/katalog/import'], { queryParams: { link: url, neu: '1' } });
  }

  private async loadCategories(): Promise<void> {
    try {
      const used = await this.catalogService.listCategories();
      const merged = new Map<string, string>();
      for (const c of [...BASE_CATEGORIES, ...used]) {
        merged.set(c.toLocaleLowerCase('de'), c);
      }
      this.knownCategories.set(Array.from(merged.values()).sort((a, b) => a.localeCompare(b, 'de')));
    } catch {
      // Vorschläge sind Komfort — Fehler hier blockieren den Editor nicht.
    }
  }

  searchCategories(event: AutoCompleteCompleteEvent): void {
    const q = event.query.trim().toLocaleLowerCase('de');
    this.categorySuggestions.set(
      q ? this.knownCategories().filter((c) => c.toLocaleLowerCase('de').includes(q)) : [...this.knownCategories()],
    );
  }

  addTag(): void {
    const tag = sanitizeTag(this.newTag());
    if (!tag || this.tags().some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    this.tags.update((t) => [...t, tag]);
    this.newTag.set('');
  }

  removeTag(tag: string): void {
    this.tags.update((t) => t.filter((x) => x !== tag));
  }

  addImageRow(): void {
    this.images.update((imgs) => [...imgs, { url: '', source_type: 'extern_link' }]);
  }

  removeImageRow(index: number): void {
    this.images.update((imgs) => imgs.filter((_, i) => i !== index));
  }

  updateImageUrl(index: number, url: string): void {
    this.images.update((imgs) => imgs.map((img, i) => (i === index ? { ...img, url } : img)));
  }

  updateImageSourceType(index: number, sourceType: 'extern_link' | 'eigenes_hosting'): void {
    this.images.update((imgs) => imgs.map((img, i) => (i === index ? { ...img, source_type: sourceType } : img)));
  }

  async importProductFromMakerWorld(): Promise<void> {
    const url = this.productMakerworldUrl().trim();
    if (!url) return;
    const accessToken = this.authService.session()?.access_token;
    if (!accessToken) {
      this.productMakerworldError.set('Nicht eingeloggt.');
      return;
    }
    this.productMakerworldImporting.set(true);
    this.productMakerworldError.set(null);
    this.productMakerworldHint.set(null);
    this.productMakerworldImages.set([]);
    this.productMakerworldImport.set(null);
    this.plateMapping.set(null);
    try {
      const result = await this.workerApiService.importMakerworldEstimates(accessToken, url);
      this.productMakerworldImport.set(result);
      const analysis = analyzeProductImport(result, this.isNew());
      this.productMakerworldImport.set({ ...result, plates: analysis.plates });
      if (analysis.empty) {
        this.productMakerworldHint.set(analysis.hint);
        return;
      }
      if (analysis.suggestedName !== null) {
        this.name.set(analysis.suggestedName);
      }
      // Beschreibungs-Vorschlag nur in ein leeres Feld
      if (!this.description().trim() && result.descriptionDe?.trim()) {
        this.description.set(result.descriptionDe.trim());
      }
      if (this.isNew() && hasPlateChoice(analysis.plates)) {
        this.plateMapping.set(
          applyPlateAnalysis(defaultMappingState(analysis.plates, this.name()), analysis.plates, result.plateAnalysis, false),
        );
      }
      this.productMakerworldImages.set(analysis.images);
      this.productMakerworldHint.set(analysis.hint);
    } catch (e) {
      const err = e as { error?: { error?: string } };
      this.productMakerworldError.set(err?.error?.error ?? 'MakerWorld-Import fehlgeschlagen.');
    } finally {
      this.productMakerworldImporting.set(false);
    }
  }

  isMakerworldImageAdopted(url: string): boolean {
    return this.images().some((img) => img.url === url);
  }

  adoptMakerworldImage(url: string): void {
    if (this.isMakerworldImageAdopted(url)) return;
    this.images.update((imgs) => [...imgs, { url, source_type: 'extern_link' }]);
  }

  dismissMakerworldImage(url: string): void {
    this.productMakerworldImages.update((urls) => urls.filter((u) => u !== url));
  }

  async saveProduct(): Promise<void> {
    if (!this.name().trim()) {
      this.error.set('Name ist ein Pflichtfeld.');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      const mw = this.isNew() ? this.productMakerworldImport() : null;
      const mapping = this.plateMapping();
      const planned = mw
        ? planProducts(
            mapping ?? { mode: 'combined', areaNames: {}, plateNames: {}, selectedPlate: null },
            this.name(),
            mw.plates ?? [],
            { weightG: mw.estimatedWeightG, printTimeMin: mw.estimatedPrintMinutes, imageUrl: null },
          )[0] ?? null
        : null;
      if (mw && mapping) {
        const problem = planError(planned ? [planned] : []);
        if (problem) {
          this.error.set(problem);
          return;
        }
      }
      const input = {
        name: this.name().trim(),
        description: this.description().trim() || null,
        category: this.category().trim() || null,
        images: this.images(),
        tags: this.tags(),
        active: this.active(),
        isMulticolor: this.isMulticolor() || (planned?.parts.length ?? 0) >= 2,
        makerworldPlateNo: planned?.plateNo ?? null,
        makerworldUrl: mw?.sourceUrl ?? null,
        makerworldTitle: mw?.title ?? null,
        makerworldModelId: mw?.modelId ?? null,
      };
      if (this.isNew()) {
        const id = await this.catalogService.createProduct(input);
        if (mw && planned) {
          // Standard-Variante wie beim Sammelimport (Spec 27 §2): ohne aktive
          // Variante erscheint das Produkt nicht in v_catalog.
          const weightG = planned.weightG;
          const variantId = await this.catalogService.createVariant(id, {
            sizeLabel: mw.sizeHint?.trim() || 'Standard',
            weightG,
            printTimeMin: planned.printTimeMin,
            workTimeMin: 0,
            materialNeedG: weightG,
            minQty: 1,
            maxQty: 10,
            stepQty: 1,
            active: true,
          });
          // 00198: Farbteile mit Gewicht/Druckzeit je Teil
          let sort = 0;
          for (const part of planned.parts) {
            sort++;
            const partId = await this.catalogService.createProductPart(id, part.name, sort);
            await this.catalogService.createVariantPart(variantId, partId, part.weightG, part.printTimeMin);
          }
        }
        this.router.navigate(['/admin/katalog', id]);
        this.messages.add({ severity: 'success', summary: 'Produkt angelegt' });
      } else {
        // Bestehendes Produkt: nach "Auslesen" die MakerWorld-Herkunft
        // nachtragen (z. B. für den Link beim Produktionsstart).
        const loaded = this.productMakerworldImport();
        const source = loaded ? { url: loaded.sourceUrl, title: loaded.title, modelId: loaded.modelId } : null;
        await this.catalogService.updateProduct(this.productId()!, input, source);
        this.messages.add({ severity: 'success', summary: 'Produkt gespeichert' });
        if (source) {
          this.sourceMakerworldUrl.set(source.url);
          this.sourceMakerworldTitle.set(source.title);
        }
      }
    } catch (e) {
      this.error.set(productSaveErrorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  private async loadVariantPartRows(variantId: string | null): Promise<void> {
    const existing = variantId ? await this.catalogService.listVariantParts(variantId) : [];
    this.variantPartRows.set(
      this.parts().map((p) => {
        const vp = existing.find((e) => e.partId === p.id);
        return { partId: p.id, name: p.name, used: !!vp, locked: !!vp, weightG: vp?.weightG ?? 0, printTimeMin: vp?.printTimeMin ?? 0 };
      }),
    );
  }

  /** Teil-Zeile ändern; Gewicht/Druckzeit/Materialbedarf der Variante = Summe. */
  setVariantPart(partId: string, patch: Partial<{ used: boolean; weightG: number; printTimeMin: number }>): void {
    const rows = this.variantPartRows().map((r) => (r.partId === partId ? { ...r, ...patch } : r));
    this.variantPartRows.set(rows);
    this.applyPartSums();
  }

  /**
   * Gewicht/Druckzeit/Materialbedarf der Variante = Summe der Teile. Wird beim
   * Ändern UND beim Speichern angewendet: die Zahlenfelder der Variante können
   * beim Verlassen ihren alten Wert zurückschreiben (Live-Fund 2026-11-15).
   */
  private applyPartSums(): void {
    const used = this.variantPartRows().filter((r) => r.used);
    if (used.length === 0) return;
    const weightG = Math.round(used.reduce((s, r) => s + (r.weightG || 0), 0) * 10) / 10;
    const printTimeMin = Math.round(used.reduce((s, r) => s + (r.printTimeMin || 0), 0));
    // Nach dem aktuellen Change-Detection-Lauf erneut setzen, damit kein
    // Blur-Event des Variantenfelds die Summe überschreibt.
    this.variantForm.set({ ...this.variantForm(), weightG, printTimeMin, materialNeedG: weightG });
    queueMicrotask(() => this.variantForm.set({ ...this.variantForm(), weightG, printTimeMin, materialNeedG: weightG }));
  }

  openNewVariantDialog(): void {
    this.editingVariant.set(null);
    this.variantForm.set(newVariantForm());
    void this.loadVariantPartRows(null);
    this.resetMakerworldImport();
    this.variantDialogVisible.set(true);
  }

  openEditVariantDialog(variant: AdminVariant): void {
    this.editingVariant.set(variant);
    this.variantForm.set({ ...variant });
    void this.loadVariantPartRows(variant.id);
    this.resetMakerworldImport();
    this.variantDialogVisible.set(true);
  }

  private resetMakerworldImport(): void {
    this.makerworldUrl.set('');
    this.makerworldError.set(null);
    this.makerworldHint.set(null);
  }

  async importFromMakerWorld(): Promise<void> {
    const url = this.makerworldUrl().trim();
    if (!url) return;
    const accessToken = this.authService.session()?.access_token;
    if (!accessToken) {
      this.makerworldError.set('Nicht eingeloggt.');
      return;
    }
    this.makerworldImporting.set(true);
    this.makerworldError.set(null);
    this.makerworldHint.set(null);
    try {
      const result = await this.workerApiService.importMakerworldEstimates(accessToken, url);
      const updated = applyEstimatesToVariantForm(this.variantForm(), result);
      if (updated === null) {
        this.makerworldHint.set('Keine Werte in MakerWorld gefunden — bitte manuell eintragen.');
        return;
      }
      this.variantForm.set(updated);
      this.makerworldHint.set('Aus MakerWorld übernommen, bitte prüfen.');
    } catch (e) {
      const err = e as { error?: { error?: string } };
      this.makerworldError.set(err?.error?.error ?? 'MakerWorld-Import fehlgeschlagen.');
    } finally {
      this.makerworldImporting.set(false);
    }
  }

  async saveVariant(): Promise<void> {
    const productId = this.productId();
    if (!productId) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const editing = this.editingVariant();
      const usedParts = this.variantPartRows().filter((r) => r.used);
      if (this.showVariantParts() && usedParts.length === 0) {
        this.error.set('Bitte mindestens ein Teil für diese Variante wählen.');
        return;
      }
      if (this.showVariantParts()) {
        const weightG = Math.round(usedParts.reduce((s, r) => s + (r.weightG || 0), 0) * 10) / 10;
        const printTimeMin = Math.round(usedParts.reduce((s, r) => s + (r.printTimeMin || 0), 0));
        this.variantForm.set({ ...this.variantForm(), weightG, printTimeMin, materialNeedG: weightG });
      }
      let variantId: string;
      if (editing) {
        await this.catalogService.updateVariant(editing.id, this.variantForm());
        variantId = editing.id;
      } else {
        variantId = await this.catalogService.createVariant(productId, this.variantForm());
      }
      if (this.showVariantParts()) {
        await this.catalogService.saveVariantParts(
          variantId,
          usedParts.map((r) => ({ partId: r.partId, weightG: r.weightG || 0, printTimeMin: r.printTimeMin || 0 })),
        );
      }
      this.variantDialogVisible.set(false);
      this.variants.set(await this.catalogService.listVariants(productId));
      this.messages.add({ severity: 'success', summary: 'Variante gespeichert' });
    } catch {
      this.error.set('Variante konnte nicht gespeichert werden.');
    } finally {
      this.saving.set(false);
    }
  }

  async openCalcDialog(variant: AdminVariant): Promise<void> {
    this.calcTargetVariant.set(variant);
    this.calcDialogVisible.set(true);
    try {
      const current = await this.catalogService.getCurrentCalculationVersion(variant.id);
      if (current) {
        this.calcCurrentVersion.set({ versionNo: current.versionNo, finalPrice: current.finalPrice });
        this.calcCosts.set({ ...current.costComponents });
        this.calcMargin.set(current.marginPercent);
      } else {
        this.calcCurrentVersion.set(null);
        this.calcCosts.set({ ...EMPTY_COSTS });
        this.calcMargin.set(20);
      }
      this.calcReason.set('admin_korrektur');
    } catch {
      this.calcCurrentVersion.set(null);
    }
  }

  async saveCalculationVersion(): Promise<void> {
    const variant = this.calcTargetVariant();
    if (!variant) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.catalogService.createCalculationVersion(
        variant.id,
        this.calcCosts(),
        this.calcMargin(),
        this.calcReason(),
      );
      this.calcDialogVisible.set(false);
      // Liste neu laden, damit der neue Preis sofort sichtbar ist (Live-Fund 2026-11-15)
      const pid = this.productId();
      if (pid) this.variants.set(await this.catalogService.listVariants(pid));
      this.messages.add({ severity: 'success', summary: 'Kalkulationsversion angelegt' });
    } catch {
      this.error.set('Kalkulationsversion konnte nicht angelegt werden.');
    } finally {
      this.saving.set(false);
    }
  }

  updateCalcCost(key: keyof CostComponents, value: number): void {
    this.calcCosts.update((c) => ({ ...c, [key]: value }));
  }

  partDraft(part: AdminProductPart): string {
    return this.partNameDrafts()[part.id] ?? part.name;
  }

  setPartDraft(part: AdminProductPart, name: string): void {
    this.partNameDrafts.update((d) => ({ ...d, [part.id]: name }));
  }

  async renamePart(part: AdminProductPart): Promise<void> {
    const productId = this.productId();
    const name = this.partDraft(part).trim();
    if (!productId || !name || name === part.name) return;
    if (this.parts().some((p) => p.id !== part.id && p.name.toLowerCase() === name.toLowerCase())) {
      this.error.set('Ein Teil mit diesem Namen gibt es schon.');
      return;
    }
    try {
      await this.catalogService.renameProductPart(part.id, name);
      this.parts.set(await this.catalogService.listProductParts(productId));
      this.partNameDrafts.update((d) => {
        const { [part.id]: _, ...rest } = d;
        return rest;
      });
      this.messages.add({ severity: 'success', summary: 'Teil umbenannt' });
    } catch {
      this.error.set('Teil konnte nicht umbenannt werden.');
    }
  }

  async addPart(): Promise<void> {
    const productId = this.productId();
    const name = this.newPartName().trim();
    if (!productId || !name) return;
    try {
      await this.catalogService.createProductPart(productId, name, this.parts().length + 1);
      this.parts.set(await this.catalogService.listProductParts(productId));
      this.newPartName.set('');
      this.messages.add({ severity: 'success', summary: 'Teil hinzugefügt' });
    } catch {
      this.error.set('Teil konnte nicht hinzugefügt werden.');
    }
  }
}
