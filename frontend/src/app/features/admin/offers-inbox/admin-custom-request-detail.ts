import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';

import { AdminOffersService, CustomRequestDetail as RequestDetailModel, OfferItemInput } from '../../../core/services/admin-offers.service';
import { CalcReason, CustomRequestStatus } from '../../../core/models/db-types';
import { CostComponents } from '../../../core/services/admin-catalog.service';

const EMPTY_COSTS: CostComponents = {
  filament_cost: 0,
  energy_cost: 0,
  machine_cost: 0,
  labor_cost: 0,
  packaging_cost: 0,
  license_cost: 0,
  scrap_allowance: 0,
  other_cost: 0,
};

@Component({
  selector: 'app-admin-custom-request-detail',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    ButtonModule,
    TagModule,
    SkeletonModule,
    MessageModule,
    DialogModule,
    TextareaModule,
    InputTextModule,
    InputNumberModule,
    SelectModule,
    DatePickerModule,
  ],
  templateUrl: './admin-custom-request-detail.html',
  styleUrl: './admin-custom-request-detail.scss',
})
export class AdminCustomRequestDetail implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly actionRunning = signal(false);
  readonly request = signal<RequestDetailModel | null>(null);

  private requestId!: string;

  readonly rejectDialogVisible = signal(false);
  readonly rejectReason = signal('');

  readonly offerFormVisible = signal(false);
  readonly validFrom = signal<Date | null>(new Date());
  readonly validUntil = signal<Date | null>(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000));
  readonly items = signal<
    { description: string; qty: number; costComponents: CostComponents; marginPercent: number; reason: CalcReason }[]
  >([]);
  readonly createdOfferLink = signal<string | null>(null);

  readonly reasonOptions: { label: string; value: CalcReason }[] = [
    { label: 'Kundenwunsch', value: 'kundenwunsch' },
    { label: 'Admin-Korrektur', value: 'admin_korrektur' },
    { label: 'Falsche Variante', value: 'falsche_variante' },
    { label: 'Sonstiger Grund', value: 'sonstiger_grund' },
  ];

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly offersService: AdminOffersService,
  ) {}

  ngOnInit(): void {
    this.requestId = this.route.snapshot.paramMap.get('id')!;
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.request.set(await this.offersService.getCustomRequestDetail(this.requestId));
    } catch {
      this.error.set('Anfrage konnte nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  back(): void {
    this.router.navigate(['/admin/angebote']);
  }

  statusSeverity(status: CustomRequestStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (status === 'abgelehnt') return 'danger';
    if (status === 'angebot_erstellt') return 'success';
    return 'info';
  }

  openRejectDialog(): void {
    this.rejectReason.set('');
    this.rejectDialogVisible.set(true);
  }

  async confirmReject(): Promise<void> {
    const reason = this.rejectReason().trim();
    if (!reason) return;
    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.offersService.rejectCustomRequest(this.requestId, reason);
      this.rejectDialogVisible.set(false);
      await this.load();
    } catch {
      this.actionError.set('Ablehnung fehlgeschlagen.');
    } finally {
      this.actionRunning.set(false);
    }
  }

  openOfferForm(): void {
    const request = this.request();
    if (!request) return;
    this.validFrom.set(new Date());
    this.validUntil.set(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000));
    this.items.set([
      {
        description: `${request.desiredSize} × ${request.qty} — ${request.message}`.slice(0, 200),
        qty: request.qty,
        costComponents: { ...EMPTY_COSTS },
        marginPercent: 20,
        reason: 'kundenwunsch',
      },
    ]);
    this.createdOfferLink.set(null);
    this.offerFormVisible.set(true);
  }

  addItemRow(): void {
    this.items.update((rows) => [
      ...rows,
      { description: '', qty: 1, costComponents: { ...EMPTY_COSTS }, marginPercent: 20, reason: 'kundenwunsch' },
    ]);
  }

  removeItemRow(index: number): void {
    this.items.update((rows) => rows.filter((_, i) => i !== index));
  }

  updateItemCost(index: number, key: keyof CostComponents, value: number): void {
    this.items.update((rows) =>
      rows.map((row, i) => (i === index ? { ...row, costComponents: { ...row.costComponents, [key]: value } } : row)),
    );
  }

  updateItemDescription(index: number, value: string): void {
    this.items.update((rows) => rows.map((row, i) => (i === index ? { ...row, description: value } : row)));
  }

  updateItemQty(index: number, value: number): void {
    this.items.update((rows) => rows.map((row, i) => (i === index ? { ...row, qty: value } : row)));
  }

  updateItemMargin(index: number, value: number): void {
    this.items.update((rows) => rows.map((row, i) => (i === index ? { ...row, marginPercent: value } : row)));
  }

  updateItemReason(index: number, value: CalcReason): void {
    this.items.update((rows) => rows.map((row, i) => (i === index ? { ...row, reason: value } : row)));
  }

  async submitOffer(): Promise<void> {
    const validFrom = this.validFrom();
    const validUntil = this.validUntil();
    if (!validFrom || !validUntil || this.items().length === 0) return;

    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      const items: OfferItemInput[] = this.items().map((row) => ({
        productId: null,
        desiredVariantDescription: row.description,
        qty: row.qty,
        costComponents: row.costComponents,
        marginPercent: row.marginPercent,
        reason: row.reason,
      }));
      const offerId = await this.offersService.createOfferFromRequest(
        this.requestId,
        validFrom.toISOString(),
        validUntil.toISOString(),
        items,
      );
      await this.load();
      const created = this.request()?.offers.find((o) => o.id === offerId);
      if (created) {
        this.createdOfferLink.set(`${window.location.origin}/angebot/${created.secureToken}`);
      }
    } catch {
      this.actionError.set('Angebot konnte nicht erstellt werden.');
    } finally {
      this.actionRunning.set(false);
    }
  }

  // Vollständige URL kopieren (vorher nur "/angebot/<token>" ohne Domain).
  copyLink(path: string): void {
    navigator.clipboard?.writeText(`${window.location.origin}${path}`);
  }

  // createdOfferLink enthält bereits die volle URL (inkl. Origin).
  copyCreatedOfferLink(): void {
    const link = this.createdOfferLink();
    if (link) navigator.clipboard?.writeText(link);
  }
}
