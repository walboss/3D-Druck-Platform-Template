import { Component, OnInit, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';

import {
  AdminProductionService,
  BatchItemRow,
  ProductionOrderDetail as ProductionOrderDetailModel,
} from '../../../core/services/admin-production.service';
import { FilamentService, SpoolAvailability } from '../../../core/services/filament.service';
import { ProductionOrderStatus } from '../../../core/models/db-types';

interface SpoolAssignmentDraft {
  orderItemId: string;
  spoolId: string | null;
  amountG: number;
}

interface MaterialUsageRow {
  spoolId: string | null;
  amountG: number;
  scrapAmountG: number;
}

@Component({
  selector: 'app-admin-production-detail',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    ButtonModule,
    TagModule,
    SkeletonModule,
    MessageModule,
    DialogModule,
    SelectModule,
    InputNumberModule,
    TextareaModule,
  ],
  templateUrl: './admin-production-detail.html',
  styleUrl: './admin-production-detail.scss',
})
export class AdminProductionDetail implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly actionRunning = signal(false);
  readonly detail = signal<ProductionOrderDetailModel | null>(null);
  /** Positionen ohne erfassten Ist-Verbrauch — solange > 0 kein Abschluss (Migration 00185). */
  readonly openBatchItemCount = computed(() => this.detail()?.batchItems.filter((b) => !b.isComplete).length ?? 0);
  readonly availableSpools = signal<SpoolAvailability[]>([]);

  private productionOrderId!: string;

  readonly startDialogVisible = signal(false);
  readonly startAssignments = signal<SpoolAssignmentDraft[]>([]);

  readonly completeDialogVisible = signal(false);
  readonly completeTargetItem = signal<BatchItemRow | null>(null);
  readonly qtySuccess = signal(0);
  readonly qtyScrapNormal = signal(0);
  readonly qtyScrapComplaint = signal(0);
  readonly materialUsageRows = signal<MaterialUsageRow[]>([{ spoolId: null, amountG: 0, scrapAmountG: 0 }]);

  readonly failDialogVisible = signal(false);
  readonly failReason = signal('');

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly productionService: AdminProductionService,
    private readonly filamentService: FilamentService,
  ) {}

  ngOnInit(): void {
    this.productionOrderId = this.route.snapshot.paramMap.get('id')!;
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.detail.set(await this.productionService.getProductionOrderDetail(this.productionOrderId));
    } catch {
      this.error.set('Produktionsauftrag konnte nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  back(): void {
    this.router.navigate(['/admin/produktion']);
  }

  statusSeverity(status: ProductionOrderStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (status === 'Fehlgeschlagen') return 'danger';
    if (status === 'Abgeschlossen') return 'success';
    if (status === 'Laeuft') return 'warn';
    return 'secondary';
  }

  async openStartDialog(): Promise<void> {
    const items = this.detail()?.unassignedItems ?? [];
    this.startAssignments.set(items.map((i) => ({ orderItemId: i.orderItemId, spoolId: null, amountG: 0 })));
    this.startDialogVisible.set(true);
    try {
      this.availableSpools.set(await this.filamentService.getSpoolsWithAvailability());
    } catch {
      this.availableSpools.set([]);
    }
  }

  itemLabel(orderItemId: string): string {
    return this.detail()?.unassignedItems.find((i) => i.orderItemId === orderItemId)?.description ?? orderItemId;
  }

  async confirmStart(): Promise<void> {
    // Leere/teilweise Auswahl ist erlaubt: eindeutige Farben wählt der Server
    // automatisch (Migration 00182), nur uneindeutige Positionen brauchen
    // hier überhaupt eine manuelle Zuordnung.
    const assignments = this.startAssignments()
      .filter((a) => a.spoolId && a.amountG > 0)
      .map((a) => ({ order_item_id: a.orderItemId, spool_id: a.spoolId!, amount_g: a.amountG }));

    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.productionService.startProduction(this.productionOrderId, assignments);
      this.startDialogVisible.set(false);
      await this.load();
    } catch (e) {
      this.actionError.set(this.extractMessage(e, 'Produktionsstart fehlgeschlagen.'));
    } finally {
      this.actionRunning.set(false);
    }
  }

  async openCompleteDialog(item: BatchItemRow): Promise<void> {
    this.completeTargetItem.set(item);
    this.qtySuccess.set(item.qtyPlanned);
    this.qtyScrapNormal.set(0);
    this.qtyScrapComplaint.set(0);
    this.materialUsageRows.set([{ spoolId: null, amountG: 0, scrapAmountG: 0 }]);
    this.completeDialogVisible.set(true);
    try {
      this.availableSpools.set(await this.filamentService.getSpoolsWithAvailability());
    } catch {
      this.availableSpools.set([]);
    }
  }

  addMaterialUsageRow(): void {
    this.materialUsageRows.update((rows) => [...rows, { spoolId: null, amountG: 0, scrapAmountG: 0 }]);
  }

  removeMaterialUsageRow(index: number): void {
    this.materialUsageRows.update((rows) => rows.filter((_, i) => i !== index));
  }

  async confirmComplete(): Promise<void> {
    const item = this.completeTargetItem();
    if (!item) return;
    const usage = this.materialUsageRows()
      .filter((r) => r.spoolId && r.amountG > 0)
      .map((r) => ({ spool_id: r.spoolId!, amount_g: r.amountG, scrap_amount_g: r.scrapAmountG || 0 }));

    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.productionService.completeOrderItem(
        item.id,
        this.qtySuccess(),
        this.qtyScrapNormal(),
        this.qtyScrapComplaint(),
        usage,
      );
      this.completeDialogVisible.set(false);
      await this.load();
    } catch (e) {
      this.actionError.set(this.extractMessage(e, 'Erfassung fehlgeschlagen.'));
    } finally {
      this.actionRunning.set(false);
    }
  }

  async completeProductionOrder(): Promise<void> {
    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.productionService.completeProductionOrder(this.productionOrderId);
      await this.load();
    } catch (e) {
      this.actionError.set(this.extractMessage(e, 'Abschluss fehlgeschlagen.'));
    } finally {
      this.actionRunning.set(false);
    }
  }

  openFailDialog(): void {
    this.failReason.set('');
    this.failDialogVisible.set(true);
  }

  async confirmFail(): Promise<void> {
    const reason = this.failReason().trim();
    if (!reason) return;
    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.productionService.failProductionOrder(this.productionOrderId, reason);
      this.failDialogVisible.set(false);
      await this.load();
    } catch (e) {
      this.actionError.set(this.extractMessage(e, 'Fehlschlag konnte nicht erfasst werden.'));
    } finally {
      this.actionRunning.set(false);
    }
  }

  private extractMessage(e: unknown, fallback: string): string {
    const err = e as { message?: string };
    return err?.message ?? fallback;
  }
}
