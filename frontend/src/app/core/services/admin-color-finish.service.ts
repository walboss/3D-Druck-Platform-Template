import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';

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

@Injectable({ providedIn: 'root' })
export class AdminColorFinishService {
  constructor(private readonly supabase: SupabaseClientService) {}

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
}
