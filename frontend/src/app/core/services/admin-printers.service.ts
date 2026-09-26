import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';

export interface PrinterRow {
  id: string;
  name: string;
  model: string;
  power_consumption_w: number;
  machine_hour_rate: number;
  active: boolean;
  is_default: boolean;
}

export type PrinterInput = Pick<PrinterRow, 'name' | 'model' | 'power_consumption_w' | 'machine_hour_rate'>;

// Druckerverwaltung (Migration 00186). Kein Löschen, nur deaktivieren.
@Injectable({ providedIn: 'root' })
export class AdminPrintersService {
  constructor(private readonly supabase: SupabaseClientService) {}

  async listPrinters(): Promise<PrinterRow[]> {
    const { data, error } = await this.supabase.client
      .from('printers')
      .select('id, name, model, power_consumption_w, machine_hour_rate, active, is_default')
      .order('is_default', { ascending: false })
      .order('name');
    if (error) throw error;
    return (data ?? []) as PrinterRow[];
  }

  async createPrinter(input: PrinterInput): Promise<void> {
    const { error } = await this.supabase.client.from('printers').insert({ ...input, active: true });
    if (error) throw error;
  }

  async updatePrinter(id: string, input: PrinterInput): Promise<void> {
    const { error } = await this.supabase.client
      .from('printers')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  async setPrinterActive(id: string, active: boolean): Promise<void> {
    const { error } = await this.supabase.client
      .from('printers')
      .update({ active, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  async setDefaultPrinter(id: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('fn_set_default_printer', { p_printer_id: id });
    if (error) throw error;
  }
}
