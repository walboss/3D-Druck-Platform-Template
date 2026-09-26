import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';

export interface SpoolAvailability {
  id: string;
  filamentProductId: string;
  label: string;
  restG: number;
  availableG: number;
  isCritical: boolean;
}

export interface LowStockSpool {
  id: string;
  filament_product_id: string;
  productLabel: string;
  availableG: number;
}

export interface FilamentProductOption {
  id: string;
  label: string;
}

export interface FilamentProductDetail {
  id: string;
  manufacturer: string;
  productName: string;
  material: string;
  colorId: string;
  colorName: string;
  finishId: string;
  finishName: string;
  diameterMm: number;
  active: boolean;
}

export interface CreateFilamentProductInput {
  manufacturer: string;
  productName: string;
  material: string;
  colorId: string;
  finishId: string;
  diameterMm: number;
}

export interface CreateSpoolInput {
  filamentProductId: string;
  purchasePrice: number;
  initialWeightG: number;
  tareWeightG: number;
  purchaseDate: string;
}

export interface SpoolDetail {
  id: string;
  filamentProductId: string;
  purchasePrice: number;
  initialWeightG: number;
  tareWeightG: number;
  purchaseDate: string;
}

// Kein settings-Feld für einen Schwellenwert vorhanden (siehe BUILD-LOG) —
// fixer Schwellenwert als Annahme, geteilt mit AdminDashboardService.
export const CRITICAL_STOCK_THRESHOLD_G = 100;

@Injectable({ providedIn: 'root' })
export class FilamentService {
  constructor(private readonly supabase: SupabaseClientService) {}

  async getSpoolsWithAvailability(): Promise<SpoolAvailability[]> {
    const [{ data: spools, error: spoolsError }, { data: movements, error: movementsError }, { data: reservations, error: reservationsError }, { data: products, error: productsError }] =
      await Promise.all([
        this.supabase.client
          .from('filament_spools')
          .select('id, filament_product_id, initial_weight_g')
          .eq('active', true),
        this.supabase.client.from('filament_movements').select('spool_id, amount_g'),
        this.supabase.client.from('filament_reservations').select('spool_id, amount_g').eq('status', 'aktiv'),
        this.supabase.client.from('filament_products').select('id, manufacturer, product_name, material, color_id, colors(name)'),
      ]);

    if (spoolsError) throw spoolsError;
    if (movementsError) throw movementsError;
    if (reservationsError) throw reservationsError;
    if (productsError) throw productsError;

    const movementSumBySpool = new Map<string, number>();
    for (const m of movements ?? []) {
      movementSumBySpool.set(m['spool_id'], (movementSumBySpool.get(m['spool_id']) ?? 0) + m['amount_g']);
    }
    const reservedSumBySpool = new Map<string, number>();
    for (const r of reservations ?? []) {
      reservedSumBySpool.set(r['spool_id'], (reservedSumBySpool.get(r['spool_id']) ?? 0) + r['amount_g']);
    }
    const productById = new Map((products ?? []).map((p) => [p['id'], p]));

    return (spools ?? []).map((spool) => {
      const rest = spool['initial_weight_g'] + (movementSumBySpool.get(spool['id']) ?? 0);
      const available = rest - (reservedSumBySpool.get(spool['id']) ?? 0);
      const product = productById.get(spool['filament_product_id']);
      const colorName = (product as { colors?: { name?: string } } | undefined)?.colors?.name;
      const label = product
        ? `${product['manufacturer']} ${product['product_name']} (${product['material']}${colorName ? ', ' + colorName : ''})`
        : 'Unbekannt';
      return {
        id: spool['id'],
        filamentProductId: spool['filament_product_id'],
        label,
        restG: Math.round(rest),
        availableG: Math.round(available),
        isCritical: available < CRITICAL_STOCK_THRESHOLD_G,
      };
    });
  }

  async getLowStockSpools(): Promise<LowStockSpool[]> {
    const spools = await this.getSpoolsWithAvailability();
    return spools
      .filter((s) => s.isCritical)
      .sort((a, b) => a.availableG - b.availableG)
      .map((s) => ({
        id: s.id,
        filament_product_id: s.filamentProductId,
        productLabel: s.label,
        availableG: s.availableG,
      }));
  }

