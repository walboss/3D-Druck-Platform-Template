// Tag-Bereinigung fuer MakerWorld-Import und manuelle Tag-Eingabe (Admin).
// Fund 2026-09-21: MakerWorld-Tags bzw. die KI-Uebersetzung konnten HTML-
// Entities enthalten (z. B. "&amp;#39;decor" statt "'decor"), und Tags wurden
// nur case-sensitiv dedupliziert ("DECO" neben "deco"). decodeHtmlEntities
// loest auch mehrfach kodierte Entities auf (wiederholtes Ersetzen bis
// stabil); mergeTagsCaseInsensitive haelt die zuerst gesehene Schreibweise.

export function decodeHtmlEntities(input: string): string {
  let value = input;
  for (let i = 0; i < 5; i++) {
    const before = value;
    value = value
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    if (value === before) break;
  }
  return value;
}

export function sanitizeTag(raw: string): string {
  return decodeHtmlEntities(raw).trim().replace(/\s+/g, ' ');
}

export function mergeTagsCaseInsensitive(...groups: string[][]): string[] {
  const seen = new Map<string, string>();
  for (const group of groups) {
    for (const rawTag of group) {
      const cleaned = sanitizeTag(rawTag);
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (!seen.has(key)) seen.set(key, cleaned);
    }
  }
  return Array.from(seen.values());
}
