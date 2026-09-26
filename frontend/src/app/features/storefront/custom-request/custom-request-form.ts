import { Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';

import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { MessageModule } from 'primeng/message';

import { SupabaseClientService } from '../../../core/services/supabase-client.service';
import { WorkerApiService } from '../../../core/services/worker-api.service';
import { TurnstileWidget } from '../../../shared/turnstile/turnstile-widget';
import { Color, Finish } from '../../../core/models/db-types';
import { PricingService } from '../../../core/services/pricing.service';
import { LEGAL_PAGES_ENABLED } from '../../../core/legal-pages';

type ColorMode = 'einfarbig' | 'mehrfarbig';

interface Slot {
  label: string;
  hex: string;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return null;
  const num = parseInt(clean, 16);
  if (Number.isNaN(num)) return null;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

@Component({
  selector: 'app-custom-request-form',
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    TextareaModule,
    SelectModule,
    SelectButtonModule,
    MessageModule,
    TurnstileWidget,
  ],
  templateUrl: './custom-request-form.html',
  styleUrl: './custom-request-form.scss',
})
export class CustomRequestForm implements OnInit {
  readonly legalPagesEnabled = LEGAL_PAGES_ENABLED;
  private readonly pricing = inject(PricingService);
  readonly showPrices = this.pricing.showPrices;
  readonly colors = signal<Color[]>([]);
  readonly finishes = signal<Finish[]>([]);

  readonly colorModeOptions = [
    { label: 'Einfarbig', value: 'einfarbig' as ColorMode },
    { label: 'Mehrfarbig', value: 'mehrfarbig' as ColorMode },
  ];
  readonly colorMode = signal<ColorMode>('einfarbig');

  readonly makerworldLink = signal('');
  readonly ownImage = signal('');
  // Größe in cm (Zahlenfeld, "cm" fest), gespeichert als "<Zahl> cm".
  readonly desiredSize = signal<number | null>(null);
  readonly qty = signal(1);
  readonly message = signal('');

  readonly singleColorHex = signal('#ff0000');
  readonly singleFinishId = signal<string | null>(null);

  readonly slots = signal<Slot[]>([{ label: 'Slot 1', hex: '#ff0000' }]);

  readonly firstName = signal('');
  readonly lastName = signal('');
  readonly phone = signal('');
  readonly email = signal('');

  readonly turnstileToken = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  readonly submitted = signal(false);

  readonly bestMatchColor = computed(() => {
    const rgb = hexToRgb(this.singleColorHex());
    if (!rgb) return null;
    let best: Color | null = null;
    let bestDist = Infinity;
    for (const c of this.colors()) {
      if (!c.hex) continue;
      const crgb = hexToRgb(c.hex);
      if (!crgb) continue;
      const dist = (rgb[0] - crgb[0]) ** 2 + (rgb[1] - crgb[1]) ** 2 + (rgb[2] - crgb[2]) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    return best;
  });

  readonly canAddSlot = computed(() => this.slots().length < 8);

  // Nachname nur im gewerblichen Modus (showPrices) Pflicht -- im Privatmodus
  // reicht der Vorname, analog checkout.ts (Entscheidung 2026-09-20).
  readonly lastNameRequired = this.pricing.showPrices;

  // Telefon/E-Mail nur im gewerblichen Modus Pflicht (min. eins von beiden) --
  // im Privatmodus keine Kontaktpflicht, analog checkout.ts (Entscheidung
  // 2026-09-21).
  readonly contactRequired = this.pricing.showPrices;

  // Nach dem ersten Absende-Versuch leere Pflichtfelder rot markieren.
  readonly attempted = signal(false);

  readonly invalidMessage = computed(() => !this.message().trim());
  readonly invalidSize = computed(() => {
    const size = this.desiredSize();
    return size === null || size <= 0;
  });
  readonly invalidQty = computed(() => !this.qty() || this.qty() < 1);
  readonly invalidColor = computed(() =>
    this.colorMode() === 'einfarbig' ? this.bestMatchColor() === null : this.slots().length === 0,
  );
  readonly invalidFirstName = computed(() => !this.firstName().trim());
  readonly invalidLastName = computed(() => this.lastNameRequired() && !this.lastName().trim());
  readonly invalidContact = computed(
    () => this.contactRequired() && !this.phone().trim() && !this.email().trim(),
  );

  readonly missingFields = computed(() => {
    const missing: string[] = [];
    if (this.invalidMessage()) missing.push('Beschreibung');
    if (this.invalidSize()) missing.push('Gewünschte Größe');
    if (this.invalidQty()) missing.push('Menge');
    if (this.invalidColor()) missing.push(this.colorMode() === 'einfarbig' ? 'Farbe' : 'Farbslots');
    if (this.invalidFirstName()) missing.push('Vorname');
    if (this.invalidLastName()) missing.push('Nachname');
    if (this.invalidContact()) missing.push('Telefon oder E-Mail');
    return missing;
  });

  readonly canSubmit = computed(
    () => !this.submitting() && this.missingFields().length === 0 && !!this.turnstileToken(),
  );

  @ViewChild(TurnstileWidget) private turnstileWidget?: TurnstileWidget;

  constructor(
    private readonly supabase: SupabaseClientService,
    private readonly workerApi: WorkerApiService,
  ) {}

  ngOnInit(): void {
    this.loadColors();
  }

  async loadColors(): Promise<void> {
    const [{ data: colors }, { data: finishes }] = await Promise.all([
      this.supabase.client.from('colors').select('id, name, hex, active').eq('active', true),
      this.supabase.client.from('finishes').select('id, name, active').eq('active', true),
    ]);
    this.colors.set((colors ?? []) as Color[]);
    this.finishes.set((finishes ?? []) as Finish[]);
  }

  addSlot(): void {
    if (!this.canAddSlot()) return;
    const n = this.slots().length + 1;
    this.slots.update((s) => [...s, { label: `Slot ${n}`, hex: '#ff0000' }]);
  }

  removeSlot(index: number): void {
    this.slots.update((s) => s.filter((_, i) => i !== index));
  }

  updateSlotHex(index: number, hex: string): void {
    this.slots.update((s) => s.map((slot, i) => (i === index ? { ...slot, hex } : slot)));
  }

  onTurnstileVerified(token: string): void {
    this.turnstileToken.set(token || null);
  }

  onTurnstileExpired(): void {
    this.turnstileToken.set(null);
  }

  async submit(): Promise<void> {
    if (this.submitting()) return;
    this.attempted.set(true);
    const missing = this.missingFields();
    if (missing.length > 0) {
      this.error.set(`Bitte fülle alle Pflichtfelder aus: ${missing.join(', ')}.`);
      return;
    }
    const token = this.turnstileToken();
    if (!token) {
      this.error.set('Bitte bestätige zuerst die Sicherheitsabfrage.');
      return;
    }

    this.submitting.set(true);
    this.error.set(null);
    try {
      const isMulti = this.colorMode() === 'mehrfarbig';

      await this.workerApi.submitCustomRequest(token, {
        p_customer: {
          first_name: this.firstName().trim(),
          last_name: this.lastName().trim(),
          phone: this.phone().trim() || null,
          email: this.email().trim() || null,
          pickup_method: 'Abholung',
        },
        p_makerworld_link: this.makerworldLink().trim() || null,
        p_own_image: this.ownImage().trim() || null,
        p_desired_size: `${this.desiredSize()!.toLocaleString('de-DE')} cm`,
        p_qty: this.qty(),
        p_message: this.message().trim(),
        p_color_id: isMulti ? null : this.bestMatchColor()?.id ?? null,
        p_finish_id: isMulti ? null : this.singleFinishId(),
        p_slice_file_upload: null,
        p_slot_colors: isMulti
          ? this.slots().map((s) => ({ slot_label: s.label, hex: s.hex }))
          : null,
      });

      this.submitted.set(true);
    } catch (err) {
      const httpError = err as HttpErrorResponse;
      const message =
        (httpError?.error && (httpError.error.message || httpError.error.error)) ||
        'Anfrage konnte nicht gesendet werden. Bitte versuche es erneut.';
      this.error.set(message);
      // Turnstile-Token ist verbraucht -- für den nächsten Versuch neues anfordern.
      this.turnstileToken.set(null);
      this.turnstileWidget?.reset();
    } finally {
      this.submitting.set(false);
    }
  }
}
