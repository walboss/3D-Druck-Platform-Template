import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { OfferViewResult } from '../models/db-types';

@Injectable({ providedIn: 'root' })
export class OfferService {
  constructor(private readonly supabase: SupabaseClientService) {}

  async getOfferByToken(token: string): Promise<OfferViewResult> {
    const { data, error } = await this.supabase.client.rpc('fn_get_offer_by_token', {
      p_secure_token: token,
    });
    if (error) throw error;
    return data as OfferViewResult;
  }

  async acceptOffer(token: string): Promise<{ order_id: string; tracking_token: string }> {
    const { data, error } = await this.supabase.client.rpc('fn_accept_offer', {
      p_secure_token: token,
    });
    if (error) throw error;
    return data as { order_id: string; tracking_token: string };
  }
}
