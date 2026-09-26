import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';

import { OfferService } from '../../../core/services/offer.service';
import { OfferViewResult } from '../../../core/models/db-types';
import { PricingService } from '../../../core/services/pricing.service';

@Component({
  selector: 'app-offer-view',
  standalone: true,
  imports: [CurrencyPipe, DatePipe, ButtonModule, MessageModule, SkeletonModule],
  templateUrl: './offer-view.html',
  styleUrl: './offer-view.scss',
})
export class OfferView implements OnInit {
  private readonly pricing = inject(PricingService);
  readonly showPrices = this.pricing.showPrices;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly offer = signal<OfferViewResult | null>(null);
  readonly token = signal<string | null>(null);
  readonly accepting = signal(false);

  readonly total = computed(() =>
    (this.offer()?.items ?? []).reduce((sum, i) => sum + i.final_price * i.qty, 0),
  );

  readonly isExpired = computed(() => {
    const offer = this.offer();
    if (!offer) return false;
    return new Date(offer.valid_until).getTime() < Date.now();
  });

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly offerService: OfferService,
  ) {}

  ngOnInit(): void {
    const token = this.route.snapshot.paramMap.get('token');
    if (!token) return;
    this.token.set(token);
    this.load(token);
  }

  async load(token: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.offer.set(await this.offerService.getOfferByToken(token));
    } catch {
      this.error.set(this.showPrices() ? 'Angebotslink ungültig oder nicht mehr verfügbar' : 'Link ungültig oder nicht mehr verfügbar');
    } finally {
      this.loading.set(false);
    }
  }

  async accept(): Promise<void> {
    const token = this.token();
    if (!token) return;
    this.accepting.set(true);
    this.error.set(null);
    try {
      const result = await this.offerService.acceptOffer(token);
      this.router.navigate([this.pricing.confirmationPath()], {
        queryParams: { token: result.tracking_token },
      });
    } catch {
      this.error.set(
        this.showPrices()
          ? 'Angebot konnte nicht angenommen werden. Bitte versuche es erneut.'
          : 'Konnte nicht bestätigt werden. Bitte versuche es erneut.',
      );
    } finally {
      this.accepting.set(false);
    }
  }
}
