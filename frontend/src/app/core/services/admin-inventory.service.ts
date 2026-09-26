import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { AdminIdentityService } from './admin-identity.service';
import { FilamentMovementType } from '../models/db-types';

export interface MovementRow {
  id: string;
  spoolLabel: string;
  movementType: FilamentMovementType;
  amountG: number;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface BWareEligibleItem {
  batchItemId: string;
  description: string;
  qtyScrapNormal: number;
  alreadyBookedQty: number;
  bookableQty: number;
}

@Injectable({ providedIn: 'root' })
export class AdminInventoryService {
  constructor(private readonly supabase: SupabaseClientService, private readonly identity: AdminIdentityService) {}

  async getMovementHistory(): Promise<MovementRow[]> {
    const { data, error } = await this.supabase.client
      .from('filament_movements')
      .select(
        'id, movement_type, amount_g, note, created_by, created_at, filament_spools(filament_products(manufacturer, product_name))',
      )
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return (data ?? []).map((m) => {
      const spool = m['filament_spools'] as unknown as { filament_products: { manufacturer: string; product_name: string } | null } | null;
      const product = spool?.filament_products;
      return {
        id: m['id'],
        spoolLabel: product ? `${product.manufacturer} ${product.product_name}` : 'Unbekannt',
        movementType: m['movement_type'],
        amountG: m['amount_g'],
        note: m['note'],
        createdBy: m['created_by'],
        createdAt: m['created_at'],
      };
    });
  }

  async recordInboundMovement(spoolId: string, amountG: number, note: string | null): Promise<void> {
    const actor = await this.identity.getActor();
    const { error } = await this.supabase.client.from('filament_movements').insert({
      spool_id: spoolId,
      movement_type: 'einkauf',
      amount_g: amountG,
      note,
      created_by: actor,
    });
    if (error) throw error;
  }

  async getBWareEligibleItems(): Promise<BWareEligibleItem[]> {
    const [{ data: batchItems, error: batchError }, { data: bookedMovements, error: movError }] = await Promise.all([
      this.supabase.client
        .from('production_batch_items')
        .select('id, order_item_id, qty_scrap_normal')
        .not('qty_scrap_normal', 'is', null)
        .gt('qty_scrap_normal', 0),
      this.supabase.client
        .from('finished_goods_movements')
        .select('reference_id, qty_delta')
        .eq('movement_type', 'ausschuss_umbuchung')
        .eq('reference_type', 'production_batch_item'),
    ]);
    if (batchError) throw batchError;
    if (movError) throw movError;

    const bookedByBatchItem = new Map<string, number>();
    for (const m of bookedMovements ?? []) {
      bookedByBatchItem.set(m['reference_id'], (bookedByBatchItem.get(m['reference_id']) ?? 0) + m['qty_delta']);
    }

    const orderItemIds = (batchItems ?? []).map((b) => b['order_item_id']);
    let descriptionByOrderItem = new Map<string, string>();
    if (orderItemIds.length > 0) {
      const { data: tracking, error: trackingError } = await this.supabase.client
        .from('v_order_tracking')
        .select('order_item_id, description')
        .in('order_item_id', orderItemIds);
      if (trackingError) throw trackingError;
      descriptionByOrderItem = new Map((tracking ?? []).map((t) => [t['order_item_id'], t['description']]));
    }

    return (batchItems ?? [])
      .map((b) => {
        const already = bookedByBatchItem.get(b['id']) ?? 0;
        const bookable = b['qty_scrap_normal'] - already;
        return {
          batchItemId: b['id'],
          description: descriptionByOrderItem.get(b['order_item_id']) ?? '(unbekannt)',
          qtyScrapNormal: b['qty_scrap_normal'],
          alreadyBookedQty: already,
          bookableQty: bookable,
        };
      })
      .filter((item) => item.bookableQty > 0);
  }

  async bookBWare(batchItemId: string, qty: number, note: string): Promise<void> {
    const actor = await this.identity.getActor();
    const { error } = await this.supabase.client.rpc('fn_book_b_ware', {
      p_production_batch_item_id: batchItemId,
      p_qty: qty,
      p_note: note,
      p_actor: actor,
    });
    if (error) throw error;
  }
}
