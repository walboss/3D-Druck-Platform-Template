// Saison-Kategorien (Migration 00187): jährlich wiederkehrender Zeitraum
// TT.MM–TT.MM, darf über den Jahreswechsel gehen (z. B. 01.12.–06.01.).
export interface CategorySeason {
  id: string;
  category: string;
  start_month: number;
  start_day: number;
  end_month: number;
  end_day: number;
  active: boolean;
  banner_title: string | null;
  banner_text: string | null;
}

function toKey(month: number, day: number): number {
  return month * 100 + day;
}

export function isInSeason(season: CategorySeason, date: Date = new Date()): boolean {
  const today = toKey(date.getMonth() + 1, date.getDate());
  const start = toKey(season.start_month, season.start_day);
  const end = toKey(season.end_month, season.end_day);
  return start <= end ? today >= start && today <= end : today >= start || today <= end;
}

// Länge in Tagen (Referenzjahr 2001, kein Schaltjahr) — kürzerer Zeitraum
// gewinnt bei Überschneidung (Halloween vor Herbst).
export function seasonLengthDays(season: CategorySeason): number {
  const day = 24 * 60 * 60 * 1000;
  const start = Date.UTC(2001, season.start_month - 1, season.start_day);
  let end = Date.UTC(2001, season.end_month - 1, season.end_day);
  if (end < start) end = Date.UTC(2002, season.end_month - 1, season.end_day);
  return Math.round((end - start) / day) + 1;
}

// Aktive Saisons von heute, kürzester Zeitraum zuerst.
export function currentSeasons(seasons: CategorySeason[], date: Date = new Date()): CategorySeason[] {
  return seasons
    .filter((s) => s.active && isInSeason(s, date))
    .sort((a, b) => seasonLengthDays(a) - seasonLengthDays(b));
}

export function currentSeasonCategories(seasons: CategorySeason[], date: Date = new Date()): string[] {
  return currentSeasons(seasons, date).map((s) => s.category.trim());
}

export function formatSeasonRange(season: CategorySeason): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(season.start_day)}.${pad(season.start_month)}. – ${pad(season.end_day)}.${pad(season.end_month)}.`;
}
