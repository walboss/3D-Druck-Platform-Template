import { Injectable } from '@angular/core';

// Spec like-system.md §3: zufällige, anonyme Cookie-ID pro Browser,
// analog zum cart_sessions-Muster (dort localStorage, hier Cookie), ~1 Jahr
// Laufzeit, rein funktional (kein Tracking/Fingerprinting).
const VISITOR_COOKIE_NAME = 'mw_visitor_id';
const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Cookie-Zeile für die Like-ID. Auf https mit `Secure`, damit das Cookie nie
 * unverschlüsselt übertragen wird (OFFENE-SECURITY-FIXES / Review D34).
 * Auf http (lokaler Dev-Server) ohne Secure. Bestehende Cookies ohne Flag
 * bleiben bis zu ihrem Ablauf gültig.
 */
export function visitorCookieString(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSeconds}; path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
}

@Injectable({ providedIn: 'root' })
export class VisitorService {
  private token: string | null = null;

  getToken(): string {
    if (this.token) return this.token;
    const existing = this.readCookie(VISITOR_COOKIE_NAME);
    if (existing) {
      this.token = existing;
      return existing;
    }
    const created = crypto.randomUUID();
    this.writeCookie(VISITOR_COOKIE_NAME, created, VISITOR_COOKIE_MAX_AGE_SECONDS);
    this.token = created;
    return created;
  }

  private readCookie(name: string): string | null {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  private writeCookie(name: string, value: string, maxAgeSeconds: number): void {
    document.cookie = visitorCookieString(name, value, maxAgeSeconds, location.protocol === 'https:');
  }
}
