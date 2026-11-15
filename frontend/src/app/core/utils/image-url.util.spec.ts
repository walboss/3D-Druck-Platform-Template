import { sizedImageUrl } from './image-url.util';

describe('sizedImageUrl', () => {
  const original = 'https://makerworld.bblmw.com/makerworld/model/US1/design/bild.png';

  it('hängt für den MakerWorld-Bild-Host die Verkleinerung an', () => {
    expect(sizedImageUrl(original, 600)).toBe(`${original}?x-oss-process=image/resize,w_600/format,webp`);
  });

  it('lässt fremde Hosts unverändert', () => {
    const other = 'https://example.com/bild.png';
    expect(sizedImageUrl(other, 600)).toBe(other);
  });

  it('lässt URLs mit eigenen Parametern unverändert', () => {
    const withQuery = `${original}?v=2`;
    expect(sizedImageUrl(withQuery, 600)).toBe(withQuery);
  });

  it('lässt data:-URLs und ungültige Werte unverändert', () => {
    expect(sizedImageUrl('data:image/png;base64,AAAA', 600)).toBe('data:image/png;base64,AAAA');
    expect(sizedImageUrl('kein-link', 600)).toBe('kein-link');
  });

  it('gibt null für leere Werte zurück', () => {
    expect(sizedImageUrl(null, 600)).toBeNull();
    expect(sizedImageUrl('', 600)).toBeNull();
  });
});
