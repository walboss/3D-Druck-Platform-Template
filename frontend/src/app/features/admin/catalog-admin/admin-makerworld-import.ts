import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { CheckboxModule } from 'primeng/checkbox';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { ProgressBarModule } from 'primeng/progressbar';

import { AuthService } from '../../../core/services/auth.service';
import { WorkerApiService, MakerworldImportResult } from '../../../core/services/worker-api.service';
import { AdminMakerworldService } from '../../../core/services/admin-makerworld.service';
import { mergeTagsCaseInsensitive } from '../../../core/utils/tags.util';
import {
  PlateMappingState,
  defaultMappingState,
  hasPlateChoice,
  planError,
  planProducts,
  makerworldViewerUrl,
  multicolorPlateNos,
  applyPlateAnalysis,
  plateAnalysisHint,
} from '../../../core/utils/makerworld-plates.util';
import { MakerworldPlateMapping } from '../../../shared/makerworld-plates/makerworld-plate-mapping';
import {
  HEAVY_PRINT_WEIGHT_G,
  ImportEntry,
  ImportRow,
  LONG_PRINT_MINUTES,
  MODEL_ID_PATTERN,
  PREVIEW_CONCURRENCY,
  PROGRESS_THRESHOLD,
  parseCsv,
} from './makerworld-import.util';

// Spec 27 §6 "MakerWorld-Import" (Vorschläge-Review, unverändert: kein
// Kategorie-Eintrag -> Kategorie kommt von MakerWorld, Produkt bleibt
// inaktiv) + specs/massenimport-makerworld-kollektion.md (Massenimport:
// Kategorie-Feld/CSV gesetzt -> Kategorie wird überschrieben, Produkt sofort
// aktiv, keine Kalkulation). Beide Wege teilen sich diesen Screen und die
// bestehende Vorschau-/Anlege-Logik je Zeile.

@Component({
  selector: 'app-admin-makerworld-import',
  standalone: true,
  imports: [
    SelectModule,
    MakerworldPlateMapping,
    FormsModule,
    RouterLink,
    ButtonModule,
    InputTextModule,
    TextareaModule,
    CheckboxModule,
    MessageModule,
    TagModule,
    ProgressBarModule,
  ],
  templateUrl: './admin-makerworld-import.html',
  styleUrl: './admin-makerworld-import.scss',
})
export class AdminMakerworldImport implements OnInit {
  private readonly messages = inject(MessageService);

  readonly linksText = signal('');
  // Massenimport §2: Kategorie-Freitextfeld, gilt für alle Links ohne
  // eigene CSV-Kategorie (Weg A) bzw. als Fallback für leere CSV-Zellen (Weg B).
  readonly globalCategory = signal('');
  readonly rows = signal<ImportRow[]>([]);
  readonly loadingPreview = signal(false);
  readonly importing = signal(false);
  readonly error = signal<string | null>(null);
  readonly invalidLines = signal<string[]>([]);
  // Beim Aufruf aus der Vorschläge-Liste: Vorschlag wird beim Import auf
  // "importiert" gesetzt (Spec 27 §6).
  readonly suggestionId = signal<string | null>(null);

  readonly selectedCount = computed(() => this.rows().filter((r) => r.selected && r.state === 'neu' && r.importState !== 'angelegt').length);
  // Anzahl Produkte, die tatsächlich entstehen ("je Platte" = mehrere pro Link)
  readonly selectedProductCount = computed(() =>
    this.rows()
      .filter((r) => r.selected && r.state === 'neu' && r.importState !== 'angelegt')
      .reduce((sum, r) => sum + (r.mapping?.mode === 'perPlate' ? r.plates.length : 1), 0),
  );
  readonly hasPreview = computed(() => this.rows().length > 0);

