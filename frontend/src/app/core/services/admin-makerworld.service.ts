import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { AdminIdentityService } from './admin-identity.service';
import { ProductImage } from '../models/db-types';

// Spec 27: Massenimport und Modellvorschläge (Migrationen 00160/00161).

export type ProductSuggestionStatus = 'neu' | 'importiert' | 'abgelehnt';

export interface ProductSuggestionRow {
  id: string;
  makerworldUrl: string;
  makerworldModelId: string;
  note: string | null;
  status: ProductSuggestionStatus;
  productId: string | null;
  createdAt: string;
}

export interface MakerworldImportInput {
  modelId: string;
  url: string;
  originalTitle: string | null;
  name: string;
  images: ProductImage[];
  tags: string[];
  category: string | null;
  weightG: number | null;
  printTimeMin: number | null;
  suggestionId?: string | null;
  // Massenimport (specs/massenimport-makerworld-kollektion.md §3.4): true ->
  // Produkt sofort aktiv im Katalog. Default false = bisheriges Verhalten
  // (Vorschläge-Review-Import, Spec 27 §2).
  active?: boolean;
  // 00198: Platte ("je Platte ein Produkt") und Farbteile
  plateNo?: number | null;
  parts?: { name: string; weightG: number; printTimeMin: number }[];
}

@Injectable({ providedIn: 'root' })
export class AdminMakerworldService {
  constructor(
    private readonly supabase: SupabaseClientService,
    private readonly identity: AdminIdentityService,
  ) {}

  // decided_by ist optional (Spec 27 §3); fehlt die admins-Zeile zur
  // Login-E-Mail, läuft der Import trotzdem (nur ohne Admin-Referenz).
  private async currentAdminId(): Promise<string | null> {
    const { data: sessionData } = await this.supabase.client.auth.getSession();
    const email = sessionData.session?.user.email;
    if (!email) return null;
    const { data } = await this.supabase.client.from('admins').select('id').eq('email', email).maybeSingle();
    return data?.id ?? null;
  }

  // Welche der angegebenen Modell-IDs sind bereits im Katalog? (Duplikat-
  // Vorschau vor dem Anlegen, Spec 27 §6 Schritt 2.)
  async findExistingModelIds(modelIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (modelIds.length === 0) return result;
    const { data, error } = await this.supabase.client
      .from('products')
      .select('id, makerworld_model_id')
      .in('makerworld_model_id', modelIds);
    if (error) throw error;
    for (const row of data ?? []) {
      result.set(row['makerworld_model_id'] as string, row['id'] as string);
    }
    return result;
  }

  async importProduct(input: MakerworldImportInput): Promise<string> {
    const [actor, adminId] = await Promise.all([this.identity.getActor(), this.currentAdminId()]);
    const { data, error } = await this.supabase.client.rpc('fn_import_makerworld_product', {
      p_model_id: input.modelId,
      p_url: input.url,
      p_original_title: input.originalTitle,
      p_name: input.name,
      p_images: input.images,
      p_tags: input.tags,
      p_category: input.category,
      p_weight_g: input.weightG,
      p_print_time_min: input.printTimeMin,
      p_actor: actor,
      p_suggestion_id: input.suggestionId ?? null,
      p_admin_id: adminId,
      p_active: input.active ?? false,
      p_plate_no: input.plateNo ?? null,
      p_parts: (input.parts ?? []).map((p) => ({ name: p.name, weight_g: p.weightG, print_time_min: p.printTimeMin })),
    });
    if (error) throw error;
    return data as string;
  }

  async listOpenSuggestions(): Promise<ProductSuggestionRow[]> {
    const { data, error } = await this.supabase.client
      .from('product_suggestions')
      .select('id, makerworld_url, makerworld_model_id, note, status, product_id, created_at')
      .eq('status', 'neu')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((s) => ({
      id: s['id'],
      makerworldUrl: s['makerworld_url'],
      makerworldModelId: s['makerworld_model_id'],
      note: s['note'],
      status: s['status'],
      productId: s['product_id'],
      createdAt: s['created_at'],
    }));
  }

  async countOpenSuggestions(): Promise<number> {
    const { count, error } = await this.supabase.client
      .from('product_suggestions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'neu');
    if (error) throw error;
    return count ?? 0;
  }

  async rejectSuggestion(id: string, reason: string | null): Promise<void> {
    const [actor, adminId] = await Promise.all([this.identity.getActor(), this.currentAdminId()]);
    const { error } = await this.supabase.client.rpc('fn_reject_product_suggestion', {
      p_id: id,
      p_actor: actor,
      p_reason: reason,
      p_admin_id: adminId,
    });
    if (error) throw error;
  }
}
