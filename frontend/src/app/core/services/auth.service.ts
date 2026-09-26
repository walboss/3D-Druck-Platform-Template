import { Injectable, signal } from '@angular/core';
import { Session } from '@supabase/supabase-js';
import { SupabaseClientService } from './supabase-client.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly session = signal<Session | null>(null);
  readonly ready = signal(false);

  constructor(private readonly supabase: SupabaseClientService) {
    this.supabase.client.auth.getSession().then(({ data }) => {
      this.session.set(data.session);
      this.ready.set(true);
    });

    this.supabase.client.auth.onAuthStateChange((_event, session) => {
      this.session.set(session);
      this.ready.set(true);
    });
  }

  isLoggedIn(): boolean {
    return this.session() !== null;
  }

  async signInWithPassword(email: string, password: string) {
    const { error } = await this.supabase.client.auth.signInWithPassword({ email, password });
    return { error };
  }

  async signInWithGoogle() {
    const { error } = await this.supabase.client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/admin` },
    });
    return { error };
  }

  async signOut() {
    await this.supabase.client.auth.signOut();
  }

  // ---- 2FA (TOTP) über Supabase Auth MFA ------------------------------
  // Server erzwingt aal2 für alle authenticated-Requests (Migration 00162).

  /** currentLevel/nextLevel der Session. nextLevel 'aal2' = Faktor vorhanden. */
  async getAssuranceLevel(): Promise<{ currentLevel: AalLevel; nextLevel: AalLevel }> {
    const { data, error } = await this.supabase.client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) {
      return { currentLevel: null, nextLevel: null };
    }
    return { currentLevel: toAal(data.currentLevel), nextLevel: toAal(data.nextLevel) };
  }

  /** Alle TOTP-Faktoren des Nutzers (verifiziert und unverifiziert). */
  async listTotpFactors(): Promise<TotpFactor[]> {
    const { data, error } = await this.supabase.client.auth.mfa.listFactors();
    if (error || !data) {
      return [];
    }
    return data.all
      .filter((f) => f.factor_type === 'totp')
      .map((f) => ({ id: f.id, status: f.status, friendlyName: f.friendly_name ?? null }));
  }

  /** Startet TOTP-Enrollment. Liefert QR-Code (SVG-Data-URI) und Secret. */
  async enrollTotp(): Promise<{ factorId: string; qrCode: string; secret: string } | { error: string }> {
    const { data, error } = await this.supabase.client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Authenticator',
    });
    if (error || !data) {
      return { error: error?.message ?? 'Enrollment fehlgeschlagen.' };
    }
    return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
  }

  /** Challenge + Verify in einem Schritt. Bei Erfolg ist die Session aal2. */
  async verifyTotp(factorId: string, code: string): Promise<{ error: string | null }> {
    const { error } = await this.supabase.client.auth.mfa.challengeAndVerify({ factorId, code });
    return { error: error ? error.message : null };
  }

  async unenrollTotp(factorId: string): Promise<{ error: string | null }> {
    const { error } = await this.supabase.client.auth.mfa.unenroll({ factorId });
    return { error: error ? error.message : null };
  }
}

export type AalLevel = 'aal1' | 'aal2' | null;

export interface TotpFactor {
  id: string;
  status: 'verified' | 'unverified';
  friendlyName: string | null;
}

function toAal(level: string | null | undefined): AalLevel {
  return level === 'aal1' || level === 'aal2' ? level : null;
}
