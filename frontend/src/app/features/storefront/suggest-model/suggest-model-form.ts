import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { MessageModule } from 'primeng/message';

import { WorkerApiService, SuggestionStatus } from '../../../core/services/worker-api.service';
import { TurnstileWidget } from '../../../shared/turnstile/turnstile-widget';

// Spec 27 §6 "Modell vorschlagen": Kunde ohne Login reicht einen
// MakerWorld-Link (+ optionale Notiz) ein. Keine Kundendaten. Turnstile wie
// bei Checkout/Individualanfrage. Antworttexte je Status aus Spec 27 §4.

// Findet den MakerWorld-Modell-Link auch in eingefügtem Text (Teilen aus der
// App liefert oft "Titel + Link") und ohne Sprachpfad, z. B.
// https://makerworld.com/models/2019953?appSharePlatform=copy
// oder https://makerworld.com/de/models/2019953-name.
const MAKERWORLD_LINK_PATTERN = /https?:\/\/(?:[a-z0-9-]+\.)*makerworld\.com(?:\/[^\s/]+)*\/models\/\d+[^\s]*/i;

export function extractMakerworldLink(text: string): string | null {
  return text.match(MAKERWORLD_LINK_PATTERN)?.[0] ?? null;
}
const NOTE_MAX_LENGTH = 500;

@Component({
  selector: 'app-suggest-model-form',
  standalone: true,
  imports: [FormsModule, RouterLink, ButtonModule, InputTextModule, TextareaModule, MessageModule, TurnstileWidget],
  templateUrl: './suggest-model-form.html',
  styleUrl: './suggest-model-form.scss',
})
export class SuggestModelForm {
  readonly noteMaxLength = NOTE_MAX_LENGTH;

  readonly makerworldUrl = signal('');
  readonly note = signal('');
  readonly turnstileToken = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<SuggestionStatus | null>(null);

  readonly extractedLink = computed(() => extractMakerworldLink(this.makerworldUrl()));
  readonly linkValid = computed(() => this.extractedLink() !== null);
  readonly canSubmit = computed(
    () => !this.submitting() && this.linkValid() && this.note().length <= NOTE_MAX_LENGTH && !!this.turnstileToken(),
  );

  constructor(private readonly workerApi: WorkerApiService) {}

  onTurnstileVerified(token: string): void {
    this.turnstileToken.set(token || null);
  }

  onTurnstileExpired(): void {
    this.turnstileToken.set(null);
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    const token = this.turnstileToken();
    if (!token) return;

    this.submitting.set(true);
    this.error.set(null);
    try {
      const status = await this.workerApi.submitModelSuggestion(token, this.extractedLink()!, this.note().trim() || null);
      this.result.set(status);
    } catch (err) {
      const httpError = err as HttpErrorResponse;
      const message =
        (httpError?.error && (httpError.error.message || httpError.error.error)) ||
        'Vorschlag konnte nicht gesendet werden. Bitte versuche es erneut.';
      this.error.set(message);
    } finally {
      this.submitting.set(false);
    }
  }
}
