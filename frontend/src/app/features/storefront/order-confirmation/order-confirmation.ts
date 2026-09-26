import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';

import { OrderTrackingService } from '../../../core/services/order-tracking.service';
import { OrderTrackingResult } from '../../../core/models/db-types';
import { PricingService } from '../../../core/services/pricing.service';

@Component({
  selector: 'app-order-confirmation',
  standalone: true,
  imports: [CurrencyPipe, RouterLink, ButtonModule, InputTextModule, MessageModule, SkeletonModule, TagModule],
  templateUrl: './order-confirmation.html',
  styleUrl: './order-confirmation.scss',
})
export class OrderConfirmation implements OnInit {
  readonly showPrices = inject(PricingService).showPrices;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly order = signal<OrderTrackingResult | null>(null);
  readonly token = signal<string | null>(null);
  readonly trackingUrl = computed(() => {
    const token = this.token();
    return token ? `${window.location.origin}/tracking/${token}` : '';
  });
  readonly copied = signal(false);
  readonly canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly trackingService: OrderTrackingService,
  ) {}

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token');
    if (!token) {
      this.router.navigate(['/katalog']);
      return;
    }
    this.token.set(token);
    this.load(token);
  }

  async load(token: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.order.set(await this.trackingService.getOrderByToken(token));
    } catch {
      this.error.set(
        this.showPrices()
          ? 'Bestellung konnte nicht geladen werden. Der Link könnte ungültig sein.'
          : 'Konnte nicht geladen werden. Der Link könnte ungültig sein.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  // Den Link sieht der Kunde nur hier (keine E-Mail) → kopieren/teilen anbieten.
  async copyTrackingUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.trackingUrl());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2500);
    } catch {
      this.copied.set(false);
    }
  }

  async shareTrackingUrl(): Promise<void> {
    try {
      await navigator.share({ title: 'Mein 3D-Druck – Status', url: this.trackingUrl() });
    } catch {
      // Abbruch durch den Nutzer → nichts tun.
    }
  }
}
