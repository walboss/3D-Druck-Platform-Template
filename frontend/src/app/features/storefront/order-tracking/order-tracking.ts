import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';

import { OrderTrackingService } from '../../../core/services/order-tracking.service';
import { OrderItemStatus, OrderStatus, OrderTrackingResult } from '../../../core/models/db-types';
import { PricingService } from '../../../core/services/pricing.service';

const ITEM_STEPS: OrderItemStatus[] = ['Offen', 'WartetAufMaterial', 'InProduktion', 'Fertig'];

@Component({
  selector: 'app-order-tracking',
  standalone: true,
  imports: [MessageModule, SkeletonModule, TagModule],
  templateUrl: './order-tracking.html',
  styleUrl: './order-tracking.scss',
})
export class OrderTracking implements OnInit {
  readonly showPrices = inject(PricingService).showPrices;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly order = signal<OrderTrackingResult | null>(null);

  /** 'Wartet auf Material' ist optional (bestellungen.md §3) — nur zeigen, wenn die Position gerade dort steht. */
  stepsFor(status: OrderItemStatus): OrderItemStatus[] {
    return status === 'WartetAufMaterial' ? ITEM_STEPS : ITEM_STEPS.filter((s) => s !== 'WartetAufMaterial');
  }

  constructor(private readonly route: ActivatedRoute, private readonly trackingService: OrderTrackingService) {}

  ngOnInit(): void {
    const token = this.route.snapshot.paramMap.get('token');
    if (!token) return;
    this.load(token);
  }

  async load(token: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.order.set(await this.trackingService.getOrderByToken(token));
    } catch {
      this.error.set('Tracking-Link ungültig oder abgelaufen.');
    } finally {
      this.loading.set(false);
    }
  }

  stepIndex(status: OrderItemStatus): number {
    return this.stepsFor(status).indexOf(status);
  }

  /** Lesbare Beschriftung für Stepper und Positions-Tag (nur Anzeige, Statuswerte bleiben unverändert). */
  stepLabel(step: OrderItemStatus): string {
    switch (step) {
      case 'WartetAufMaterial':
        return 'Wartet auf Material';
      case 'InProduktion':
        return 'In Produktion';
      default:
        return step;
    }
  }

  /** Deutsche, neutrale Beschriftung des Gesamtstatus statt interner Enum-Werte. */
  orderStatusLabel(status: OrderStatus): string {
    switch (status) {
      case 'New':
        return 'Eingegangen';
      case 'Confirmed':
        return 'Bestätigt';
      case 'InProduction':
        return 'In Produktion';
      case 'Finished':
        return 'Fertig';
      case 'ReadyForPickup':
        return 'Bereit zur Abholung';
      case 'HandedOver':
        return 'Abgeholt';
      case 'Cancelled':
        return 'Storniert';
      default:
        return status;
    }
  }

  orderStatusSeverity(status: OrderStatus): 'success' | 'info' | 'warn' | 'danger' {
    if (status === 'Cancelled') return 'danger';
    if (status === 'HandedOver' || status === 'ReadyForPickup') return 'success';
    return 'info';
  }

  itemStatusSeverity(status: OrderItemStatus): 'success' | 'info' | 'warn' | 'danger' {
    if (status === 'Storniert') return 'danger';
    if (status === 'Fertig') return 'success';
    if (status === 'WartetAufMaterial') return 'warn';
    return 'info';
  }
}
