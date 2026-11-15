import { CategorySeason, currentSeasons, formatSeasonRange, isInSeason, seasonLengthDays } from './season.util';

const season = (category: string, sm: number, sd: number, em: number, ed: number, active = true): CategorySeason => ({
  id: category,
  category,
  start_month: sm,
  start_day: sd,
  end_month: em,
  end_day: ed,
  active,
  banner_title: null,
  banner_text: null,
});

describe('season.util', () => {
  const weihnachten = season('Weihnachten', 12, 1, 1, 6);

  it('erkennt Zeitraum über den Jahreswechsel', () => {
    expect(isInSeason(weihnachten, new Date(2026, 11, 24))).toBe(true);
    expect(isInSeason(weihnachten, new Date(2027, 0, 6))).toBe(true);
    expect(isInSeason(weihnachten, new Date(2027, 0, 7))).toBe(false);
    expect(isInSeason(weihnachten, new Date(2026, 5, 1))).toBe(false);
  });

  it('berechnet die Länge in Tagen', () => {
    expect(seasonLengthDays(weihnachten)).toBe(37);
    expect(seasonLengthDays(season('Oktober', 10, 1, 10, 31))).toBe(31);
  });

  it('sortiert aktive Saisons nach kürzestem Zeitraum und ignoriert inaktive', () => {
    const herbst = season('Herbst', 9, 1, 11, 30);
    const halloween = season('Halloween', 10, 1, 10, 31);
    const aus = season('Aus', 10, 1, 10, 31, false);
    const result = currentSeasons([herbst, aus, halloween], new Date(2026, 9, 15));
    expect(result.map((s) => s.category)).toEqual(['Halloween', 'Herbst']);
  });

  it('formatiert den Zeitraum', () => {
    expect(formatSeasonRange(weihnachten)).toBe('01.12. – 06.01.');
  });
});
