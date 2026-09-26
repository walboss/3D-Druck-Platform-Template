import { Component, OnInit, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { MultiSelectModule } from 'primeng/multiselect';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';

import { AdminOrdersService, AdminOrderListRow } from '../../../core/services/admin-orders.service';
import { OrderStatus } from '../../../core/models/db-types';
import { PopoverModule } from 'primeng/popover';

const ALL_STATUSES: OrderStatus[] = [
  'New',
  'Confirmed',
  'InProduction',
  'Finished',
  'ReadyForPickup',
  'HandedOver',
  'Cancelled',
];

@Component({
  selector: 'app-admin-orders-list',
  standalone: true,
  imports: [PopoverModule, DatePipe, FormsModule, TableModule, InputTextModule, MultiSelectModule, TagModule, SkeletonModule, MessageModule],
  templateUrl: './admin-orders-list.html',
  styleUrl: './admin-orders-list.scss',
})
export class AdminOrdersList implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly orders = signal<AdminOrderListRow[]>([]);

  readonly search = signal('');
  readonly statusFilter = signal<OrderStatus[]>([]);

  readonly statusOptions = ALL_STATUSES.map((s) => ({ label: s, value: s }));

  readonly filteredOrders = computed(() => {
    const search = this.search().trim().toLowerCase();
    const statuses = this.statusFilter();
    return this.orders().filter((o) => {
      const matchesSearch =
        !search ||
        o.order_number.toLowerCase().includes(search) ||
        o.customerName.toLowerCase().includes(search);
      const matchesStatus = statuses.length === 0 || statuses.includes(o.status);
      return matchesSearch && matchesStatus;
    });
  });

  constructor(private readonly ordersService: AdminOrdersService, private readonly router: Router) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.orders.set(await this.ordersService.listOrders());
    } catch {
      this.error.set('Bestellungen konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  openOrder(order: AdminOrderListRow): void {
    this.router.navigate(['/admin/bestellungen', order.id]);
  }

  statusSeverity(status: OrderStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (status === 'Cancelled') return 'danger';
    if (status === 'HandedOver') return 'success';
    if (status === 'New') return 'secondary';
    return 'info';
  }
}