  // Massenimport §4: Ergebnis-Bericht nach Abschluss (X erfolgreich, Y
  // fehlgeschlagen) — kumuliert über alle bisher verarbeiteten Zeilen dieses
  // Durchgangs, inkl. Zeilen, die schon vor dem Vorschau-Abruf fehlschlugen
  // (z. B. fehlende CSV-Kategorie).
  readonly report = computed(() => {
    const rows = this.rows();
    const success = rows.filter((r) => r.importState === 'angelegt').length;
    const failed = rows.filter((r) => r.state === 'fehler' || r.importState === 'fehler').length;
    if (success === 0 && failed === 0) return null;
    return { success, failed };
  });

  readonly showPreviewProgress = computed(() => this.loadingPreview() && this.rows().length > PROGRESS_THRESHOLD);
  readonly previewProgress = computed(() => {
    const rows = this.rows();
    if (rows.length === 0) return 0;
    const done = rows.filter((r) => r.state !== 'wartet').length;
    return Math.round((done / rows.length) * 100);
  });

  readonly showImportProgress = computed(() => this.importing() && this.selectedImportTotal() > PROGRESS_THRESHOLD);
  private readonly selectedImportTotal = signal(0);
  readonly importProgress = computed(() => {
    const total = this.selectedImportTotal();
    if (total === 0) return 0;
    const done = this.rows().filter((r) => r.importState === 'angelegt' || r.importState === 'fehler').length;
    return Math.round((Math.min(done, total) / total) * 100);
  });

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly authService: AuthService,
    private readonly workerApi: WorkerApiService,
    private readonly makerworldService: AdminMakerworldService,
  ) {}

  ngOnInit(): void {
    const link = this.route.snapshot.queryParamMap.get('link');
    const suggestion = this.route.snapshot.queryParamMap.get('suggestion');
    // neu=1: aus dem Produkt-Editor „Neu einlesen“ (00202) — nach der
    // Vorschau direkt die Rückfrage zum Neu-Einlesen zeigen.
    const reimport = this.route.snapshot.queryParamMap.get('neu') === '1';
    if (link) {
      this.linksText.set(link);
      this.suggestionId.set(suggestion);
      void this.loadPreview().then(() => {
        if (!reimport) return;
        const row = this.rows().find((r) => r.state === 'vorhanden');
        if (row) void this.reimport(row);
      });
    }
  }

  back(): void {
    this.router.navigate(['/admin/katalog']);
  }

  private resolveCategory(entryCategory: string | null): string | null {
    const own = entryCategory?.trim();
    if (own) return own;
    const global = this.globalCategory().trim();
    return global || null;
  }

  private parseLinksAsEntries(): { entries: ImportEntry[]; invalid: string[] } {
    const entries: ImportEntry[] = [];
    const invalid: string[] = [];
    for (const rawLine of this.linksText().split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (!MODEL_ID_PATTERN.test(line)) {
        invalid.push(line);
        continue;
      }
      entries.push({ link: line, source: 'link', category: null, name: null, tags: [] });
    }
    return { entries, invalid };
  }

  private patchRow(modelId: string, patch: Partial<ImportRow>): void {
    this.rows.update((rows) => rows.map((r) => (r.modelId === modelId ? { ...r, ...patch } : r)));
  }

  async loadPreview(): Promise<void> {
    const { entries, invalid } = this.parseLinksAsEntries();
    this.invalidLines.set(invalid);
    if (entries.length === 0 && invalid.length === 0) {
      this.error.set('Keine Links eingegeben.');
      this.rows.set([]);
      return;
    }
    await this.loadPreviewFromEntries(entries, invalid.length > 0 ? null : 'Keine Links eingegeben.');
  }

  async onCsvFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    const text = await file.text();
    const { entries, error } = parseCsv(text);
    if (error) {
      this.error.set(error);
      return;
    }
    this.linksText.set('');
    this.invalidLines.set([]);
    await this.loadPreviewFromEntries(entries, 'CSV enthält keine Zeilen mit Link.');
  }

  async onTxtFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    const text = await file.text();
    this.linksText.set(text);
    await this.loadPreview();
  }

  private async loadPreviewFromEntries(entries: ImportEntry[], emptyMessage: string | null): Promise<void> {
    this.error.set(null);
    const accessToken = this.authService.session()?.access_token;
    if (!accessToken) {
      this.error.set('Nicht eingeloggt.');
      return;
    }
    if (entries.length === 0) {
      this.rows.set([]);
      if (emptyMessage) this.error.set(emptyMessage);
      return;
    }

    // Dedupe nach Modell-ID (Spec massenimport §5: kein Duplikat-Check über
    // die Liste hinaus gefordert, aber doppelte Zeilen in derselben Liste
    // sollen nicht zweimal verarbeitet werden).
    const seen = new Set<string>();
    const initialRows: ImportRow[] = [];
    for (const entry of entries) {
      const match = entry.link.match(MODEL_ID_PATTERN);
      if (!match) continue;
      const modelId = match[1];
      if (seen.has(modelId)) continue;
      seen.add(modelId);

      const category = this.resolveCategory(entry.category);
      const massenimport = category !== null;

      if (entry.source === 'csv' && category === null) {
        initialRows.push({
          url: entry.link,
          modelId,
          state: 'fehler',
          error: 'Keine Kategorie angegeben',
          preview: null,
          existingProductId: null,
          name: '',
          tagsText: '',
          description: '',
          selected: false,
          importState: 'offen',
          importError: null,
          productId: null,
          source: entry.source,
          resolvedCategory: null,
          massenimport: false,
          ownCategory: entry.category ?? null,
          profileId: null,
          csvNameOverride: entry.name,
          csvTagsExtra: entry.tags,
          plates: [],
          mapping: null,
          createdCount: 0,
        });
        continue;
      }

      initialRows.push({
        url: entry.link,
        modelId,
        state: 'wartet',
        error: null,
        preview: null,
        existingProductId: null,
        name: '',
        tagsText: '',
        description: '',
        selected: false,
        importState: 'offen',
        importError: null,
        productId: null,
        source: entry.source,
        resolvedCategory: category,
        massenimport,
        ownCategory: entry.category ?? null,
        profileId: null,
        csvNameOverride: entry.name,
        csvTagsExtra: entry.tags,
        plates: [],
        mapping: null,
        createdCount: 0,
      });
    }

    this.loadingPreview.set(true);
    this.rows.set(initialRows);
    try {
      const pending = initialRows.filter((r) => r.state === 'wartet');
      const existing = await this.makerworldService.findExistingModelIds(pending.map((r) => r.modelId));
      const queue = pending.filter((r) => {
        const existingId = existing.get(r.modelId);
        if (existingId) {
          this.patchRow(r.modelId, { state: 'vorhanden', existingProductId: existingId });
          return false;
        }
        return true;
      });

      const worker = async (): Promise<void> => {
        while (queue.length > 0) {
          const row = queue.shift();
          if (!row) return;
          await this.fetchPreview(row, accessToken);
        }
      };
      await Promise.all(Array.from({ length: PREVIEW_CONCURRENCY }, () => worker()));
    } catch {
      this.error.set('Vorschau konnte nicht geladen werden.');
    } finally {
      this.loadingPreview.set(false);
    }
  }

  /** Vorschau einer Zeile vom Worker laden (auch für „Neu einlesen“). */
  private async fetchPreview(row: ImportRow, accessToken: string): Promise<void> {
    this.patchRow(row.modelId, { state: 'lade' });
    try {
      const preview = await this.workerApi.importMakerworldEstimates(accessToken, row.url, row.profileId);
      const images = Array.isArray(preview.images) ? preview.images : [];
      const tags = Array.isArray(preview.tags) ? preview.tags : [];
      const tagsDe = Array.isArray(preview.tagsDe) && preview.tagsDe.length > 0 ? preview.tagsDe : tags;
      const normalized: MakerworldImportResult = { ...preview, images, tags, tagsDe };
      const name = (row.csvNameOverride ?? preview.titleDe ?? preview.title ?? '').trim();
      const mergedTags = mergeTagsCaseInsensitive(tagsDe, row.csvTagsExtra);
      const plates = Array.isArray(preview.plates) ? preview.plates : [];
      this.patchRow(row.modelId, {
        state: 'neu',
        preview: { ...normalized, plates },
        plates,
        mapping: hasPlateChoice(plates)
          ? applyPlateAnalysis(defaultMappingState(plates, name), plates, preview.plateAnalysis, true)
          : null,
        name,
        tagsText: mergedTags.join(', '),
        description: preview.descriptionDe?.trim() ?? '',
        // Mehrfarbdruck (AMS) nicht vorauswählen (Entscheidung Betreiber 2026-11-15)
        // unsichere KI-Einordnung ebenfalls nicht vorauswählen
        selected:
          name.length > 0 &&
          multicolorPlateNos(plates).length === 0 &&
          (!hasPlateChoice(plates) || preview.plateAnalysis?.confident !== false),
      });
    } catch (e) {
      const err = e as { error?: { error?: string } };
      this.patchRow(row.modelId, {
        state: 'fehler',
        error: err?.error?.error ?? 'MakerWorld-Abfrage fehlgeschlagen.',
      });
    }
  }

  /**
   * „Neu einlesen“ (Migration 00202, Entscheidung Betreiber 2026-11-14): bisherige
   * Produkte des Modells entfernen (mit Bestellungen o. ä. nur deaktivieren),
   * danach die Vorschau wie bei einem neuen Modell laden.
   */
  async reimport(row: ImportRow): Promise<void> {
    const accessToken = this.authService.session()?.access_token;
    if (!accessToken || this.importing() || this.loadingPreview()) return;
    const ok = window.confirm(
      `Modell ${row.modelId} neu einlesen?

Die bisherigen Produkte dieses Modells werden entfernt. ` +
        'Produkte mit Bestellungen, Angeboten o. ä. werden nur deaktiviert.',
    );
    if (!ok) return;
    this.patchRow(row.modelId, { state: 'lade', error: null });
    try {
      const result = await this.makerworldService.resetModel(row.modelId);
      const parts = [`${result.deleted} entfernt`];
      if (result.deactivated > 0) parts.push(`${result.deactivated} deaktiviert`);
      this.messages.add({ severity: 'success', summary: 'Alte Produkte: ' + parts.join(', ') });
    } catch (e) {
      const err = e as { message?: string };
      this.patchRow(row.modelId, { state: 'vorhanden', error: null });
      this.messages.add({ severity: 'error', summary: 'Neu einlesen fehlgeschlagen', detail: err?.message ?? '' });
      return;
    }
    this.patchRow(row.modelId, { existingProductId: null, importState: 'offen', importError: null, productId: null, createdCount: 0 });
    await this.fetchPreview({ ...row, existingProductId: null }, accessToken);
  }

  updateName(row: ImportRow, name: string): void {
    this.patchRow(row.modelId, { name, selected: row.selected && name.trim().length > 0 });
  }

  /** Link zur 3D-Ansicht des gewählten Druckprofils auf MakerWorld. */
  viewerUrl(row: ImportRow): string | null {
    return makerworldViewerUrl(row.preview?.sourceUrl ?? row.url, row.preview?.printProfile?.profileId);
  }

  updateMapping(row: ImportRow, mapping: PlateMappingState): void {
    this.patchRow(row.modelId, { mapping });
  }

  // Kurzbeschreibung, was beim Anlegen entsteht (z. B. "2 Produkte").
  planSummary(row: ImportRow): string | null {
    if (!row.mapping || !row.preview) return null;
    const plan = this.planFor(row);
    const withParts = plan.filter((p) => p.parts.length > 0);
    if (plan.length > 1) return `→ ${plan.length} Produkte`;
    if (withParts.length === 1) return `→ 1 Produkt mit ${withParts[0].parts.length} Farbteilen`;
    return '→ 1 einfarbiges Produkt';
  }

  private planFor(row: ImportRow) {
    const mapping = row.mapping ?? { mode: 'combined' as const, areaNames: {}, plateNames: {}, selectedPlate: null };
    return planProducts(mapping, row.name, row.plates, {
      weightG: row.preview?.estimatedWeightG ?? null,
      printTimeMin: row.preview?.estimatedPrintMinutes ?? null,
      imageUrl: row.preview?.images[0] ?? null,
    });
  }

  updateDescription(row: ImportRow, description: string): void {
    this.patchRow(row.modelId, { description });
  }

  updateTags(row: ImportRow, tagsText: string): void {
    this.patchRow(row.modelId, { tagsText });
  }

  toggleSelected(row: ImportRow, selected: boolean): void {
    this.patchRow(row.modelId, { selected });
  }

  selectAll(selected: boolean): void {
    this.rows.update((rows) =>
      rows.map((r) => (r.state === 'neu' && r.importState !== 'angelegt' ? { ...r, selected: selected && r.name.trim().length > 0 } : r)),
    );
  }

  coverOf(row: ImportRow): string | null {
    return row.preview?.images[0] ?? null;
  }

  private totalPrintMinutes(row: ImportRow): number | null {
    if (row.preview?.estimatedPrintMinutes != null) return row.preview.estimatedPrintMinutes;
    const known = row.plates.filter((p) => p.printMinutes != null);
    return known.length > 0 ? known.reduce((sum, p) => sum + (p.printMinutes ?? 0), 0) : null;
  }

  private totalWeightG(row: ImportRow): number | null {
    if (row.preview?.estimatedWeightG != null) return row.preview.estimatedWeightG;
    const known = row.plates.filter((p) => p.weightG != null);
    return known.length > 0 ? known.reduce((sum, p) => sum + (p.weightG ?? 0), 0) : null;
  }

  isLongPrint(row: ImportRow): boolean {
    const minutes = this.totalPrintMinutes(row);
    return minutes !== null && minutes >= LONG_PRINT_MINUTES;
  }

  isHeavyPrint(row: ImportRow): boolean {
    const weight = this.totalWeightG(row);
    return weight !== null && weight >= HEAVY_PRINT_WEIGHT_G;
  }

  formatMinutes(minutes: number | null): string {
    if (minutes === null) return '–';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
  }

  /** Kategorie zum Zeitpunkt des Anlegens: CSV-Zeile, sonst globales Feld. */
  private currentCategory(row: ImportRow): string | null {
    return this.resolveCategory(row.ownCategory);
  }

  /** Mit Kategorie (Massenimport) wird aktiv angelegt (Spec massenimport §3.4). */
  isMassenimport(row: ImportRow): boolean {
    return this.currentCategory(row) !== null;
  }

  /** Auswahlliste der Druckprofile (Standard-Drucker zuerst). */
  profileOptions(row: ImportRow): { label: string; value: number }[] {
    const profiles = [...(row.preview?.profiles ?? [])].sort((a, b) => Number(b.isTarget) - Number(a.isTarget));
    return profiles.map((p) => ({
      label:
        `${p.printer ?? 'Drucker ?'} – ${p.title ?? 'Profil ' + p.id}` +
        ` (${p.plateCount} ${p.plateCount === 1 ? 'Platte' : 'Platten'}${p.multicolor ? ', mehrfarbig' : ''})`,
      value: p.id,
    }));
  }

  currentProfileId(row: ImportRow): number | null {
    return row.profileId ?? row.preview?.printProfile?.profileId ?? null;
  }

  /** Gewähltes Profil ist mehrfarbig, es gibt aber ein einfarbiges. */
  hasSingleColorAlternative(row: ImportRow): boolean {
    const profiles = row.preview?.profiles ?? [];
    const current = profiles.find((p) => p.id === this.currentProfileId(row));
    return !!current?.multicolor && profiles.some((p) => !p.multicolor);
  }

  async changeProfile(row: ImportRow, profileId: number | null): Promise<void> {
    const accessToken = this.authService.session()?.access_token;
    if (!accessToken || !profileId || profileId === this.currentProfileId(row)) return;
    this.patchRow(row.modelId, { profileId });
    await this.fetchPreview({ ...row, profileId }, accessToken);
  }

  analysisHint(row: ImportRow): string | null {
    return plateAnalysisHint(row.preview?.plateAnalysis, true);
  }

  /** Platten mit mehreren Filamenten (AMS), entfernte Farben berücksichtigt. */
  multicolorPlates(row: ImportRow): number[] {
    return multicolorPlateNos(row.plates, row.mapping?.removedAreas ?? []);
  }

  categoryOf(row: ImportRow): string | null {
    return this.currentCategory(row) ?? row.preview?.category ?? null;
  }

  private parseTags(text: string): string[] {
    return mergeTagsCaseInsensitive(text.split(','));
  }

  async importSelected(): Promise<void> {
    const targets = this.rows().filter((r) => r.selected && r.state === 'neu' && r.importState !== 'angelegt');
    if (targets.length === 0) return;
    this.selectedImportTotal.set(targets.length);
    this.importing.set(true);
    this.error.set(null);
    try {
      for (const row of targets) {
        const name = row.name.trim();
        if (!name || !row.preview) {
          this.patchRow(row.modelId, { importState: 'fehler', importError: 'Name fehlt.' });
          continue;
        }
        const plan = this.planFor(row);
        const planProblem = planError(plan);
        if (planProblem) {
          this.patchRow(row.modelId, { importState: 'fehler', importError: planProblem });
          continue;
        }
        this.patchRow(row.modelId, { importState: 'lade', importError: null });
        try {
          const modelImages = row.preview.images;
          let productId: string | null = null;
          for (const planned of plan) {
            // Je Platte: Plattenbild zuerst, danach die Modellbilder.
            const imageUrls = planned.plateNo !== null && planned.imageUrl
              ? [planned.imageUrl, ...modelImages.filter((u) => u !== planned.imageUrl)]
              : modelImages;
            const id = await this.makerworldService.importProduct({
              modelId: row.modelId,
              url: row.url,
              originalTitle: row.preview.title,
              name: planned.name,
              images: imageUrls.map((url) => ({ url, source_type: 'extern_link' as const })),
              tags: this.parseTags(row.tagsText),
              category: this.categoryOf(row),
              weightG: planned.weightG,
              printTimeMin: planned.printTimeMin,
              suggestionId: this.suggestionId(),
              active: this.isMassenimport(row),
              plateNo: planned.plateNo,
              parts: planned.parts,
              variants: planned.variants ?? null,
              // Modellgröße gilt nur bei einem Produkt je Modell, nicht je Platte.
              sizeLabel: plan.length === 1 ? (row.preview.sizeHint ?? null) : null,
              // Beschreibung beschreibt das ganze Modell, daher nicht je Platte.
              description: plan.length === 1 ? row.description : null,
            });
            productId ??= id;
          }
          this.patchRow(row.modelId, { importState: 'angelegt', productId, createdCount: plan.length, selected: false, massenimport: this.isMassenimport(row) });
        } catch (e) {
          const err = e as { message?: string };
          this.patchRow(row.modelId, { importState: 'fehler', importError: err?.message ?? 'Anlegen fehlgeschlagen.' });
        }
      }
    } finally {
      this.importing.set(false);
    }
  }
}
