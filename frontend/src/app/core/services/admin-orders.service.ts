import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { OrderItemStatus, OrderStatus } from '../models/db-types';

export interface AdminOrderListRow {
  id: string;
  order_number: string;
  status: OrderStatus;
  created_at: string;
  customerName: string;
  hasExceptionItems: boolean;
  customerMessage: string | null;
}

export interface AdminOrderItemRow {
  orderItemId: string;
  description: string;
  qty: number;
  status: OrderItemStatus;
  finalPrice: number | null;
  productionOrderId: string | null;
  productId: string | null;
  variantId: string | null;
  variantConfigurationId: string | null;
  colorChanges: ColorChangeEntry[];
}

// Farbwechsel aus audit_log (Migration 00197, fn_change_order_item_configuration)
export interface ColorChangeEntry {
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  createdAt: string;
}

export interface ColorChangeOptions {
  // Einfarbig: ein Eintrag mit key null; mehrfarbig: je Teil ein Eintrag
  parts: { key: string | null; label: string }[];
  colors: { id: string; name: string }[];
  finishes: { id: string; name: string }[];
  current: Record<string, { colorId: string | null; finishId: string | null }>;
}

export interface AdminOrderDetail {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  customer: { id: string; first_name: string; last_name: string; email: string | null; phone: string | null };
  customerMessage: string | null;
  internalNote: string | null;
  cancellationReason: string | null;
  confirmedAt: string | null;
  finishedAt: string | null;
  readyForPickupAt: string | null;
  handedOverAt: string | null;
  items: AdminOrderItemRow[];
}

@Injectable({ providedIn: 'root' })
export class AdminOrdersService {
  constructor(private readonly supabase: SupabaseClientService) {}

  async listOrders(): Promise<AdminOrderListRow[]> {
    const [{ data: orders, error: ordersError }, { data: items, error: itemsError }] = await Promise.all([
      this.supabase.client
        .from('orders')
        .select('id, order_number, status, created_at, customer_message, customers(first_name, last_name)')
        .order('created_at', { ascending: false }),
      this.supabase.client.from('order_items').select('order_id, desired_description'),
    ]);
    if (ordersError) throw ordersError;
    if (itemsError) throw itemsError;

    const exceptionOrderIds = new Set(
      (items ?? []).filter((i) => i['desired_description'] !== null).map((i) => i['order_id']),
    );

    return (orders ?? []).map((o) => {
      const customer = o['customers'] as unknown as { first_name: string; last_name: string } | null;
      return {
        id: o['id'],
        order_number: o['order_number'],
        status: o['status'],
        created_at: o['created_at'],
        customerName: customer ? `${customer.first_name} ${customer.last_name}` : '',
        hasExceptionItems: exceptionOrderIds.has(o['id']),
        customerMessage: o['customer_message'] ?? null,
      };
    });
  }

  async getOrderDetail(orderId: string): Promise<AdminOrderDetail> {
    const [
      { data: order, error: orderError },
      { data: rawItems, error: rawItemsError },
      { data: trackingRows, error: trackingError },
    ] = await Promise.all([
      this.supabase.client
        .from('orders')
        .select(
          'id, order_number, status, customer_message, internal_note, cancellation_reason, confirmed_at, finished_at, ready_for_pickup_at, handed_over_at, customers(id, first_name, last_name, email, phone)',
        )
        .eq('id', orderId)
        .single(),
      this.supabase.client
        .from('order_items')
        .select('id, status, production_order_id, product_id, variant_id, variant_configuration_id')
        .eq('order_id', orderId),
      this.supabase.client
        .from('v_order_tracking')
        .select('order_item_id, description, qty, item_status, final_price')
        .eq('order_id', orderId),
    ]);

    if (orderError) throw orderError;
    if (rawItemsError) throw rawItemsError;
    if (trackingError) throw trackingError;

    const trackingByItemId = new Map((trackingRows ?? []).map((t) => [t['order_item_id'], t]));

    const itemIds = (rawItems ?? []).map((r) => r['id'] as string);
    const colorChangesByItem = new Map<string, ColorChangeEntry[]>();
    if (itemIds.length > 0) {
      const { data: audits, error: auditError } = await this.supabase.client
        .from('audit_log')
        .select('entity_id, old_value, new_value, reason, created_at')
        .eq('entity_type', 'order_item')
        .eq('field_name', 'variant_configuration_id')
        .in('entity_id', itemIds)
        .order('created_at', { ascending: true });
      if (auditError) throw auditError;
      for (const a of audits ?? []) {
        const list = colorChangesByItem.get(a['entity_id']) ?? [];
        list.push({ oldValue: a['old_value'], newValue: a['new_value'], reason: a['reason'], createdAt: a['created_at'] });
        colorChangesByItem.set(a['entity_id'], list);
      }
    }

    const items: AdminOrderItemRow[] = (rawItems ?? []).map((raw) => {
      const tracking = trackingByItemId.get(raw['id']);
      return {
        orderItemId: raw['id'],
        description: tracking?.['description'] ?? '(unbekannt)',
        qty: tracking?.['qty'] ?? 0,
        status: raw['status'],
        finalPrice: tracking?.['final_price'] ?? null,
        productionOrderId: raw['production_order_id'],
        productId: raw['product_id'],
        variantId: raw['variant_id'],
        variantConfigurationId: raw['variant_configuration_id'],
        colorChanges: colorChangesByItem.get(raw['id']) ?? [],
      };
    });

    const customer = order!['customers'] as unknown as {
      id: string;
      first_name: string;
      last_name: string;
      email: string | null;
      phone: string | null;
    };

    return {
      id: order!['id'],
      orderNumber: order!['order_number'],
      status: order!['status'],
      customer,
      customerMessage: order!['customer_message'],
      internalNote: order!['internal_note'],
      cancellationReason: order!['cancellation_reason'],
      confirmedAt: order!['confirmed_at'],
      finishedAt: order!['finished_at'],
      readyForPickupAt: order!['ready_for_pickup_at'],
      handedOverAt: order!['handed_over_at'],
      items,
    };
  }

