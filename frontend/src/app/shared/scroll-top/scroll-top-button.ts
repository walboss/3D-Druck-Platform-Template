import { Component, HostListener, input, signal } from '@angular/core';

// Pfeil unten rechts, erscheint nach etwas Scrollen und springt weich an den
// Seitenanfang. Beide Layouts scrollen im Fenster (nicht in einem Container).
const SHOW_AFTER_PX = 400;

@Component({
  selector: 'app-scroll-top-button',
  standalone: true,
  template: `
    <button
      type="button"
      class="scroll-top-btn"
      [class.visible]="visible()"
      [class.above-bottom-nav]="aboveBottomNav()"
      [attr.tabindex]="visible() ? 0 : -1"
      [attr.aria-hidden]="!visible()"
      aria-label="Nach oben scrollen"
      (click)="scrollToTop()"
    >
      <i class="pi pi-arrow-up"></i>
    </button>
  `,
  styles: `
    .scroll-top-btn {
      position: fixed;
      right: 1rem;
      bottom: calc(1rem + env(safe-area-inset-bottom));
      z-index: 90;
      width: 44px;
      height: 44px;
      border: 1px solid var(--app-border);
      border-radius: 999px;
      background: var(--app-surface);
      color: var(--app-text);
      box-shadow: var(--app-shadow-md);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px);
      transition: opacity 0.2s ease, transform 0.2s ease;

      &.visible {
        opacity: 1;
        pointer-events: auto;
        transform: none;
      }

      &:hover {
        background: var(--app-surface-hover);
      }
    }

    // Storefront: auf Mobil liegt die feste Bottom-Nav unten -> darueber.
    @media (max-width: 767px) {
      .scroll-top-btn.above-bottom-nav {
        bottom: calc(var(--app-bottom-nav-height) + 1rem + env(safe-area-inset-bottom));
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .scroll-top-btn {
        transition: none;
      }
    }
  `,
})
export class ScrollTopButton {
  readonly aboveBottomNav = input(false);
  readonly visible = signal(false);

  @HostListener('window:scroll')
  onScroll(): void {
    this.visible.set(window.scrollY > SHOW_AFTER_PX);
  }

  scrollToTop(): void {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }
}
