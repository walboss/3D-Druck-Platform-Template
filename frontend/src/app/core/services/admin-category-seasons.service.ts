import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { CategorySeason } from '../utils/season.util';

export type CategorySeasonInput = Omit<CategorySeason, 'id' | 'active'>;

// Saison-Kategorien (Migration 00187). Kein Löschen, nur deaktivieren.
@Injectable({ providedIn: 'root' })
export class AdminCategorySeasonsService {
  constructor(private readonly supabase: SupabaseClientService) {}

  async list(): Promise<CategorySeason[]> {
    const { data, error } = await this.supabase.client
      .from('category_seasons')
      .select('id, category, start_month, start_day, end_month, end_day, active, banner_title, banner_text')
      .order('start_month')
      .order('start_day');
    if (error) throw error;
    return (data ?? []) as CategorySeason[];
  }

  async create(input: CategorySeasonInput): Promise<void> {
    const { error } = await this.supabase.client.from('category_seasons').insert({ ...input, active: true });
    if (error) throw error;
  }

  async update(id: string, input: CategorySeasonInput): Promise<void> {
    const { error } = await this.supabase.client
      .from('category_seasons')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  async setActive(id: string, active: boolean): Promise<void> {
    const { error } = await this.supabase.client
      .from('category_seasons')
      .update({ active, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }
}