  // Auswahl für "Farbe ändern": aktive Farben/Finishes, Teile (mehrfarbig)
  // und die aktuelle Konfiguration der Position.
  async getColorChangeOptions(productId: string, variantConfigurationId: string): Promise<ColorChangeOptions> {
    const [
      { data: product, error: productError },
      { data: parts, error: partsError },
      { data: colors, error: colorsError },
      { data: finishes, error: finishesError },
      { data: currentRows, error: currentError },
    ] = await Promise.all([
      this.supabase.client.from('products').select('is_multicolor').eq('id', productId).single(),
      this.supabase.client.from('product_parts').select('id, name').eq('product_id', productId).order('sort_order'),
      this.supabase.client.from('colors').select('id, name').eq('active', true).order('name'),
      this.supabase.client.from('finishes').select('id, name').eq('active', true).order('name'),
      this.supabase.client
        .from('variant_configuration_colors')
        .select('product_part_id, color_id, finish_id')
        .eq('variant_configuration_id', variantConfigurationId),
    ]);
    if (productError) throw productError;
    if (partsError) throw partsError;
    if (colorsError) throw colorsError;
    if (finishesError) throw finishesError;
    if (currentError) throw currentError;

    const multicolor = !!product?.['is_multicolor'] && (parts ?? []).length > 0;
    const partList = multicolor
      ? (parts ?? []).map((p) => ({ key: p['id'] as string, label: p['name'] as string }))
      : [{ key: null, label: 'Farbe' }];

    const current: ColorChangeOptions['current'] = {};
    for (const part of partList) {
      const row = (currentRows ?? []).find((r) => (r['product_part_id'] ?? null) === part.key);
      current[part.key ?? ''] = { colorId: row?.['color_id'] ?? null, finishId: row?.['finish_id'] ?? null };
    }

    return {
      parts: partList,
      colors: (colors ?? []).map((c) => ({ id: c['id'], name: c['name'] })),
      finishes: (finishes ?? []).map((f) => ({ id: f['id'], name: f['name'] })),
      current,
    };
  }

  async changeItemConfiguration(
    orderItemId: string,
    partColorMap: { product_part_id: string | null; color_id: string; finish_id: string }[],
    reason: string,
  ): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_change_order_item_configuration', {
      p_order_item_id: orderItemId,
      p_part_color_map: partColorMap,
      p_reason: reason,
    });
    if (error) throw error;
  }

  async confirmOrder(orderId: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_confirm_order', { p_order_id: orderId });
    if (error) throw error;
  }

  async getAssignableProductionOrders(): Promise<{ id: string; status: string; planned_start: string }[]> {
    const { data, error } = await this.supabase.client
      .from('production_orders')
      .select('id, status, planned_start')
      .in('status', ['Geplant', 'Laeuft'])
      .order('planned_start', { ascending: true });
    if (error) throw error;
    return data ?? [];
  }

  async assignToProduction(orderItemId: string, productionOrderId: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_assign_to_production', {
      p_order_item_id: orderItemId,
      p_production_order_id: productionOrderId,
    });
    if (error) throw error;
  }

  async addPositionToRunningOrder(
    orderItemId: string,
    spoolAssignments: { spool_id: string; amount_g: number }[],
  ): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_add_position_to_running_order', {
      p_order_item_id: orderItemId,
      p_spool_assignments: spoolAssignments,
    });
    if (error) throw error;
  }

  async readyForPickup(orderId: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_ready_for_pickup', { p_order_id: orderId });
    if (error) throw error;
  }

  async handOverOrder(orderId: string, handedOverBy: string, handoverNote: string | null): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_hand_over_order', {
      p_order_id: orderId,
      p_handed_over_by: handedOverBy,
      p_handover_note: handoverNote,
    });
    if (error) throw error;
  }

  async cancelOrderItem(orderItemId: string, reason: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_cancel_order_item', {
      p_order_item_id: orderItemId,
      p_reason: reason,
    });
    if (error) throw error;
  }

  async cancelOrder(orderId: string, reason: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_cancel_order', {
      p_order_id: orderId,
      p_reason: reason,
    });
    if (error) throw error;
  }

  async getCurrentAdminId(): Promise<string | null> {
    const { data: sessionData } = await this.supabase.client.auth.getSession();
    const email = sessionData.session?.user.email;
    if (!email) return null;
    const { data, error } = await this.supabase.client.from('admins').select('id').eq('email', email).maybeSingle();
    if (error) throw error;
    return data?.id ?? null;
  }
}
