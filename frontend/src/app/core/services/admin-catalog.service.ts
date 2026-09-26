import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { CalcReason, ProductImage } from '../models/db-types';

export interface AdminProductListRow {
  id: string;
  name: string;
  category: string | null;
  active: boolean;
  isMulticolor: boolean;
  // Spanne ueber alle Varianten (null falls keine Variante bzw. keine
  // Kalkulation vorhanden). priceFrom===priceTo -> Anzeige als Einzelwert.
  priceFrom: number | null;
  priceTo: number | null;
  printTimeMinFrom: number | null;
  printTimeMinTo: number | null;
}

export interface AdminProductDetail {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  images: ProductImage[];
  tags: string[];
  active: boolean;
  isMulticolor: boolean;
  // Spec 27 §3: Herkunft aus MakerWorld (Anzeige; gesetzt beim Import —
  // Sammelimport per fn_import_makerworld_product oder Link-Import im Editor).
  makerworldUrl?: string | null;
  makerworldTitle?: string | null;
  makerworldModelId?: string | null;
  // 00198: Platten-Nr., wenn nur eine Platte des Modells übernommen wurde
  makerworldPlateNo?: number | null;
}

export interface AdminVariant {
  id: string;
  sizeLabel: string;
  weightG: number;
  printTimeMin: number;
  workTimeMin: number;
  materialNeedG: number;
  minQty: number;
  maxQty: number;
  stepQty: number;
  active: boolean;
  finalPrice?: number | null;
}

export interface AdminProductPart {
  id: string;
  name: string;
  sortOrder: number;
}

export interface ColorMasterRow {
  id: string;
  name: string;
  hex: string | null;
  active: boolean;
}

export interface FinishMasterRow {
  id: string;
  name: string;
  active: boolean;
}

export interface CostComponents {
  filament_cost: number;
  energy_cost: number;
  machine_cost: number;
  labor_cost: number;
  packaging_cost: number;
  license_cost: number;
  scrap_allowance: number;
  other_cost: number;
}

export interface CurrentCalculationVersion {
  id: string;
  versionNo: number;
  costComponents: CostComponents;
  marginPercent: number;
  finalPrice: number;
}

@Injectable({ providedIn: 'root' })
export class AdminCatalogService {
  constructor(private readonly supabase: SupabaseClientService) {}

  async listProducts(): Promise<AdminProductListRow[]> {
    const { data, error } = await this.supabase.client
      .from('products')
      .select('id, name, category, active, is_multicolor')
      .order('name');
    if (error) throw error;
    const products = (data ?? []).map((p) => ({
      id: p['id'] as string,
      name: p['name'],
      category: p['category'],
      active: p['active'],
      isMulticolor: p['is_multicolor'],
      priceFrom: null as number | null,
      priceTo: null as number | null,
      printTimeMinFrom: null as number | null,
      printTimeMinTo: null as number | null,
    }));
    if (products.length === 0) return products;

    // Preis-/Laufzeitspanne je Produkt fuer die Gesamtuebersicht: alle
    // Varianten laden, aktuelle Kalkulation je Variante dazumischen (kein
    // FK zwischen product_variants und calculation_versions, s. listVariants),
    // dann pro product_id min/max bilden.
    const { data: variantRows, error: variantError } = await this.supabase.client
      .from('product_variants')
      .select('id, product_id, print_time_min')
      .in(
        'product_id',
        products.map((p) => p.id),
      );
    if (variantError) throw variantError;
    const variants = variantRows ?? [];
    if (variants.length === 0) return products;

    const { data: calcs, error: calcError } = await this.supabase.client
      .from('calculation_versions')
      .select('scope_id, final_price')
      .eq('scope_type', 'product_variant')
      .eq('is_current', true)
      .in(
        'scope_id',
        variants.map((v) => v['id']),
      );
    if (calcError) throw calcError;
    const priceByVariantId = new Map<string, number>((calcs ?? []).map((c) => [c['scope_id'], c['final_price']]));

    const rangesByProductId = new Map<
      string,
      { priceFrom: number | null; priceTo: number | null; timeFrom: number | null; timeTo: number | null }
    >();
    for (const v of variants) {
      const productId = v['product_id'] as string;
      const printTime = v['print_time_min'] as number | null;
      const price = priceByVariantId.get(v['id'] as string) ?? null;
      const range = rangesByProductId.get(productId) ?? {
        priceFrom: null,
        priceTo: null,
        timeFrom: null,
        timeTo: null,
      };
      if (price !== null) {
        range.priceFrom = range.priceFrom === null ? price : Math.min(range.priceFrom, price);
        range.priceTo = range.priceTo === null ? price : Math.max(range.priceTo, price);
      }
      if (printTime !== null) {
        range.timeFrom = range.timeFrom === null ? printTime : Math.min(range.timeFrom, printTime);
        range.timeTo = range.timeTo === null ? printTime : Math.max(range.timeTo, printTime);
      }
      rangesByProductId.set(productId, range);
    }

    return products.map((p) => {
      const range = rangesByProductId.get(p.id);
      if (!range) return p;
      return {
        ...p,
        priceFrom: range.priceFrom,
        priceTo: range.priceTo,
        printTimeMinFrom: range.timeFrom,
        printTimeMinTo: range.timeTo,
      };
    });
  }

