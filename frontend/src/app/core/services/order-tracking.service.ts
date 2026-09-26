import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { OrderTrackingResult } from '../models/db-types';

@Injectable({ providedIn: 'root' })
export class OrderTrackingService {
  constructor(private readonly supabase: SupabaseClientService) {}

  async getOrderByToken(token: string): Promise<OrderTrackingResult> {
    const { data, error } = await this.supabase.client.rpc('fn_get_order_by_token', {
      p_token: token,
    });
    if (error) throw error;
    return data as OrderTrackingResult;
  }
}
