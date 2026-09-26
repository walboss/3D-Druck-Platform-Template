import { Injectable, signal } from '@angular/core';

export type AppTheme = 'light' | 'dark';

const STORAGE_KEY = 'app-theme';

/**
 * Verwaltet Light/Dark-Theme: folgt standardmäßig prefers-color-scheme,
 * ein manueller Umschalter überschreibt das und wird in localStorage persistiert.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');
  private explicit = this.readStored() !== null;

  readonly theme = signal<AppTheme>(this.readStored() ?? (this.media.matches ? 'dark' : 'light'));

  constructor() {
    this.apply(this.theme());
    this.media.addEventListener('change', (event) => {
      if (!this.explicit) {
        this.set(event.matches ? 'dark' : 'light');
      }
    });
  }

  toggle(): void {
    this.explicit = true;
    const next: AppTheme = this.theme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, next);
    this.set(next);
  }

  private set(theme: AppTheme): void {
    this.theme.set(theme);
    this.apply(theme);
  }

  private apply(theme: AppTheme): void {
    document.documentElement.setAttribute('data-theme', theme);
  }

  private readStored(): AppTheme | null {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  }
}