  // Kategorie ist Freitext (products.category, keine eigene Tabelle):
  // Vorschlagsliste = alle bisher verwendeten Werte, dedupliziert.
  async listCategories(): Promise<string[]> {
    const { data, error } = await this.supabase.client
      .from('products')
      .select('category')
      .not('category', 'is', null);
    if (error) throw error;
    const seen = new Set<string>();
    for (const row of data ?? []) {
      const c = (row['category'] as string | null)?.trim();
      if (c) seen.add(c);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b, 'de'));
  }

  async getProduct(id: string): Promise<AdminProductDetail> {
    const { data, error } = await this.supabase.client.from('products').select('*').eq('id', id).single();
    if (error) throw error;
    return {
      id: data['id'],
      name: data['name'],
      description: data['description'],
      category: data['category'],
      images: (data['images'] ?? []) as ProductImage[],
      tags: data['tags'] ?? [],
      active: data['active'],
      isMulticolor: data['is_multicolor'],
      makerworldUrl: data['makerworld_url'] ?? null,
      makerworldTitle: data['makerworld_title'] ?? null,
    };
  }

  async createProduct(input: Omit<AdminProductDetail, 'id'>): Promise<string> {
    const { data, error } = await this.supabase.client
      .from('products')
      .insert({
        name: input.name,
        description: input.description,
        category: input.category,
        images: input.images,
        tags: input.tags,
        active: input.active,
        is_multicolor: input.isMulticolor,
        makerworld_url: input.makerworldUrl ?? null,
        makerworld_title: input.makerworldTitle ?? null,
        makerworld_model_id: input.makerworldModelId ?? null,
        makerworld_plate_no: input.makerworldPlateNo ?? null,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data['id'];
  }

  async updateProduct(id: string, input: Omit<AdminProductDetail, 'id'>): Promise<void> {
    const { error } = await this.supabase.client
      .from('products')
      .update({
        name: input.name,
        description: input.description,
        category: input.category,
        images: input.images,
        tags: input.tags,
        active: input.active,
        is_multicolor: input.isMulticolor,
      })
      .eq('id', id);
    if (error) throw error;
  }

  // Mehrfachauswahl in der Katalogpflege: eine Kategorie für mehrere
  // Produkte setzen (null = Kategorie entfernen).
  async setCategoryForProducts(ids: string[], category: string | null): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.supabase.client
      .from('products')
      .update({ category, updated_at: new Date().toISOString() })
      .in('id', ids);
    if (error) throw error;
  }

  async setProductActive(id: string, active: boolean): Promise<void> {
    const { error } = await this.supabase.client.from('products').update({ active }).eq('id', id);
    if (error) throw error;
  }

  async listVariants(productId: string): Promise<AdminVariant[]> {
    const { data, error } = await this.supabase.client
      .from('product_variants')
      .select('id, size_label, weight_g, print_time_min, work_time_min, material_need_g, min_qty, max_qty, step_qty, active')
      .eq('product_id', productId)
      .order('size_label');
    if (error) throw error;
    const variants = (data ?? []).map((v) => ({
      id: v['id'] as string,
      sizeLabel: v['size_label'],
      weightG: v['weight_g'],
      printTimeMin: v['print_time_min'],
      workTimeMin: v['work_time_min'],
      materialNeedG: v['material_need_g'],
      minQty: v['min_qty'],
      maxQty: v['max_qty'],
      stepQty: v['step_qty'],
      active: v['active'],
      finalPrice: null as number | null,
    }));
    if (variants.length === 0) return variants;

    // Aktueller Preis je Variante fuer die Uebersicht (kalkulation.md §2:
    // is_current nur fuer scope_type='product_variant'). Kein FK zwischen
    // product_variants und calculation_versions (polymorpher scope_id) --
    // separater Lookup statt Embedded-Select.
    const { data: calcs, error: calcError } = await this.supabase.client
      .from('calculation_versions')
      .select('scope_id, final_price')
      .eq('scope_type', 'product_variant')
      .eq('is_current', true)
      .in(
        'scope_id',
        variants.map((v) => v.id),
      );
    if (calcError) throw calcError;
    const priceByVariantId = new Map<string, number>((calcs ?? []).map((c) => [c['scope_id'], c['final_price']]));
    return variants.map((v) => ({ ...v, finalPrice: priceByVariantId.get(v.id) ?? null }));
  }

  async createVariant(productId: string, variant: Omit<AdminVariant, 'id'>): Promise<string> {
    const { data, error } = await this.supabase.client
      .from('product_variants')
      .insert({
        product_id: productId,
        size_label: variant.sizeLabel,
        weight_g: variant.weightG,
        print_time_min: variant.printTimeMin,
        work_time_min: variant.workTimeMin,
        material_need_g: variant.materialNeedG,
        min_qty: variant.minQty,
        max_qty: variant.maxQty,
        step_qty: variant.stepQty,
        active: variant.active,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data['id'];
  }

  async updateVariant(id: string, variant: Omit<AdminVariant, 'id'>): Promise<void> {
    const { error } = await this.supabase.client
      .from('product_variants')
      .update({
        size_label: variant.sizeLabel,
        weight_g: variant.weightG,
        print_time_min: variant.printTimeMin,
        work_time_min: variant.workTimeMin,
        material_need_g: variant.materialNeedG,
        min_qty: variant.minQty,
        max_qty: variant.maxQty,
        step_qty: variant.stepQty,
        active: variant.active,
      })
      .eq('id', id);
    if (error) throw error;
  }

  async listProductParts(productId: string): Promise<AdminProductPart[]> {
    const { data, error } = await this.supabase.client
      .from('product_parts')
      .select('id, name, sort_order')
      .eq('product_id', productId)
      .order('sort_order');
    if (error) throw error;
    return (data ?? []).map((p) => ({ id: p['id'], name: p['name'], sortOrder: p['sort_order'] }));
  }

  async createProductPart(productId: string, name: string, sortOrder: number): Promise<string> {
    const { data, error } = await this.supabase.client
      .from('product_parts')
      .insert({ product_id: productId, name, sort_order: sortOrder })
      .select('id')
      .single();
    if (error) throw error;
    return data['id'];
  }

  // 00198: Gewicht/Druckzeit je Farbteil einer Variante (variant_parts)
  async createVariantPart(variantId: string, partId: string, weightG: number, printTimeMin: number): Promise<void> {
    const { error } = await this.supabase.client.from('variant_parts').insert({
      variant_id: variantId,
      product_part_id: partId,
      weight_g: weightG,
      print_time_min: printTimeMin,
      material_need_g: weightG,
    });
    if (error) throw error;
  }

  // --- Stammdaten Farben/Finishes (specs/21): Liste inkl. inaktiver, Anlegen,
  // Aktiv-Toggle über bestehendes active-Flag. Kein Löschen (Prinzip #2).
  async listColorsMaster(): Promise<ColorMasterRow[]> {
    const { data, error } = await this.supabase.client
      .from('colors')
      .select('id, name, hex, active')
      .order('name');
    if (error) throw error;
    return (data ?? []).map((c) => ({ id: c['id'], name: c['name'], hex: c['hex'], active: c['active'] }));
  }

  async listFinishesMaster(): Promise<FinishMasterRow[]> {
    const { data, error } = await this.supabase.client
      .from('finishes')
      .select('id, name, active')
      .order('name');
    if (error) throw error;
    return (data ?? []).map((f) => ({ id: f['id'], name: f['name'], active: f['active'] }));
  }

  async createColor(name: string, hex: string | null): Promise<void> {
    const { error } = await this.supabase.client.from('colors').insert({ name, hex, active: true });
    if (error) throw error;
  }

  async updateColor(id: string, name: string, hex: string | null): Promise<void> {
    const { error } = await this.supabase.client.from('colors').update({ name, hex }).eq('id', id);
    if (error) throw error;
  }

  async createFinish(name: string): Promise<void> {
    const { error } = await this.supabase.client.from('finishes').insert({ name, active: true });
    if (error) throw error;
  }

  async setColorActive(id: string, active: boolean): Promise<void> {
    const { error } = await this.supabase.client.from('colors').update({ active }).eq('id', id);
    if (error) throw error;
  }

  async setFinishActive(id: string, active: boolean): Promise<void> {
    const { error } = await this.supabase.client.from('finishes').update({ active }).eq('id', id);
    if (error) throw error;
  }

  async getAllColors(): Promise<{ id: string; name: string; hex: string | null }[]> {
    const { data, error } = await this.supabase.client.from('colors').select('id, name, hex').eq('active', true);
    if (error) throw error;
    return data ?? [];
  }

  async getAllFinishes(): Promise<{ id: string; name: string }[]> {
    const { data, error } = await this.supabase.client.from('finishes').select('id, name').eq('active', true);
    if (error) throw error;
    return data ?? [];
  }

  async getCurrentCalculationVersion(variantId: string): Promise<CurrentCalculationVersion | null> {
    const { data, error } = await this.supabase.client
      .from('calculation_versions')
      .select(
        'id, version_no, filament_cost, energy_cost, machine_cost, labor_cost, packaging_cost, license_cost, scrap_allowance, other_cost, margin_percent, final_price',
      )
      .eq('scope_type', 'product_variant')
      .eq('scope_id', variantId)
      .eq('is_current', true)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: data['id'],
      versionNo: data['version_no'],
      costComponents: {
        filament_cost: data['filament_cost'],
        energy_cost: data['energy_cost'],
        machine_cost: data['machine_cost'],
        labor_cost: data['labor_cost'],
        packaging_cost: data['packaging_cost'],
        license_cost: data['license_cost'],
        scrap_allowance: data['scrap_allowance'],
        other_cost: data['other_cost'],
      },
      marginPercent: data['margin_percent'],
      finalPrice: data['final_price'],
    };
  }

  async createCalculationVersion(
    variantId: string,
    costComponents: CostComponents,
    marginPercent: number,
    reason: CalcReason,
  ): Promise<string> {
    const { data: sessionData } = await this.supabase.client.auth.getSession();
    const createdBy = sessionData.session?.user.email ?? 'admin';

    const { data, error } = await this.supabase.client.rpc('fn_create_calculation_version', {
      p_scope_type: 'product_variant',
      p_scope_id: variantId,
      p_cost_components: costComponents,
      p_margin_percent: marginPercent,
      p_reason: reason,
      p_created_by: createdBy,
    });
    if (error) throw error;
    return data as string;
  }
}
