import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { FilamentService, LowStockSpool } from './filament.service';

export interface OpenOrdersSummary {
  count: number;
  orders: { id: string; order_number: string; status: string; created_at: string; customer_message: string | null }[];
}

export interface RunningProductionSummary {
  count: number;
  orders: { id: string; status: string; planned_start: string; actual_start: string | null }[];
}

export type { LowStockSpool };

@Injectable({ providedIn: 'root' })
export class AdminDashboardService {
  constructor(private readonly supabase: SupabaseClientService, private readonly filamentService: FilamentService) {}

  async getOpenOrders(): Promise<OpenOrdersSummary> {
    const { data, error } = await this.supabase.client
      .from('orders')
      .select('id, order_number, status, created_at, customer_message')
      .in('status', ['New', 'Confirmed', 'InProduction'])
      .order('created_at', { ascending: true });
    if (error) throw error;
    return { count: data?.length ?? 0, orders: data ?? [] };
  }

  /** Neue Bestellungen (Status New) – Zähler im Admin-Menü. */
  async getNewOrdersCount(): Promise<number> {
    const { count, error } = await this.supabase.client
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'New');
    if (error) throw error;
    return count ?? 0;
  }

  /** Bestellungen „Bereit zur Abholung“ (Spec 19, Entscheidung 2026-11-14). */
  async getReadyForPickupCount(): Promise<number> {
    const { count, error } = await this.supabase.client
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'ReadyForPickup');
    if (error) throw error;
    return count ?? 0;
  }

  /** Individualanfragen im Status „neu“ (Spec 19, Entscheidung 2026-11-14). */
  async getNewRequestsCount(): Promise<number> {
    const { count, error } = await this.supabase.client
      .from('custom_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'neu');
    if (error) throw error;
    return count ?? 0;
  }

  async getRunningProduction(): Promise<RunningProductionSummary> {
    const { data, error } = await this.supabase.client
      .from('production_orders')
      .select('id, status, planned_start, actual_start')
      .eq('status', 'Laeuft')
      .order('actual_start', { ascending: true });
    if (error) throw error;
    return { count: data?.length ?? 0, orders: data ?? [] };
  }

  async getLowStock(): Promise<LowStockSpool[]> {
    return this.filamentService.getLowStockSpools();
  }
}
