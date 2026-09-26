import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { MessageModule } from 'primeng/message';

import { AuthService } from '../../../core/services/auth.service';
import { SupabaseClientService } from '../../../core/services/supabase-client.service';

@Component({
  selector: 'app-admin-login',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, PasswordModule, MessageModule],
  templateUrl: './admin-login.html',
  styleUrl: './admin-login.scss',
})
export class AdminLogin implements OnInit {
  readonly checkingSession = signal(true);
  readonly email = signal('');
  readonly password = signal('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** 2FA: zweiter Schritt (TOTP-Code) nach erfolgreichem Passwort-/Google-Login */
  readonly mfaStep = signal(false);
  readonly mfaCode = signal('');
  private mfaFactorId: string | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly supabase: SupabaseClientService,
    private readonly router: Router,
  ) {}

  async ngOnInit(): Promise<void> {
    const { data } = await this.supabase.client.auth.getSession();
    if (data.session) {
      await this.continueAfterSession();
      return;
    }
    this.showOAuthErrorFromUrl();
    this.checkingSession.set(false);
  }

  /**
   * Fehlgeschlagener OAuth-Rücksprung (z. B. Google): Supabase hängt
   * error/error_description an die Redirect-URL (Query oder Hash). Ohne
   * Anzeige landet der Admin kommentarlos wieder auf dem Login-Formular.
   */
  private showOAuthErrorFromUrl(): void {
    const query = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const description = query.get('error_description') ?? hash.get('error_description');
    const code = query.get('error_code') ?? hash.get('error_code');
    if (!description && !code) {
      return;
    }
    this.error.set(`Anmeldung über Google fehlgeschlagen: ${description ?? code}`);
    // Fehlerparameter aus der Adresszeile entfernen, damit ein Reload sauber startet.
    window.history.replaceState(null, '', window.location.pathname);
  }

  async loginWithPassword(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const { error } = await this.auth.signInWithPassword(this.email().trim(), this.password());
      if (error) {
        this.error.set('E-Mail oder Passwort ist falsch.');
        return;
      }
      await this.continueAfterSession();
    } catch {
      this.error.set('Anmeldung fehlgeschlagen. Bitte versuche es erneut.');
    } finally {
      this.loading.set(false);
    }
  }

  async loginWithGoogle(): Promise<void> {
    this.error.set(null);
    try {
      const { error } = await this.auth.signInWithGoogle();
      if (error) {
        this.error.set('Google-Anmeldung fehlgeschlagen. Bitte versuche es erneut.');
      }
    } catch {
      this.error.set('Google-Anmeldung fehlgeschlagen. Bitte versuche es erneut.');
    }
  }

  async verifyMfa(): Promise<void> {
    const code = this.mfaCode().replace(/\s+/g, '');
    if (!this.mfaFactorId || code.length !== 6) {
      this.error.set('Bitte den 6-stelligen Code aus der Authenticator-App eingeben.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const { error } = await this.auth.verifyTotp(this.mfaFactorId, code);
      if (error) {
        this.error.set('Code ungültig oder abgelaufen.');
        this.mfaCode.set('');
        return;
      }
      this.router.navigate(['/admin/dashboard']);
    } catch {
      this.error.set('Bestätigung fehlgeschlagen. Bitte versuche es erneut.');
    } finally {
      this.loading.set(false);
    }
  }

  async cancelMfa(): Promise<void> {
    await this.auth.signOut();
    this.mfaStep.set(false);
    this.mfaCode.set('');
    this.mfaFactorId = null;
    this.error.set(null);
    this.checkingSession.set(false);
  }

  /**
   * Session vorhanden: aal2 -> Dashboard; Faktor vorhanden aber aal1 ->
   * TOTP-Schritt; kein Faktor -> Guard leitet auf /admin/sicherheit.
   */
  private async continueAfterSession(): Promise<void> {
    const { currentLevel, nextLevel } = await this.auth.getAssuranceLevel();
    if (currentLevel === 'aal2' || nextLevel !== 'aal2') {
      this.router.navigate(['/admin/dashboard']);
      return;
    }
    const factors = await this.auth.listTotpFactors();
    const verified = factors.find((f) => f.status === 'verified');
    if (!verified) {
      this.router.navigate(['/admin/dashboard']);
      return;
    }
    this.mfaFactorId = verified.id;
    this.mfaStep.set(true);
    this.checkingSession.set(false);
  }
}
