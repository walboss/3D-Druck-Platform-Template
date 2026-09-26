import { Component, ElementRef, EventEmitter, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';
import { environment } from '../../../environments/environment';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void },
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
  template: '<div #container></div>',
})
export class TurnstileWidget implements OnInit, OnDestroy {
  @Output() readonly verified = new EventEmitter<string>();
  @Output() readonly expired = new EventEmitter<void>();

  @ViewChild('container', { static: true }) containerRef!: ElementRef<HTMLElement>;

  private widgetId: string | null = null;

  ngOnInit(): void {
    this.loadScript()
      .then(() => this.render())
      .catch(() => this.verified.emit(''));
  }

  ngOnDestroy(): void {
    if (this.widgetId && window.turnstile) {
      window.turnstile.remove(this.widgetId);
    }
  }

  /** Neues Token anfordern — ein Turnstile-Token gilt nur für eine Prüfung. */
  reset(): void {
    if (this.widgetId && window.turnstile) {
      window.turnstile.reset(this.widgetId);
    }
  }

  private loadScript(): Promise<void> {
    if (window.turnstile) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const existing = document.getElementById(SCRIPT_ID);
      if (existing) {
        existing.addEventListener('load', () => resolve());
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
    if (!window.turnstile) return;
    this.widgetId = window.turnstile.render(this.containerRef.nativeElement, {
      sitekey: environment.turnstileSiteKey,
      callback: (token: string) => this.verified.emit(token),
      'expired-callback': () => this.expired.emit(),
    });
  }
}
