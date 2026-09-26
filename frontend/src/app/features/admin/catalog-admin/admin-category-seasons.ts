import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { AutoCompleteModule, AutoCompleteCompleteEvent } from 'primeng/autocomplete';

import { AdminCatalogService } from '../../../core/services/admin-catalog.service';
import { AdminCategorySeasonsService } from '../../../core/services/admin-category-seasons.service';
import { AdminSettingsService } from '../../../core/services/admin-settings.service';
import { CategorySeason, currentSeasons, formatSeasonRange, isInSeason } from '../../../core/utils/season.util';

// "TT.MM" bzw. "TT.MM." — gültige Tage je Monat (29.02. erlaubt).
const DATE_PATTERN = /^(\d{1,2})\.(\d{1,2})\.?$/;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function parseDayMonth(value: string): { day: number; month: number } | null {
  const m = DATE_PATTERN.exec(value.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
  return { day, month };
}

// Saison-Kategorien (Migration 00187, Entscheidung 2026-09-24):
// pro Kategorie ein jährlich wiederkehrender Zeitraum. Im Zeitraum steht die
// Kategorie im Storefront-Filter zuerst und ihre Produkte oben. Kein Löschen,
// nur deaktivieren (Prinzip #2).
@Component({
  selector: 'app-admin-category-seasons',
  standalone: true,
  imports: [
    FormsModule,
    TableModule,
    ButtonModule,
    ToggleSwitchModule,
    SkeletonModule,
    MessageModule,
    DialogModule,
    InputTextModule,
    AutoCompleteModule,
  ],
  templateUrl: './admin-category-seasons.html',
  styleUrl: './admin-category-seasons.scss',
})
export class AdminCategorySeasons implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly seasons = signal<CategorySeason[]>([]);
  readonly knownCategories = signal<string[]>([]);
  readonly categorySuggestions = signal<string[]>([]);
  // Globaler Schalter in den Settings (Migration 00189)
  readonly seasonsDisabled = signal(false);

  readonly dialogVisible = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly formCategory = signal('');
  readonly formStart = signal('');
  readonly formEnd = signal('');
  readonly formBannerTitle = signal('');
  readonly formBannerText = signal('');
  readonly saving = signal(false);
  readonly dialogError = signal<string | null>(null);

  readonly formatRange = formatSeasonRange;

  // Vorschau: welche Saison stünde an einem gewählten Tag oben (Banner =
  // erste). Nur aktive Zeiträume, Reihenfolge wie im Katalog.
  readonly previewDate = signal('');
  readonly previewInvalid = computed(() => this.previewDate().trim() !== '' && !parseDayMonth(this.previewDate()));
  readonly previewResult = computed<CategorySeason[] | null>(() => {
    const parsed = parseDayMonth(this.previewDate());
    if (!parsed) return null;
    // Schaltjahr als Referenz, damit 29.02. geht
    return currentSeasons(this.seasons(), new Date(2028, parsed.month - 1, parsed.day));
  });
  readonly isCurrent = (s: CategorySeason) => s.active && isInSeason(s);

  constructor(
    private readonly seasonsService: AdminCategorySeasonsService,
    private readonly catalogService: AdminCatalogService,
    private readonly settingsService: AdminSettingsService,
    private readonly router: Router,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [seasons, categories, settings] = await Promise.all([
        this.seasonsService.list(),
        this.catalogService.listCategories().catch(() => []),
        this.settingsService.getSettings().catch(() => null),
      ]);
      this.seasons.set(seasons);
      this.seasonsDisabled.set(settings?.storefrontSeasonsEnabled === false);
      this.knownCategories.set(categories);
    } catch {
      this.error.set('Saison-Kategorien konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  back(): void {
    this.router.navigate(['/admin/katalog']);
  }

  searchCategories(event: AutoCompleteCompleteEvent): void {
    const q = event.query.trim().toLocaleLowerCase('de');
    this.categorySuggestions.set(
      q ? this.knownCategories().filter((c) => c.toLocaleLowerCase('de').includes(q)) : [...this.knownCategories()],
    );
  }

  async toggleActive(season: CategorySeason, active: boolean): Promise<void> {
    this.error.set(null);
    try {
      await this.seasonsService.setActive(season.id, active);
      this.seasons.update((list) => list.map((s) => (s.id === season.id ? { ...s, active } : s)));
    } catch {
      this.error.set('Status konnte nicht geändert werden.');
    }
  }

  openCreateDialog(): void {
    this.editingId.set(null);
    this.formCategory.set('');
    this.formStart.set('');
    this.formEnd.set('');
    this.formBannerTitle.set('');
    this.formBannerText.set('');
    this.dialogError.set(null);
    this.dialogVisible.set(true);
  }

  openEditDialog(season: CategorySeason): void {
    const pad = (n: number) => String(n).padStart(2, '0');
    this.editingId.set(season.id);
    this.formCategory.set(season.category);
    this.formStart.set(`${pad(season.start_day)}.${pad(season.start_month)}.`);
    this.formEnd.set(`${pad(season.end_day)}.${pad(season.end_month)}.`);
    this.formBannerTitle.set(season.banner_title ?? '');
    this.formBannerText.set(season.banner_text ?? '');
    this.dialogError.set(null);
    this.dialogVisible.set(true);
  }

  startInvalid(): boolean {
    return this.formStart().trim() !== '' && !parseDayMonth(this.formStart());
  }

  endInvalid(): boolean {
    return this.formEnd().trim() !== '' && !parseDayMonth(this.formEnd());
  }

  canSave(): boolean {
    return (
      (this.formCategory() ?? '').trim().length > 0 &&
      parseDayMonth(this.formStart()) !== null &&
      parseDayMonth(this.formEnd()) !== null
    );
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    const start = parseDayMonth(this.formStart())!;
    const end = parseDayMonth(this.formEnd())!;
    const category = this.formCategory().trim();
    const duplicate = this.seasons().some(
      (s) => s.id !== this.editingId() && s.category.trim().toLowerCase() === category.toLowerCase(),
    );
    if (duplicate) {
      this.dialogError.set('Für diese Kategorie gibt es schon einen Zeitraum.');
      return;
    }
    const input = {
      category,
      start_month: start.month,
      start_day: start.day,
      end_month: end.month,
      end_day: end.day,
      banner_title: this.formBannerTitle().trim() || null,
      banner_text: this.formBannerText().trim() || null,
    };
    this.saving.set(true);
    this.dialogError.set(null);
    try {
      const id = this.editingId();
      if (id) {
        await this.seasonsService.update(id, input);
      } else {
        await this.seasonsService.create(input);
      }
      this.dialogVisible.set(false);
      await this.load();
    } catch {
      this.dialogError.set(this.editingId() ? 'Speichern fehlgeschlagen.' : 'Anlegen fehlgeschlagen.');
    } finally {
      this.saving.set(false);
    }
  }
}
