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
