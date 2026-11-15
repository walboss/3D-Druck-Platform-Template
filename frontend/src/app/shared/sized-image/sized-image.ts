import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { sizedImageUrl } from '../../core/utils/image-url.util';

// Produktbild in passender Größe laden (statt Original, siehe
// image-url.util.ts) mit zwei Rückfallstufen:
//   1. verkleinerte Variante lädt nicht -> Original-URL versuchen
//   2. Original lädt auch nicht -> Bild ausblenden und das Elternelement mit
//      .image-failed markieren (Platzhalter-Symbol, styles.scss) — sonst
//      zeigt der Browser den Alt-Text groß in der Karte.
@Directive({
  selector: 'img[appSizedSrc]',
  standalone: true,
  host: { '(error)': 'onError()' },
})
export class SizedImage {
  readonly appSizedSrc = input.required<string | null | undefined>();
  /** Zielbreite in Pixeln (schon inkl. Reserve für hochauflösende Displays). */
  readonly appSizedWidth = input(600);

  private readonly img = inject<ElementRef<HTMLImageElement>>(ElementRef).nativeElement;
  private triedOriginal = false;

  constructor() {
    effect(() => {
      const original = this.appSizedSrc();
      const sized = sizedImageUrl(original, this.appSizedWidth());
      this.triedOriginal = !original || sized === original;
      if (!sized) {
        this.markFailed();
        return;
      }
      this.img.style.display = '';
      this.img.parentElement?.classList.remove('image-failed');
      this.img.src = sized;
    });
  }

  onError(): void {
    const original = this.appSizedSrc();
    if (!this.triedOriginal && original) {
      this.triedOriginal = true;
      this.img.src = original;
      return;
    }
    this.markFailed();
  }

  private markFailed(): void {
    // Inline-Stil statt hidden-Attribut: die globale Regel img { display: block }
    // würde das Attribut überstimmen.
    this.img.style.display = 'none';
    this.img.parentElement?.classList.add('image-failed');
  }
}
