import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';

import { AdminMakerworldService, ProductSuggestionRow } from '../../../core/services/admin-makerworld.service';

// Spec 27 §6 "Vorschläge": offene Kundenvorschläge, je Zeile "Importieren"
// (öffnet die Import-Vorschau mit dem einen Link) oder "Ablehnen".

@Component({
  selector: 'app-admin-suggestions-list',
  standalone: true,
  imports: [DatePipe, FormsModule, ButtonModule, InputTextModule, DialogModule, MessageModule, SkeletonModule],
  templateUrl: './admin-suggestions-list.html',
  styleUrl: './admin-suggestions-list.scss',
})
export class AdminSuggestionsList implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly suggestions = signal<ProductSuggestionRow[]>([]);

  readonly rejectDialogVisible = signal(false);
  readonly rejectTarget = signal<ProductSuggestionRow | null>(null);
  readonly rejectReason = signal('');
  readonly rejecting = signal(false);

  constructor(
    private readonly makerworldService: AdminMakerworldService,
    private readonly router: Router,
  ) {}

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.suggestions.set(await this.makerworldService.listOpenSuggestions());
    } catch {
      this.error.set('Vorschläge konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  back(): void {
    this.router.navigate(['/admin/katalog']);
  }

  importSuggestion(s: ProductSuggestionRow): void {
    this.router.navigate(['/admin/katalog/import'], { queryParams: { link: s.makerworldUrl, suggestion: s.id } });
  }

  openReject(s: ProductSuggestionRow): void {
    this.rejectTarget.set(s);
    this.rejectReason.set('');
    this.rejectDialogVisible.set(true);
  }

  async confirmReject(): Promise<void> {
    const target = this.rejectTarget();
    if (!target) return;
    this.rejecting.set(true);
    this.error.set(null);
    try {
      await this.makerworldService.rejectSuggestion(target.id, this.rejectReason().trim() || null);
      this.rejectDialogVisible.set(false);
      this.suggestions.update((list) => list.filter((s) => s.id !== target.id));
    } catch {
      this.error.set('Vorschlag konnte nicht abgelehnt werden.');
    } finally {
      this.rejecting.set(false);
    }
  }
}
