import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { AdminIdentityService } from './admin-identity.service';
import { ComplaintDecision } from '../models/db-types';

export interface ComplaintRow {
  id: string;
  orderItemId: string;
  description: string;
  reason: string;
  reportedAt: string;
  decision: ComplaintDecision | null;
  decisionNote: string | null;
  cost: number | null;
  resolvedAt: string | null;
}

export interface HandedOverItemOption {
  orderItemId: string;
  orderNumber: string;
  description: string;
}

export interface BatchItemOption {
  id: string;
  description: string;
}

@Injectable({ providedIn: 'root' })
export class AdminComplaintsService {
  constructor(private readonly supabase: SupabaseClientService, private readonly identity: AdminIdentityService) {}

  async listComplaints(): Promise<ComplaintRow[]> {
    const { data: complaints, error } = await this.supabase.client
      .from('complaints')
      .select('id, order_item_id, reason, reported_at, decision, decision_note, cost, resolved_at')
      .order('reported_at', { ascending: false });
    if (error) throw error;

    const orderItemIds = (complaints ?? []).map((c) => c['order_item_id']);
    let descriptionByItem = new Map<string, string>();
    if (orderItemIds.length > 0) {
      const { data: tracking, error: trackingError } = await this.supabase.client
        .from('v_order_tracking')
        .select('order_item_id, description')
        .in('order_item_id', orderItemIds);
      if (trackingError) throw trackingError;
      descriptionByItem = new Map((tracking ?? []).map((t) => [t['order_item_id'], t['description']]));
    }

    return (complaints ?? []).map((c) => ({
      id: c['id'],
      orderItemId: c['order_item_id'],
      description: descriptionByItem.get(c['order_item_id']) ?? '(unbekannt)',
      reason: c['reason'],
      reportedAt: c['reported_at'],
      decision: c['decision'],
      decisionNote: c['decision_note'],
      cost: c['cost'],
      resolvedAt: c['resolved_at'],
    }));
  }

  async getHandedOverItems(): Promise<HandedOverItemOption[]> {
    const { data: orders, error } = await this.supabase.client
      .from('orders')
      .select('id, order_number, order_items(id, status)')
      .eq('status', 'HandedOver');
    if (error) throw error;

    const rows: { orderItemId: string; orderNumber: string }[] = [];
    for (const o of orders ?? []) {
      const items = (o['order_items'] as unknown as { id: string; status: string }[]) ?? [];
      for (const item of items) {
        if (item.status !== 'Storniert') {
          rows.push({ orderItemId: item.id, orderNumber: o['order_number'] });
        }
      }
    }

    if (rows.length === 0) return [];
    const { data: tracking, error: trackingError } = await this.supabase.client
      .from('v_order_tracking')
      .select('order_item_id, description')
      .in('order_item_id', rows.map((r) => r.orderItemId));
    if (trackingError) throw trackingError;
    const descriptionByItem = new Map((tracking ?? []).map((t) => [t['order_item_id'], t['description']]));

    return rows.map((r) => ({
      orderItemId: r.orderItemId,
      orderNumber: r.orderNumber,
      description: descriptionByItem.get(r.orderItemId) ?? '(unbekannt)',
    }));
  }

  async reportComplaint(orderItemId: string, reason: string): Promise<string> {
    const { data, error } = await this.supabase.client.rpc('fn_report_complaint', {
      p_order_item_id: orderItemId,
      p_reason: reason,
      p_actor: await this.identity.getActor(),
    });
    if (error) throw error;
    return data as string;
  }

  async getRecentBatchItems(): Promise<BatchItemOption[]> {
    const { data: batchItems, error } = await this.supabase.client
      .from('production_batch_items')
      .select('id, order_item_id, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    const orderItemIds = (batchItems ?? []).map((b) => b['order_item_id']);
    let descriptionByItem = new Map<string, string>();
    if (orderItemIds.length > 0) {
      const { data: tracking, error: trackingError } = await this.supabase.client
        .from('v_order_tracking')
        .select('order_item_id, description')
        .in('order_item_id', orderItemIds);
      if (trackingError) throw trackingError;
      descriptionByItem = new Map((tracking ?? []).map((t) => [t['order_item_id'], t['description']]));
    }

    return (batchItems ?? []).map((b) => ({
      id: b['id'],
      description: descriptionByItem.get(b['order_item_id']) ?? '(unbekannt)',
    }));
  }

  async resolveComplaint(
    complaintId: string,
    decision: ComplaintDecision,
    decisionNote: string,
    cost: number | null,
    replacementBatchItemId: string | null,
  ): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_resolve_complaint', {
      p_complaint_id: complaintId,
      p_decision: decision,
      p_decision_note: decisionNote,
      p_cost: cost,
      p_replacement_batch_item_id: replacementBatchItemId,
      p_actor: await this.identity.getActor(),
    });
    if (error) throw error;
  }
}
