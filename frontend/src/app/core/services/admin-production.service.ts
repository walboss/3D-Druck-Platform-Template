import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { AdminIdentityService } from './admin-identity.service';
import { ProductionOrderStatus } from '../models/db-types';

export interface ProductionOrderListRow {
  id: string;
  status: ProductionOrderStatus;
  plannedStart: string;
  actualStart: string | null;
  actualEnd: string | null;
  printerName: string | null;
}

export interface BatchItemRow {
  id: string;
  orderItemId: string;
  description: string;
  qtyPlanned: number;
  qtySuccess: number | null;
  qtyScrapNormal: number | null;
  qtyScrapComplaint: number | null;
  isComplete: boolean;
}

export interface UnassignedItemRow {
  orderItemId: string;
  description: string;
  qty: number;
}

export interface ProductionOrderDetail {
  id: string;
  status: ProductionOrderStatus;
  plannedStart: string;
  actualStart: string | null;
  actualEnd: string | null;
  printerName: string | null;
  batchItems: BatchItemRow[];
  unassignedItems: UnassignedItemRow[];
}

@Injectable({ providedIn: 'root' })
export class AdminProductionService {
  constructor(private readonly supabase: SupabaseClientService, private readonly identity: AdminIdentityService) {}

  async listProductionOrders(): Promise<ProductionOrderListRow[]> {
    const { data, error } = await this.supabase.client
      .from('production_orders')
      .select('id, status, planned_start, actual_start, actual_end, printers(name)')
      .order('planned_start', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => ({
      id: r['id'],
      status: r['status'],
      plannedStart: r['planned_start'],
      actualStart: r['actual_start'],
      actualEnd: r['actual_end'],
      printerName: (r['printers'] as unknown as { name: string } | null)?.name ?? null,
    }));
  }

  // Standard-Drucker (Migration 00186) zuerst und mit "(Standard)" markiert.
  async getPrinters(): Promise<{ id: string; name: string; isDefault: boolean }[]> {
    const { data, error } = await this.supabase.client
      .from('printers')
      .select('id, name, is_default')
      .eq('active', true)
      .order('is_default', { ascending: false })
      .order('name');
    if (error) throw error;
    return (data ?? []).map((p) => ({
      id: p.id,
      name: p.is_default ? `${p.name} (Standard)` : p.name,
      isDefault: p.is_default,
    }));
  }

  async createProductionOrder(printerId: string | null, plannedStart: string): Promise<string> {
    const { data, error } = await this.supabase.client.rpc('fn_create_production_order', {
      p_printer_id: printerId,
      p_planned_start: plannedStart,
      p_actor: await this.identity.getActor(),
    });
    if (error) throw error;
    return data as string;
  }

  async getProductionOrderDetail(id: string): Promise<ProductionOrderDetail> {
    const [{ data: po, error: poError }, { data: batchItems, error: batchError }, { data: unassigned, error: unassignedError }] =
      await Promise.all([
        this.supabase.client
          .from('production_orders')
          .select('id, status, planned_start, actual_start, actual_end, printers(name)')
          .eq('id', id)
          .single(),
        this.supabase.client
          .from('production_batch_items')
          .select('id, order_item_id, qty_planned, qty_success, qty_scrap_normal, qty_scrap_complaint')
          .eq('production_order_id', id),
        this.supabase.client
          .from('order_items')
          .select('id, qty, desired_description')
          .eq('production_order_id', id)
          .eq('status', 'InProduktion'),
      ]);

    if (poError) throw poError;
    if (batchError) throw batchError;
    if (unassignedError) throw unassignedError;

    const batchOrderItemIds = new Set((batchItems ?? []).map((b) => b['order_item_id']));
    const allOrderItemIds = [
      ...(batchItems ?? []).map((b) => b['order_item_id']),
      ...(unassigned ?? []).map((u) => u['id']),
    ];

    let descriptionByOrderItem = new Map<string, string>();
    if (allOrderItemIds.length > 0) {
      const { data: tracking, error: trackingError } = await this.supabase.client
        .from('v_order_tracking')
        .select('order_item_id, description')
        .in('order_item_id', allOrderItemIds);
      if (trackingError) throw trackingError;
      descriptionByOrderItem = new Map((tracking ?? []).map((t) => [t['order_item_id'], t['description']]));
    }

    const batchItemRows: BatchItemRow[] = (batchItems ?? []).map((b) => ({
      id: b['id'],
      orderItemId: b['order_item_id'],
      description: descriptionByOrderItem.get(b['order_item_id']) ?? '(unbekannt)',
      qtyPlanned: b['qty_planned'],
      qtySuccess: b['qty_success'],
      qtyScrapNormal: b['qty_scrap_normal'],
      qtyScrapComplaint: b['qty_scrap_complaint'],
      isComplete: b['qty_success'] !== null,
    }));

    const unassignedRows: UnassignedItemRow[] = (unassigned ?? [])
      .filter((u) => !batchOrderItemIds.has(u['id']))
      .map((u) => ({
        orderItemId: u['id'],
        description: descriptionByOrderItem.get(u['id']) ?? '(unbekannt)',
        qty: u['qty'],
      }));

    return {
      id: po!['id'],
      status: po!['status'],
      plannedStart: po!['planned_start'],
      actualStart: po!['actual_start'],
      actualEnd: po!['actual_end'],
      printerName: (po!['printers'] as unknown as { name: string } | null)?.name ?? null,
      batchItems: batchItemRows,
      unassignedItems: unassignedRows,
    };
  }

  async startProduction(
    productionOrderId: string,
    spoolAssignments: { order_item_id: string; spool_id: string; amount_g: number }[],
  ): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_start_production_order', {
      p_production_order_id: productionOrderId,
      p_spool_assignments: spoolAssignments,
    });
    if (error) throw error;
  }

  async completeOrderItem(
    batchItemId: string,
    qtySuccess: number,
    qtyScrapNormal: number,
    qtyScrapComplaint: number,
    materialUsage: { spool_id: string; amount_g: number; scrap_amount_g?: number }[],
  ): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_complete_order_item', {
      p_production_batch_item_id: batchItemId,
      p_qty_success: qtySuccess,
      p_qty_scrap_normal: qtyScrapNormal,
      p_qty_scrap_complaint: qtyScrapComplaint,
      p_actual_material_usage: materialUsage,
    });
    if (error) throw error;
  }

  async completeProductionOrder(id: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_complete_production_order', {
      p_production_order_id: id,
      p_actor: await this.identity.getActor(),
    });
    if (error) throw error;
  }

  async failProductionOrder(id: string, reason: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_fail_production_order', {
      p_production_order_id: id,
      p_reason: reason,
      p_actor: await this.identity.getActor(),
    });
    if (error) throw error;
  }
}
