import { MakerworldImportResult } from '../../../core/services/worker-api.service';
import { MakerworldPlate, PlateMappingState } from '../../../core/utils/makerworld-plates.util';

// Typen, Konstanten und CSV-Parser des MakerWorld-Imports (aus
// admin-makerworld-import.ts ausgelagert, Verhalten unverändert).

export type RowState = 'wartet' | 'lade' | 'neu' | 'vorhanden' | 'fehler';
export type ImportState = 'offen' | 'lade' | 'angelegt' | 'fehler';

export interface ImportRow {
  url: string;
  modelId: string;
  state: RowState;
  error: string | null;
  preview: MakerworldImportResult | null;
  existingProductId: string | null;
  // editierbar
  name: string;
  tagsText: string;
  // 00203: Beschreibung (Vorschlag aus dem Worker, editierbar)
  description: string;
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
  // Eigene Kategorie aus der CSV-Zeile (null = keine). Kategorie und „aktiv“
  // werden beim Anlegen neu bestimmt, damit ein später eingetragenes globales
  // Kategoriefeld noch greift (Live-Fund 2026-11-15).
  ownCategory: string | null;
  // Gewähltes Druckprofil (null = Standard-Drucker), Profilauswahl 2026-11-15
  profileId: number | null;
  csvNameOverride: string | null;
  csvTagsExtra: string[];
  // 00198: Druckplatten + Zuordnung (null = nur eine Platte/Farbe)
  plates: MakerworldPlate[];
  mapping: PlateMappingState | null;
  createdCount: number;
}

export interface ImportEntry {
  link: string;
  source: 'link' | 'csv';
  category: string | null;
  name: string | null;
  tags: string[];
}

// Auch ohne Sprachpfad (App-Links: makerworld.com/models/<id>?appSharePlatform=copy).
export const MODEL_ID_PATTERN = /(?<![\w-])makerworld\.com(?:\/[^\s/]+)*?\/models\/(\d+)/i;
export const PREVIEW_CONCURRENCY = 3;
export const PROGRESS_THRESHOLD = 30;
// Optischer Hinweis beim Import (Wunsch des Betreibers, 2026-09-26), bezogen aufs ganze Modell.
export const LONG_PRINT_MINUTES = 240;
export const HEAVY_PRINT_WEIGHT_G = 200;

export function parseCsvLine(line: string): string[] {
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
export function parseCsv(text: string): { entries: ImportEntry[]; error: string | null } {
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
