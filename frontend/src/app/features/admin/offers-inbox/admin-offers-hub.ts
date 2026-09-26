import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';

import { TabsModule } from 'primeng/tabs';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import { FormsModule } from '@angular/forms';

import { AdminOffersService, CustomRequestListRow, OfferListRow } from '../../../core/services/admin-offers.service';
import { CustomRequestStatus, OfferStatus } from '../../../core/models/db-types';

@Component({
  selector: 'app-admin-offers-hub',
  standalone: true,
  imports: [DatePipe, FormsModule, TabsModule, TableModule, TagModule, ButtonModule, SkeletonModule, MessageModule, DialogModule, TextareaModule],
  templateUrl: './admin-offers-hub.html',
  styleUrl: './admin-offers-hub.scss',
})
export class AdminOffersHub implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly requests = signal<CustomRequestListRow[]>([]);
  readonly offers = signal<OfferListRow[]>([]);

  readonly rejectDialogVisible = signal(false);
  readonly rejectTargetOfferId = signal<string | null>(null);
  readonly rejectReason = signal('');
  readonly rejectIsRevoke = signal(false);
  readonly actionRunning = signal(false);

  constructor(private readonly offersService: AdminOffersService, private readonly router: Router) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [requests, offers] = await Promise.all([
        this.offersService.listCustomRequests(),
        this.offersService.listOffers(),
      ]);
      this.requests.set(requests);
      this.offers.set(offers);
    } catch {
      this.error.set('Daten konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  openRequest(request: CustomRequestListRow): void {
    this.router.navigate(['/admin/angebote/anfrage', request.id]);
  }

  requestStatusSeverity(status: CustomRequestStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (status === 'abgelehnt') return 'danger';
    if (status === 'angebot_erstellt') return 'success';
    return 'info';
  }

  offerStatusSeverity(status: OfferStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (status === 'abgelehnt' || status === 'widerrufen') return 'danger';
    if (status === 'akzeptiert') return 'success';
    if (status === 'abgelaufen') return 'secondary';
    return 'info';
  }

  copyOfferLink(token: string): void {
    const url = `${window.location.origin}/angebot/${token}`;
    navigator.clipboard?.writeText(url);
  }

  openRejectDialog(offerId: string): void {
    this.rejectTargetOfferId.set(offerId);
    this.rejectReason.set('');
    this.rejectIsRevoke.set(false);
    this.rejectDialogVisible.set(true);
  }

  openRevokeDialog(offerId: string): void {
    this.rejectTargetOfferId.set(offerId);
    this.rejectReason.set('');
    this.rejectIsRevoke.set(true);
    this.rejectDialogVisible.set(true);
  }

  async confirmRejectOrRevoke(): Promise<void> {
    const offerId = this.rejectTargetOfferId();
    const reason = this.rejectReason().trim();
    if (!offerId || !reason) return;
    this.actionRunning.set(true);
    try {
      if (this.rejectIsRevoke()) {
        await this.offersService.revokeOffer(offerId, reason);
      } else {
        await this.offersService.rejectOffer(offerId, reason);
      }
      this.rejectDialogVisible.set(false);
      await this.load();
    } catch {
      this.error.set('Aktion fehlgeschlagen.');
    } finally {
      this.actionRunning.set(false);
    }
  }

  newOfferForRequest(requestId: string): void {
    this.router.navigate(['/admin/angebote/anfrage', requestId]);
  }
}