  async listActiveFilamentProducts(): Promise<FilamentProductOption[]> {
    const { data, error } = await this.supabase.client
      .from('filament_products')
      .select('id, manufacturer, product_name, material, colors(name), finishes(name)')
      .eq('active', true)
      .order('manufacturer')
      .order('product_name');
    if (error) throw error;
    return (data ?? []).map((p) => {
      const colorName = (p['colors'] as unknown as { name?: string } | null)?.name;
      const finishName = (p['finishes'] as unknown as { name?: string } | null)?.name;
      const suffix = [p['material'], colorName, finishName].filter(Boolean).join(', ');
      return {
        id: p['id'],
        label: `${p['manufacturer']} ${p['product_name']}${suffix ? ' (' + suffix + ')' : ''}`,
      };
    });
  }

  async createFilamentProduct(input: CreateFilamentProductInput): Promise<string> {
    const { data, error } = await this.supabase.client
      .from('filament_products')
      .insert({
        manufacturer: input.manufacturer,
        product_name: input.productName,
        material: input.material,
        color_id: input.colorId,
        finish_id: input.finishId,
        diameter_mm: input.diameterMm,
        active: true,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data['id'];
  }

  async listAllFilamentProducts(): Promise<FilamentProductDetail[]> {
    const { data, error } = await this.supabase.client
      .from('filament_products')
      .select('id, manufacturer, product_name, material, diameter_mm, active, color_id, finish_id, colors(name), finishes(name)')
      .order('manufacturer')
      .order('product_name');
    if (error) throw error;
    return (data ?? []).map((p) => ({
      id: p['id'],
      manufacturer: p['manufacturer'],
      productName: p['product_name'],
      material: p['material'],
      colorId: p['color_id'],
      colorName: (p['colors'] as unknown as { name?: string } | null)?.name ?? '?',
      finishId: p['finish_id'],
      finishName: (p['finishes'] as unknown as { name?: string } | null)?.name ?? '?',
      diameterMm: p['diameter_mm'],
      active: p['active'],
    }));
  }

  async updateFilamentProduct(id: string, input: CreateFilamentProductInput): Promise<void> {
    const { error } = await this.supabase.client
      .from('filament_products')
      .update({
        manufacturer: input.manufacturer,
        product_name: input.productName,
        material: input.material,
        color_id: input.colorId,
        finish_id: input.finishId,
        diameter_mm: input.diameterMm,
      })
      .eq('id', id);
    if (error) throw error;
  }

  async listManufacturerProductNamePairs(): Promise<{ manufacturer: string; productName: string }[]> {
    const { data, error } = await this.supabase.client.from('filament_products').select('manufacturer, product_name');
    if (error) throw error;
    return (data ?? []).map((p) => ({ manufacturer: p['manufacturer'], productName: p['product_name'] }));
  }

  async createSpool(input: CreateSpoolInput): Promise<string> {
    const { data, error } = await this.supabase.client
      .from('filament_spools')
      .insert({
        filament_product_id: input.filamentProductId,
        purchase_price: input.purchasePrice,
        initial_weight_g: input.initialWeightG,
        tare_weight_g: input.tareWeightG,
        purchase_date: input.purchaseDate,
        active: true,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data['id'];
  }

  async getSpool(id: string): Promise<SpoolDetail> {
    const { data, error } = await this.supabase.client
      .from('filament_spools')
      .select('id, filament_product_id, purchase_price, initial_weight_g, tare_weight_g, purchase_date')
      .eq('id', id)
      .single();
    if (error) throw error;
    return {
      id: data['id'],
      filamentProductId: data['filament_product_id'],
      purchasePrice: data['purchase_price'],
      initialWeightG: data['initial_weight_g'],
      tareWeightG: data['tare_weight_g'],
      purchaseDate: data['purchase_date'],
    };
  }

  async updateSpool(id: string, input: CreateSpoolInput): Promise<void> {
    const { error } = await this.supabase.client
      .from('filament_spools')
      .update({
        filament_product_id: input.filamentProductId,
        purchase_price: input.purchasePrice,
        initial_weight_g: input.initialWeightG,
        tare_weight_g: input.tareWeightG,
        purchase_date: input.purchaseDate,
      })
      .eq('id', id);
    if (error) throw error;
  }
}
