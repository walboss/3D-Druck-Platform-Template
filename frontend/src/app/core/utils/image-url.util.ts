// Produktbilder kommen als Hotlink vom MakerWorld-Bild-Host in Originalgröße
// (bis ~4 MB, 1920×1440). Der Host liefert per URL-Zusatz verkleinerte
// WebP-Varianten (getestet 2026-11-14: 9 kB statt 2,7 MB bei 400 px Breite).
// Nur für bekannte Hosts und nur, wenn die URL noch keine eigenen Parameter
// hat — alle anderen Bild-URLs bleiben unverändert.
const RESIZABLE_IMAGE_HOSTS = new Set(['makerworld.bblmw.com']);

export function sizedImageUrl(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !RESIZABLE_IMAGE_HOSTS.has(parsed.hostname) || parsed.search) {
      return url;
    }
    return `${url}?x-oss-process=image/resize,w_${Math.round(width)}/format,webp`;
  } catch {
    return url;
  }
}
