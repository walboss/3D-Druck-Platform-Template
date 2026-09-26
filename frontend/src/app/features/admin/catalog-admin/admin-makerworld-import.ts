import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { ButtonModule } from 'primeng/button';
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
  MakerworldPlate,
  PlateMappingState,
  defaultMappingState,
  hasPlateChoice,
  planError,
  planProducts,
} from '../../../core/utils/makerworld-plates.util';
import { MakerworldPlateMapping } from '../../../shared/makerworld-plates/makerworld-plate-mapping';

// Spec 27 §6 "MakerWorld-Import" (Vorschläge-Review, unverändert: kein
// Kategorie-Eintrag -> Kategorie kommt von MakerWorld, Produkt bleibt
// inaktiv) + specs/massenimport-makerworld-kollektion.md (Massenimport:
// Kategorie-Feld/CSV gesetzt -> Kategorie wird überschrieben, Produkt sofort
// aktiv, keine Kalkulation). Beide Wege teilen sich diesen Screen und die
// bestehende Vorschau-/Anlege-Logik je Zeile.

type RowState = 'wartet' | 'lade' | 'neu' | 'vorhanden' | 'fehler';
type ImportState = 'offen' | 'lade' | 'angelegt' | 'fehler';

interface ImportRow {
  url: string;
  modelId: string;
  state: RowState;
  error: string | null;
  preview: MakerworldImportResult | null;
  existingProductId: string | null;
  // editierbar
  name: string;
  tagsText: string;
  selected: boolean;
  importState: ImportState;
  importError: string | null;
  productId: string | null;
  // Massenimport (Spec massenimport §2/§3): Herkunft der Zeile, aufgelöste
  // Kategorie (CSV-Spalte oder globales Feld, null = Fallback auf
  // MakerWorld-Kategorie wie bisher) und ob active=true gesetzt wird.
  source: 'link' | 'csv';
  resolvedCategory: string | null;
  massenimport: boolean;
  csvNameOverride: string | null;
  csvTagsExtra: string[];
  // 00198: Druckplatten + Zuordnung (null = nur eine Platte/Farbe)
  plates: MakerworldPlate[];
  mapping: PlateMappingState | null;
  createdCount: number;
}

interface ImportEntry {
  link: string;
  source: 'link' | 'csv';
  category: string | null;
  name: string | null;
  tags: string[];
}

// Auch ohne Sprachpfad (App-Links: makerworld.com/models/<id>?appSharePlatform=copy).
const MODEL_ID_PATTERN = /(?<![\w-])makerworld\.com(?:\/[^\s/]+)*?\/models\/(\d+)/i;
const PREVIEW_CONCURRENCY = 3;
const PROGRESS_THRESHOLD = 30;
// Optischer Hinweis beim Import (Wunsch des Betreibers, 2026-09-26), bezogen aufs ganze Modell.
const LONG_PRINT_MINUTES = 240;
const HEAVY_PRINT_WEIGHT_G = 200;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Weg B (CSV-Upload): Header link,category,name,tags — Spalten category/
// name/tags optional, Reihenfolge egal, siehe specs/massenimport-makerworld-kollektion.md §2.
function parseCsv(text: string): { entries: ImportEntry[]; error: string | null } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { entries: [], error: 'CSV-Datei ist leer.' };
  }
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const linkIdx = header.indexOf('link');
  if (linkIdx === -1) {
    return { entries: [], error: 'CSV-Header muss eine Spalte „link" enthalten (link,category,name,tags).' };
  }
  const categoryIdx = header.indexOf('category');
  const nameIdx = header.indexOf('name');
  const tagsIdx = header.indexOf('tags');

  const entries: ImportEntry[] = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const link = (cols[linkIdx] ?? '').trim();
    if (!link) continue;
    const tagsCell = tagsIdx >= 0 ? (cols[tagsIdx] ?? '') : '';
    entries.push({
      link,
      source: 'csv',
      category: categoryIdx >= 0 ? (cols[categoryIdx]?.trim() || null) : null,
      name: nameIdx >= 0 ? (cols[nameIdx]?.trim() || null) : null,
      tags: tagsCell
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    });
  }
  return { entries, error: null };
}

@Component({
  selector: 'app-admin-makerworld-import',
  standalone: true,
  imports: [
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
    if (link) {
      this.linksText.set(link);
      this.suggestionId.set(suggestion);
      void this.loadPreview();
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
          selected: false,
          importState: 'offen',
          importError: null,
          productId: null,
          source: entry.source,
          resolvedCategory: null,
          massenimport: false,
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
        selected: false,
        importState: 'offen',
        importError: null,
        productId: null,
        source: entry.source,
        resolvedCategory: category,
        massenimport,
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
          this.patchRow(row.modelId, { state: 'lade' });
          try {
            const preview = await this.workerApi.importMakerworldEstimates(accessToken, row.url);
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
              mapping: hasPlateChoice(plates) ? defaultMappingState(plates, name) : null,
              name,
              tagsText: mergedTags.join(', '),
              selected: name.length > 0,
            });
          } catch (e) {
            const err = e as { error?: { error?: string } };
            this.patchRow(row.modelId, {
              state: 'fehler',
              error: err?.error?.error ?? 'MakerWorld-Abfrage fehlgeschlagen.',
            });
          }
        }
      };
      await Promise.all(Array.from({ length: PREVIEW_CONCURRENCY }, () => worker()));
    } catch {
      this.error.set('Vorschau konnte nicht geladen werden.');
    } finally {
      this.loadingPreview.set(false);
    }
  }

  updateName(row: ImportRow, name: string): void {
    this.patchRow(row.modelId, { name, selected: row.selected && name.trim().length > 0 });
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

  categoryOf(row: ImportRow): string | null {
    return row.resolvedCategory ?? row.preview?.category ?? null;
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
              active: row.massenimport,
              plateNo: planned.plateNo,
              parts: planned.parts,
            });
            productId ??= id;
          }
          this.patchRow(row.modelId, { importState: 'angelegt', productId, createdCount: plan.length, selected: false });
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
