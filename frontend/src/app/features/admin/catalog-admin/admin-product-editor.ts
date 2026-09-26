import { Component, OnInit, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
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
} from '../../../core/utils/makerworld-plates.util';
import { MakerworldPlateMapping } from '../../../shared/makerworld-plates/makerworld-plate-mapping';

// Grundstock an Kategorien (Entscheidung 2026-09-19). Kategorie bleibt
// Freitext — diese Liste ergänzt nur die Vorschläge um Werte, die noch von
// keinem Produkt benutzt werden.
const BASE_CATEGORIES = ['Frühling', 'Sommer', 'Herbst', 'Winter', 'Ostern', 'Weihnachten', 'Halloween'];

const EMPTY_COSTS: CostComponents = {
  filament_cost: 0,
  energy_cost: 0,
  machine_cost: 0,
  labor_cost: 0,
  packaging_cost: 0,
  license_cost: 0,
  scrap_allowance: 0,
  other_cost: 0,
};

@Component({
  selector: 'app-admin-product-editor',
  standalone: true,
  imports: [
    MakerworldPlateMapping,
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
  // Beschreibungsfeld vorerst ausgeblendet (Entscheidung 2026-09-19): wird in
  // der Startphase nicht gepflegt. Feld, Signal und Speichern bleiben
  // erhalten — nur die Anzeige ist abgeschaltet.
  readonly showDescription = false;

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
  // 00198: Platten/Farbteile beim Anlegen aus MakerWorld (null = nur eine Platte/Farbe)
  readonly plateMapping = signal<PlateMappingState | null>(null);

  // Spec 27 §6: Herkunft eines importierten Produkts (nur Anzeige).
  readonly sourceMakerworldUrl = signal<string | null>(null);
  readonly sourceMakerworldTitle = signal<string | null>(null);

  // Varianten
  readonly variants = signal<AdminVariant[]>([]);
  readonly variantDialogVisible = signal(false);
  readonly editingVariant = signal<AdminVariant | null>(null);
  readonly variantForm = signal<Omit<AdminVariant, 'id'>>({
    sizeLabel: '',
    weightG: 0,
    printTimeMin: 0,
    workTimeMin: 0,
    materialNeedG: 0,
    minQty: 1,
    maxQty: 10,
    stepQty: 1,
    active: true,
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
    const id = this.route.snapshot.paramMap.get('id');
    if (!id || id === 'neu') {
      this.isNew.set(true);
      this.loading.set(false);
      return;
    }
    this.isNew.set(false);
    this.productId.set(id);
    this.load(id);
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
      // Defensiv normalisieren: Ein Worker ohne title/images (aelterer Stand)
      // darf das Rendering nicht zum Absturz bringen.
      const title = typeof result.title === 'string' && result.title.trim() ? result.title.trim() : null;
      const titleDe = typeof result.titleDe === 'string' && result.titleDe.trim() ? result.titleDe.trim() : null;
      const plates = Array.isArray(result.plates) ? result.plates : [];
      this.productMakerworldImport.set({ ...result, plates });
      const plateImages = plates.map((p) => p.imageUrl).filter((u): u is string => !!u);
      const modelImages = Array.isArray(result.images) ? result.images.filter((u) => typeof u === 'string' && u) : [];
      const images = [...modelImages, ...plateImages.filter((u) => !modelImages.includes(u))];
      if (title === null && images.length === 0) {
        this.productMakerworldHint.set('Kein Titel und keine Bilder in MakerWorld gefunden — bitte manuell eintragen.');
        return;
      }
      // Spec 27 §4: deutsche Übersetzung als Namensvorschlag, Original als
      // Hinweis; ohne Übersetzung (Workers AI nicht erreichbar) das Original.
      if (title !== null) {
        this.name.set(titleDe ?? title);
      }
      if (this.isNew() && hasPlateChoice(plates)) {
        this.plateMapping.set(defaultMappingState(plates, this.name()));
      }
      this.productMakerworldImages.set(images);
      const variantHint = this.isNew()
        ? ' Beim Anlegen wird eine Variante „Standard" mit Gewicht/Druckzeit aus MakerWorld erstellt.'
        : '';
      this.productMakerworldHint.set(
        (title === null
          ? 'Kein Titel gefunden. Bilder unten einzeln übernehmen.'
          : titleDe !== null
            ? `Name aus MakerWorld übersetzt übernommen (Original: „${title}"), bitte prüfen. Bilder unten einzeln übernehmen.`
            : 'Name aus MakerWorld übernommen (keine Übersetzung verfügbar), bitte prüfen. Bilder unten einzeln übernehmen.') +
          variantHint,
      );
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
            sizeLabel: 'Standard',
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
      } else {
        // Bestehendes Produkt: nach "Auslesen" die MakerWorld-Herkunft
        // nachtragen (z. B. für den Link beim Produktionsstart).
        const loaded = this.productMakerworldImport();
        const source = loaded ? { url: loaded.sourceUrl, title: loaded.title, modelId: loaded.modelId } : null;
        await this.catalogService.updateProduct(this.productId()!, input, source);
        if (source) {
          this.sourceMakerworldUrl.set(source.url);
          this.sourceMakerworldTitle.set(source.title);
        }
      }
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      this.error.set(
        code === '23505'
          ? 'Dieses MakerWorld-Modell existiert bereits als Produkt.'
          : 'Produkt konnte nicht gespeichert werden.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  openNewVariantDialog(): void {
    this.editingVariant.set(null);
    this.variantForm.set({
      sizeLabel: '',
      weightG: 0,
      printTimeMin: 0,
      workTimeMin: 0,
      materialNeedG: 0,
      minQty: 1,
      maxQty: 10,
      stepQty: 1,
      active: true,
    });
    this.resetMakerworldImport();
    this.variantDialogVisible.set(true);
  }

  openEditVariantDialog(variant: AdminVariant): void {
    this.editingVariant.set(variant);
    this.variantForm.set({ ...variant });
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
      if (result.estimatedPrintMinutes === null && result.estimatedWeightG === null) {
        this.makerworldHint.set('Keine Werte in MakerWorld gefunden — bitte manuell eintragen.');
        return;
      }
      this.variantForm.update((f) => ({
        ...f,
        weightG: result.estimatedWeightG ?? f.weightG,
        printTimeMin: result.estimatedPrintMinutes ?? f.printTimeMin,
      }));
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
      if (editing) {
        await this.catalogService.updateVariant(editing.id, this.variantForm());
      } else {
        await this.catalogService.createVariant(productId, this.variantForm());
      }
      this.variantDialogVisible.set(false);
      this.variants.set(await this.catalogService.listVariants(productId));
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
    } catch {
      this.error.set('Kalkulationsversion konnte nicht angelegt werden.');
    } finally {
      this.saving.set(false);
    }
  }

  updateCalcCost(key: keyof CostComponents, value: number): void {
    this.calcCosts.update((c) => ({ ...c, [key]: value }));
  }

  async addPart(): Promise<void> {
    const productId = this.productId();
    const name = this.newPartName().trim();
    if (!productId || !name) return;
    try {
      await this.catalogService.createProductPart(productId, name, this.parts().length + 1);
      this.parts.set(await this.catalogService.listProductParts(productId));
      this.newPartName.set('');
    } catch {
      this.error.set('Teil konnte nicht hinzugefügt werden.');
    }
  }
}
