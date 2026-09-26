import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';

import { AdminProductionService, ProductionOrderListRow } from '../../../core/services/admin-production.service';
import { ProductionOrderStatus } from '../../../core/models/db-types';

@Component({
  selector: 'app-admin-production-list',
  standalone: true,
  imports: [DatePipe, FormsModule, TableModule, TagModule, ButtonModule, DialogModule, SelectModule, DatePickerModule, SkeletonModule, MessageModule],
  templateUrl: './admin-production-list.html',
  styleUrl: './admin-production-list.scss',
})
export class AdminProductionList implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly orders = signal<ProductionOrderListRow[]>([]);

  readonly createDialogVisible = signal(false);
  readonly printers = signal<{ id: string; name: string }[]>([]);
  readonly selectedPrinterId = signal<string | null>(null);
  readonly plannedStart = signal<Date | null>(new Date());
  readonly creating = signal(false);
  readonly createError = signal<string | null>(null);

  constructor(private readonly productionService: AdminProductionService, private readonly router: Router) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.orders.set(await this.productionService.listProductionOrders());
    } catch {
      this.error.set('Produktionsaufträge konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  async openCreateDialog(): Promise<void> {
    this.selectedPrinterId.set(null);
    this.plannedStart.set(new Date());
    this.createError.set(null);
    this.createDialogVisible.set(true);
    try {
      const printers = await this.productionService.getPrinters();
      this.printers.set(printers);
      this.selectedPrinterId.set(printers.find((p) => p.isDefault)?.id ?? null);
    } catch {
      this.printers.set([]);
    }
  }

  async confirmCreate(): Promise<void> {
    const plannedStart = this.plannedStart();
    if (!plannedStart) return;
    this.creating.set(true);
    this.createError.set(null);
    try {
      const id = await this.productionService.createProductionOrder(
        this.selectedPrinterId(),
        plannedStart.toISOString(),
      );
      this.createDialogVisible.set(false);
      this.router.navigate(['/admin/produktion', id]);
    } catch {
      this.createError.set('Produktionsauftrag konnte nicht angelegt werden.');
    } finally {
      this.creating.set(false);
    }
  }

  openOrder(order: ProductionOrderListRow): void {
    this.router.navigate(['/admin/produktion', order.id]);
  }

  statusSeverity(status: ProductionOrderStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (status === 'Fehlgeschlagen') return 'danger';
    if (status === 'Abgeschlossen') return 'success';
    if (status === 'Laeuft') return 'warn';
    return 'secondary';
  }
}
