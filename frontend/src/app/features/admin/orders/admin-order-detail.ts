import { Component, OnInit, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectButtonModule } from 'primeng/selectbutton';
import { DatePickerModule } from 'primeng/datepicker';

import {
  AdminOrdersService,
  AdminOrderDetail as OrderDetailModel,
  AdminOrderItemRow,
  ColorChangeOptions,
} from '../../../core/services/admin-orders.service';
import { FilamentService, SpoolAvailability } from '../../../core/services/filament.service';
import { AdminProductionService } from '../../../core/services/admin-production.service';
import { OrderItemStatus, OrderStatus } from '../../../core/models/db-types';

interface SpoolAssignmentRow {
  spoolId: string | null;
  amountG: number;
}

@Component({
  selector: 'app-admin-order-detail',
  standalone: true,
  imports: [
    CurrencyPipe,
    DatePipe,
    FormsModule,
    ButtonModule,
    TagModule,
    SkeletonModule,
    MessageModule,
    DialogModule,
    SelectModule,
    TextareaModule,
    InputNumberModule,
    SelectButtonModule,
    DatePickerModule,
  ],
  templateUrl: './admin-order-detail.html',
  styleUrl: './admin-order-detail.scss',
})
export class AdminOrderDetail implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly actionRunning = signal(false);
  readonly order = signal<OrderDetailModel | null>(null);

  private orderId!: string;

  // Zur Produktion zuordnen
  readonly assignDialogVisible = signal(false);
  readonly assignTargetItem = signal<AdminOrderItemRow | null>(null);
  readonly assignableProductionOrders = signal<{ id: string; status: string; planned_start: string }[]>([]);
  readonly selectedProductionOrderId = signal<string | null>(null);
  // Entweder bestehenden Auftrag wählen oder direkt einen neuen anlegen
  // (fn_create_production_order) und die Position sofort zuordnen.
  readonly assignModeOptions = [
    { label: 'Bestehender Auftrag', value: 'bestehend' },
    { label: 'Neuer Auftrag', value: 'neu' },
  ];
  readonly assignMode = signal<'bestehend' | 'neu'>('bestehend');
  readonly printers = signal<{ id: string; name: string }[]>([]);
  readonly newPoPrinterId = signal<string | null>(null);
  readonly newPoPlannedStart = signal<Date | null>(new Date());
  readonly assignError = signal<string | null>(null);

  // Nachproduktion
  readonly reproductionDialogVisible = signal(false);
  readonly reproductionTargetItem = signal<AdminOrderItemRow | null>(null);
  readonly availableSpools = signal<SpoolAvailability[]>([]);
  readonly reproductionAssignments = signal<SpoolAssignmentRow[]>([{ spoolId: null, amountG: 0 }]);

  // Farbe ändern (Migration 00197): bis Produktionsstart, Grund ist Pflicht
  readonly colorDialogVisible = signal(false);
  readonly colorTargetItem = signal<AdminOrderItemRow | null>(null);
  readonly colorOptions = signal<ColorChangeOptions | null>(null);
  readonly colorSelection = signal<Record<string, { colorId: string | null; finishId: string | null }>>({});
  readonly colorReason = signal('');
  readonly colorError = signal<string | null>(null);
  readonly colorLoading = signal(false);

  // Stornieren (Item oder Order)
  readonly cancelDialogVisible = signal(false);
  readonly cancelTargetItemId = signal<string | null>(null);
  readonly cancelReason = signal('');

  // Übergabe
  readonly handoverDialogVisible = signal(false);
  readonly handoverNote = signal('');

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly ordersService: AdminOrdersService,
    private readonly filamentService: FilamentService,
    private readonly productionService: AdminProductionService,
  ) {}

  ngOnInit(): void {
    this.orderId = this.route.snapshot.paramMap.get('id')!;
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.order.set(await this.ordersService.getOrderDetail(this.orderId));
    } catch {
      this.error.set('Bestellung konnte nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  back(): void {
    this.router.navigate(['/admin/bestellungen']);
  }

  orderStatusSeverity(status: OrderStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (status === 'Cancelled') return 'danger';
    if (status === 'HandedOver') return 'success';
    if (status === 'New') return 'secondary';
    return 'info';
  }

  itemStatusSeverity(status: OrderItemStatus): 'success' | 'info' | 'warn' | 'danger' {
    if (status === 'Storniert') return 'danger';
    if (status === 'Fertig') return 'success';
    if (status === 'WartetAufMaterial') return 'warn';
    return 'info';
  }

  async confirmOrder(): Promise<void> {
    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.ordersService.confirmOrder(this.orderId);
      await this.load();
    } catch (e) {
      this.actionError.set(this.extractMessage(e, 'Bestellung konnte nicht bestätigt werden.'));
    } finally {
      this.actionRunning.set(false);
    }
  }

  async openAssignDialog(item: AdminOrderItemRow): Promise<void> {
    this.assignTargetItem.set(item);
    this.selectedProductionOrderId.set(null);
    this.assignMode.set('bestehend');
    this.newPoPrinterId.set(null);
    this.newPoPlannedStart.set(new Date());
    this.assignError.set(null);
    this.assignDialogVisible.set(true);
    const [assignable, printers] = await Promise.all([
      this.ordersService.getAssignableProductionOrders().catch(() => []),
      this.productionService.getPrinters().catch(() => []),
    ]);
    this.assignableProductionOrders.set(assignable);
    this.printers.set(printers);
    this.newPoPrinterId.set(printers.find((p) => p.isDefault)?.id ?? null);
    // Ohne offene Aufträge direkt in den Neuanlage-Modus springen.
    if (assignable.length === 0) {
      this.assignMode.set('neu');
    }
  }

  canConfirmAssign(): boolean {
    return this.assignMode() === 'bestehend'
      ? !!this.selectedProductionOrderId()
      : !!this.newPoPlannedStart();
  }

  async confirmAssign(): Promise<void> {
    const item = this.assignTargetItem();
    if (!item || !this.canConfirmAssign()) return;
    this.actionRunning.set(true);
    this.actionError.set(null);
    this.assignError.set(null);
    try {
      let productionOrderId = this.selectedProductionOrderId();
      if (this.assignMode() === 'neu') {
        productionOrderId = await this.productionService.createProductionOrder(
          this.newPoPrinterId(),
          this.newPoPlannedStart()!.toISOString(),
        );
      }
      await this.ordersService.assignToProduction(item.orderItemId, productionOrderId!);
      this.assignDialogVisible.set(false);
      await this.load();
    } catch (e) {
      this.assignError.set(this.extractMessage(e, 'Zuordnung zur Produktion fehlgeschlagen.'));
    } finally {
      this.actionRunning.set(false);
    }
  }

  async openReproductionDialog(item: AdminOrderItemRow): Promise<void> {
    this.reproductionTargetItem.set(item);
    this.reproductionAssignments.set([{ spoolId: null, amountG: 0 }]);
    this.reproductionDialogVisible.set(true);
    try {
      this.availableSpools.set(await this.filamentService.getSpoolsWithAvailability());
    } catch {
      this.availableSpools.set([]);
    }
  }

  addReproductionRow(): void {
    this.reproductionAssignments.update((rows) => [...rows, { spoolId: null, amountG: 0 }]);
  }

  removeReproductionRow(index: number): void {
    this.reproductionAssignments.update((rows) => rows.filter((_, i) => i !== index));
  }

  async confirmReproduction(): Promise<void> {
    const item = this.reproductionTargetItem();
    if (!item) return;
    const assignments = this.reproductionAssignments()
      .filter((r) => r.spoolId && r.amountG > 0)
      .map((r) => ({ spool_id: r.spoolId!, amount_g: r.amountG }));
    if (assignments.length === 0) return;

    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.ordersService.addPositionToRunningOrder(item.orderItemId, assignments);
      this.reproductionDialogVisible.set(false);
      await this.load();
    } catch (e) {
      this.actionError.set(this.extractMessage(e, 'Nachproduktion konnte nicht angelegt werden.'));
    } finally {
      this.actionRunning.set(false);
    }
  }

  async readyForPickup(): Promise<void> {
    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.ordersService.readyForPickup(this.orderId);
      await this.load();
    } catch (e) {
      this.actionError.set(this.extractMessage(e, 'Nicht alle Positionen sind fertig.'));
    } finally {
      this.actionRunning.set(false);
    }
  }

  openHandoverDialog(): void {
    this.handoverNote.set('');
    this.handoverDialogVisible.set(true);
  }

  async confirmHandover(): Promise<void> {
    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      const adminId = await this.ordersService.getCurrentAdminId();
      if (!adminId) {
        this.actionError.set('Kein Admin-Konto zu diesem Login gefunden.');
        return;
      }
      await this.ordersService.handOverOrder(this.orderId, adminId, this.handoverNote().trim() || null);
      this.handoverDialogVisible.set(false);
      await this.load();
    } catch (e) {
      this.actionError.set(this.extractMessage(e, 'Übergabe fehlgeschlagen.'));
    } finally {
      this.actionRunning.set(false);
    }
  }

  openCancelItemDialog(itemId: string): void {
    this.cancelTargetItemId.set(itemId);
    this.cancelReason.set('');
    this.cancelDialogVisible.set(true);
  }

  openCancelOrderDialog(): void {
    this.cancelTargetItemId.set(null);
    this.cancelReason.set('');
    this.cancelDialogVisible.set(true);
  }

  async confirmCancel(): Promise<void> {
    const reason = this.cancelReason().trim();
    if (!reason) return;
    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      const itemId = this.cancelTargetItemId();
      if (itemId) {
        await this.ordersService.cancelOrderItem(itemId, reason);
      } else {
        await this.ordersService.cancelOrder(this.orderId, reason);
      }
      this.cancelDialogVisible.set(false);
      await this.load();
    } catch (e) {
      this.actionError.set(this.extractMessage(e, 'Stornierung fehlgeschlagen.'));
    } finally {
      this.actionRunning.set(false);
    }
  }

  canAssignToProduction(item: AdminOrderItemRow): boolean {
    return (item.status === 'Offen' || item.status === 'WartetAufMaterial') && !item.productionOrderId;
  }

  canReproduce(item: AdminOrderItemRow): boolean {
    return item.status === 'InProduktion';
  }

  // Grobe Vorprüfung für die Anzeige des Buttons; die genauen Regeln
  // (z. B. Produktionsauftrag noch 'Geplant') prüft die Datenbank.
  canChangeColor(item: AdminOrderItemRow): boolean {
    const status = this.order()?.status;
    if (!item.variantConfigurationId || !item.productId) return false;
    if (status === 'ReadyForPickup' || status === 'HandedOver' || status === 'Cancelled') return false;
    return item.status !== 'Storniert';
  }

  async openColorDialog(item: AdminOrderItemRow): Promise<void> {
    this.colorTargetItem.set(item);
    this.colorReason.set('');
    this.colorError.set(null);
    this.colorOptions.set(null);
    this.colorDialogVisible.set(true);
    this.colorLoading.set(true);
    try {
      const options = await this.ordersService.getColorChangeOptions(item.productId!, item.variantConfigurationId!);
      this.colorOptions.set(options);
      this.colorSelection.set(structuredClone(options.current));
    } catch (e) {
      this.colorError.set(this.extractMessage(e, 'Farben konnten nicht geladen werden.'));
    } finally {
      this.colorLoading.set(false);
    }
  }

  setColorSelection(partKey: string | null, field: 'colorId' | 'finishId', value: string | null): void {
    const key = partKey ?? '';
    this.colorSelection.update((sel) => ({ ...sel, [key]: { ...sel[key], [field]: value } }));
  }

  colorSelectionComplete(): boolean {
    const options = this.colorOptions();
    if (!options) return false;
    const sel = this.colorSelection();
    return options.parts.every((p) => !!sel[p.key ?? '']?.colorId && !!sel[p.key ?? '']?.finishId);
  }

  async confirmColorChange(): Promise<void> {
    const item = this.colorTargetItem();
    const options = this.colorOptions();
    const reason = this.colorReason().trim();
    if (!item || !options || !reason || !this.colorSelectionComplete()) return;
    const sel = this.colorSelection();
    const map = options.parts.map((p) => ({
      product_part_id: p.key,
      color_id: sel[p.key ?? ''].colorId!,
      finish_id: sel[p.key ?? ''].finishId!,
    }));
    this.actionRunning.set(true);
    this.colorError.set(null);
    try {
      await this.ordersService.changeItemConfiguration(item.orderItemId, map, reason);
      this.colorDialogVisible.set(false);
      await this.load();
    } catch (e) {
      this.colorError.set(this.extractMessage(e, 'Farbe konnte nicht geändert werden.'));
    } finally {
      this.actionRunning.set(false);
    }
  }

  canCancelItem(item: AdminOrderItemRow): boolean {
    return item.status === 'Offen' || item.status === 'WartetAufMaterial' || item.status === 'InProduktion';
  }

  allItemsFertig(): boolean {
    const order = this.order();
    if (!order) return false;
    return order.items
      .filter((i) => i.status !== 'Storniert')
      .every((i) => i.status === 'Fertig');
  }

  private extractMessage(e: unknown, fallback: string): string {
    const err = e as { message?: string };
    return err?.message ?? fallback;
  }
}
