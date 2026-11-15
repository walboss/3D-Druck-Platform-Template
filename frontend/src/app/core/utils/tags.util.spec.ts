import { decodeHtmlEntities, mergeTagsCaseInsensitive, sanitizeTag } from './tags.util';

describe('tags.util', () => {
  it('löst mehrfach kodierte Entities auf', () => {
    expect(decodeHtmlEntities('&amp;#39;decor')).toBe("'decor");
    expect(decodeHtmlEntities('a &amp;amp; b')).toBe('a & b');
  });

  it('bereinigt Tags (Entities, Leerraum)', () => {
    expect(sanitizeTag("  &amp;#39;decor   x ")).toBe("'decor x");
  });

  it('dedupliziert ohne Beachtung der Schreibweise, erste Schreibweise gewinnt', () => {
    expect(mergeTagsCaseInsensitive(['Deco', 'deco'], ['DECO ', 'x', ' '])).toEqual(['Deco', 'x']);
  });
});
