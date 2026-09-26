import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { AdminIdentityService } from './admin-identity.service';
import { CalcReason, CustomRequestStatus, OfferStatus } from '../models/db-types';
import { CostComponents } from './admin-catalog.service';

export interface CustomRequestListRow {
  id: string;
  status: CustomRequestStatus;
  desiredSize: string;
  qty: number;
  message: string;
  customerName: string;
  createdAt: string;
}

export interface CustomRequestDetail extends CustomRequestListRow {
  makerworldLink: string | null;
  ownImage: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  colorId: string | null;
  finishId: string | null;
  colorName: string | null;
  finishName: string | null;
  slotColors: { slot_label: string; color_id: string | null; finish_id: string | null; colorName: string | null }[];
  offers: OfferListRow[];
  // Unverbindlicher Vorschlag aus der 3mf-Datei (Worker, Migration 00158); null ohne 3mf/nicht auswertbar.
  estimatedWeightG: number | null;
  estimatedPrintMinutes: number | null;
}

export interface OfferListRow {
  id: string;
  status: OfferStatus;
  validFrom: string;
  validUntil: string;
  secureToken: string;
  customRequestId: string;
  customerName?: string;
}

export interface OfferItemInput {
  productId: string | null;
  desiredVariantDescription: string;
  qty: number;
  costComponents: CostComponents;
  marginPercent: number;
  reason: CalcReason;
}

@Injectable({ providedIn: 'root' })
export class AdminOffersService {
  constructor(private readonly supabase: SupabaseClientService, private readonly identity: AdminIdentityService) {}

  async listCustomRequests(): Promise<CustomRequestListRow[]> {
    const { data, error } = await this.supabase.client
      .from('custom_requests')
      .select('id, status, desired_size, qty, message, created_at, customers(first_name, last_name)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => {
      const customer = r['customers'] as unknown as { first_name: string; last_name: string } | null;
      return {
        id: r['id'],
        status: r['status'],
        desiredSize: r['desired_size'],
        qty: r['qty'],
        message: r['message'],
        customerName: customer ? `${customer.first_name} ${customer.last_name}` : '',
        createdAt: r['created_at'],
      };
    });
  }

  async getCustomRequestDetail(id: string): Promise<CustomRequestDetail> {
    const [{ data: request, error: requestError }, { data: slotColors, error: slotError }, { data: offers, error: offersError }] =
      await Promise.all([
        this.supabase.client
          .from('custom_requests')
          .select(
            'id, status, desired_size, qty, message, created_at, makerworld_link, own_image, color_id, finish_id, estimated_weight_g, estimated_print_minutes, colors(name), finishes(name), customers(first_name, last_name, phone, email)',
          )
          .eq('id', id)
          .single(),
        this.supabase.client
          .from('custom_request_colors')
          .select('slot_label, color_id, finish_id, colors(name)')
          .eq('custom_request_id', id),
        this.supabase.client.from('offers').select('id, status, valid_from, valid_until, secure_token, custom_request_id').eq('custom_request_id', id),
      ]);

    if (requestError) throw requestError;
    if (slotError) throw slotError;
    if (offersError) throw offersError;

    const customer = request['customers'] as unknown as {
      first_name: string;
      last_name: string;
      phone: string | null;
      email: string | null;
    } | null;

    return {
      id: request['id'],
      status: request['status'],
      desiredSize: request['desired_size'],
      qty: request['qty'],
      message: request['message'],
      customerName: customer ? `${customer.first_name} ${customer.last_name}` : '',
      createdAt: request['created_at'],
      makerworldLink: request['makerworld_link'],
      ownImage: request['own_image'],
      customerPhone: customer?.phone ?? null,
      customerEmail: customer?.email ?? null,
      colorId: request['color_id'],
      finishId: request['finish_id'],
      colorName: (request['colors'] as unknown as { name: string } | null)?.name ?? null,
      finishName: (request['finishes'] as unknown as { name: string } | null)?.name ?? null,
      estimatedWeightG: request['estimated_weight_g'] ?? null,
      estimatedPrintMinutes: request['estimated_print_minutes'] ?? null,
      slotColors: (slotColors ?? []).map((s) => ({
        slot_label: s['slot_label'],
        color_id: s['color_id'],
        finish_id: s['finish_id'],
        colorName: (s['colors'] as unknown as { name: string } | null)?.name ?? null,
      })),
      offers: (offers ?? []).map((o) => ({
        id: o['id'],
        status: o['status'],
        validFrom: o['valid_from'],
        validUntil: o['valid_until'],
        secureToken: o['secure_token'],
        customRequestId: o['custom_request_id'],
      })),
    };
  }

  async rejectCustomRequest(id: string, reason: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_reject_custom_request', {
      p_custom_request_id: id,
      p_reason: reason,
      p_actor: await this.identity.getActor(),
    });
    if (error) throw error;
  }

  async createOfferFromRequest(
    requestId: string,
    validFrom: string,
    validUntil: string,
    items: OfferItemInput[],
  ): Promise<string> {
    const { data, error } = await this.supabase.client.rpc('fn_create_offer_from_request', {
      p_custom_request_id: requestId,
      p_valid_from: validFrom,
      p_valid_until: validUntil,
      p_items: items.map((i) => ({
        product_id: i.productId,
        desired_variant_description: i.desiredVariantDescription,
        qty: i.qty,
        cost_components: i.costComponents,
        margin_percent: i.marginPercent,
        reason: i.reason,
      })),
      p_created_by: await this.identity.getActor(),
    });
    if (error) throw error;
    return data as string;
  }

  async listOffers(): Promise<OfferListRow[]> {
    const { data, error } = await this.supabase.client
      .from('offers')
      .select('id, status, valid_from, valid_until, secure_token, custom_request_id, custom_requests(customers(first_name, last_name))')
      .order('valid_from', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((o) => {
      const request = o['custom_requests'] as unknown as { customers: { first_name: string; last_name: string } | null } | null;
      const customer = request?.customers;
      return {
        id: o['id'],
        status: o['status'],
        validFrom: o['valid_from'],
        validUntil: o['valid_until'],
        secureToken: o['secure_token'],
        customRequestId: o['custom_request_id'],
        customerName: customer ? `${customer.first_name} ${customer.last_name}` : '',
      };
    });
  }

  async rejectOffer(offerId: string, reason: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_reject_offer', {
      p_offer_id: offerId,
      p_rejection_reason: reason,
      p_actor: await this.identity.getActor(),
    });
    if (error) throw error;
  }

  async revokeOffer(offerId: string, reason: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_revoke_offer', {
      p_offer_id: offerId,
      p_revoke_reason: reason,
      p_actor: await this.identity.getActor(),
    });
    if (error) throw error;
  }
}
