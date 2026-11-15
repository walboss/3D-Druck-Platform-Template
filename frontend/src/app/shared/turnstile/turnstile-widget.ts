import { Component, ElementRef, EventEmitter, OnDestroy, OnInit, Output, ViewChild, signal } from '@angular/core';
import { environment } from '../../../environments/environment';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'expired-callback'?: () => void;
          'error-callback'?: () => void;
        },
      ) => string;
      remove: (widgetId: string) => void;
      reset: (widgetId: string) => void;
    };
  }
}

const SCRIPT_ID = 'cf-turnstile-script';

@Component({
  selector: 'app-turnstile-widget',
  standalone: true,
  template: `
    <div #container></div>
    @if (failed()) {
      <div class="turnstile-error" role="alert">
        <span>Die Sicherheitsprüfung konnte nicht geladen werden. Bitte Internetverbindung prüfen und
          ggf. Werbeblocker für diese Seite deaktivieren.</span>
        <button type="button" class="turnstile-retry" (click)="retry()">Erneut versuchen</button>
      </div>
    }
  `,
  styles: `
    .turnstile-error {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
      max-width: 22rem;
      font-size: 0.9rem;
      color: var(--p-red-600, #dc2626);
    }
    .turnstile-retry {
      min-height: 44px;
      padding: 0 1rem;
      border-radius: 999px;
      border: 1px solid var(--app-border);
      background: var(--app-surface);
      color: var(--app-text);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
  `,
})
export class TurnstileWidget implements OnInit, OnDestroy {
  @Output() readonly verified = new EventEmitter<string>();
  @Output() readonly expired = new EventEmitter<void>();

  @ViewChild('container', { static: true }) containerRef!: ElementRef<HTMLElement>;

  /** Skript nicht ladbar oder Widget meldet Fehler -- Kunde sieht Hinweis + "Erneut versuchen". */
  readonly failed = signal(false);

  private widgetId: string | null = null;

  ngOnInit(): void {
    this.start();
  }

  ngOnDestroy(): void {
    this.removeWidget();
  }

  /** Neues Token anfordern — ein Turnstile-Token gilt nur für eine Prüfung. */
  reset(): void {
    if (this.widgetId && window.turnstile) {
      window.turnstile.reset(this.widgetId);
    }
  }

  retry(): void {
    this.failed.set(false);
    this.removeWidget();
    // Fehlgeschlagenes Skript-Tag entfernen, sonst wartet loadScript() ewig auf dessen load-Event.
    if (!window.turnstile) document.getElementById(SCRIPT_ID)?.remove();
    this.start();
  }

  private start(): void {
    this.loadScript()
      .then(() => this.render())
      .catch(() => this.fail());
  }

  private fail(): void {
    this.failed.set(true);
    this.verified.emit('');
  }

  private removeWidget(): void {
    if (this.widgetId && window.turnstile) {
      window.turnstile.remove(this.widgetId);
    }
    this.widgetId = null;
  }

  private loadScript(): Promise<void> {
    if (window.turnstile) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const existing = document.getElementById(SCRIPT_ID);
      if (existing) {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Turnstile-Skript konnte nicht geladen werden')));
        return;
      }
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Turnstile-Skript konnte nicht geladen werden'));
      document.head.appendChild(script);
    });
  }

  private render(): void {
    if (!window.turnstile) {
      this.fail();
      return;
    }
    this.widgetId = window.turnstile.render(this.containerRef.nativeElement, {
      sitekey: environment.turnstileSiteKey,
      callback: (token: string) => {
        this.failed.set(false);
        this.verified.emit(token);
      },
      'expired-callback': () => this.expired.emit(),
      'error-callback': () => this.fail(),
    });
  }
}
