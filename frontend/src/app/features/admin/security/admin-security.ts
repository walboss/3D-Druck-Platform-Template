import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';

import { AuthService, TotpFactor } from '../../../core/services/auth.service';

/**
 * 2FA-Verwaltung für den Admin-Account (specs/architektur-technologie-v1.md
 * §4.5). TOTP über Supabase Auth MFA. Ohne verifizierten Faktor ist dies
 * die einzige erreichbare Admin-Seite (siehe adminAuthGuard); der Server
 * lehnt Datenzugriffe ohne aal2 ab (Migration 00162).
 */
@Component({
  selector: 'app-admin-security',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, MessageModule, SkeletonModule],
  templateUrl: './admin-security.html',
  styleUrl: './admin-security.scss',
})
export class AdminSecurity implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);
  readonly busy = signal(false);

  readonly verifiedFactor = signal<TotpFactor | null>(null);
  readonly currentLevel = signal<'aal1' | 'aal2' | null>(null);

  /** Laufendes Enrollment: QR-Code + Secret, wartet auf Code-Bestätigung */
  readonly enrollment = signal<{ factorId: string; qrCode: string; secret: string } | null>(null);
  readonly code = signal('');

  constructor(
    private readonly auth: AuthService,
    private readonly router: Router,
  ) {}

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const factors = await this.auth.listTotpFactors();
      this.verifiedFactor.set(factors.find((f) => f.status === 'verified') ?? null);
      const { currentLevel } = await this.auth.getAssuranceLevel();
      this.currentLevel.set(currentLevel);
    } catch {
      this.error.set('2FA-Status konnte nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  async startEnrollment(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      // Reste abgebrochener Enrollments entfernen, sonst lehnt Supabase
      // einen zweiten Faktor mit gleichem Namen ab.
      const stale = (await this.auth.listTotpFactors()).filter((f) => f.status === 'unverified');
      for (const f of stale) {
        await this.auth.unenrollTotp(f.id);
      }
      const result = await this.auth.enrollTotp();
      if ('error' in result) {
        this.error.set(`Einrichtung fehlgeschlagen: ${result.error}`);
        return;
      }
      this.enrollment.set(result);
      this.code.set('');
    } catch {
      this.error.set('Einrichtung fehlgeschlagen. Bitte versuche es erneut.');
    } finally {
      this.busy.set(false);
    }
  }

  async confirmEnrollment(): Promise<void> {
    const enrollment = this.enrollment();
    const code = this.code().replace(/\s+/g, '');
    if (!enrollment) {
      return;
    }
    if (code.length !== 6) {
      this.error.set('Bitte den 6-stelligen Code aus der Authenticator-App eingeben.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const { error } = await this.auth.verifyTotp(enrollment.factorId, code);
      if (error) {
        this.error.set('Code ungültig oder abgelaufen. Bitte erneut versuchen.');
        this.code.set('');
        return;
      }
      this.enrollment.set(null);
      this.success.set('2FA ist eingerichtet. Ab jetzt wird beim Login der Authenticator-Code abgefragt.');
      await this.load();
    } catch {
      this.error.set('Bestätigung fehlgeschlagen. Bitte versuche es erneut.');
    } finally {
      this.busy.set(false);
    }
  }

  async cancelEnrollment(): Promise<void> {
    const enrollment = this.enrollment();
    this.enrollment.set(null);
    this.code.set('');
    this.error.set(null);
    if (enrollment) {
      await this.auth.unenrollTotp(enrollment.factorId);
    }
  }

  async removeFactor(): Promise<void> {
    const factor = this.verifiedFactor();
    if (!factor) {
      return;
    }
    const ok = window.confirm(
      '2FA wirklich entfernen? Danach hast du keinen Zugriff auf Admin-Daten, bis ein neuer Faktor eingerichtet ist.',
    );
    if (!ok) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      const { error } = await this.auth.unenrollTotp(factor.id);
      if (error) {
        this.error.set(`Entfernen fehlgeschlagen: ${error}`);
        return;
      }
      this.success.set('2FA entfernt. Bitte sofort einen neuen Faktor einrichten.');
      await this.load();
    } catch {
      this.error.set('Entfernen fehlgeschlagen. Bitte versuche es erneut.');
    } finally {
      this.busy.set(false);
    }
  }

  goToDashboard(): void {
    this.router.navigate(['/admin/dashboard']);
  }
}
