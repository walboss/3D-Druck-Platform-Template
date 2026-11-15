import { Injectable, signal } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';

export interface StockColor {
  id: string;
  name: string;
  hex: string | null;
}

export interface StockFinish {
  id: string;
  name: string;
}

/**
 * Farben/Finishes, zu denen gerade tatsächlich Filament-Bestand vorhanden ist
 * (fn_get_public_stock_options, Migration 00171) — nicht die komplette
 * Farben-Stammdaten-Liste. Global, produktunabhängig, einmal pro Session
 * geladen wie PricingService.
 */
@Injectable({ providedIn: 'root' })
export class StockOptionsService {
  readonly colors = signal<StockColor[]>([]);
  readonly finishes = signal<StockFinish[]>([]);
  private pairs: { colorId: string; finishId: string }[] = [];
  /** true, wenn der letzte Ladeversuch gescheitert ist -- load() versucht es dann erneut. */
  readonly loadFailed = signal(false);
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(private readonly supabase: SupabaseClientService) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.fetch().finally(() => {
        // Gescheitert: Promise verwerfen, damit der nächste load() neu versucht.
        if (!this.loaded) this.loadPromise = null;
      });
    }
    await this.loadPromise;
  }

  finishesForColor(colorId: string): StockFinish[] {
    const finishIds = new Set(this.pairs.filter((p) => p.colorId === colorId).map((p) => p.finishId));
    return this.finishes().filter((f) => finishIds.has(f.id));
  }

  private async fetch(): Promise<void> {
    try {
      const { data, error } = await this.supabase.client.rpc('fn_get_public_stock_options');
      if (!error && data) {
        this.colors.set((data['colors'] ?? []) as StockColor[]);
        this.finishes.set((data['finishes'] ?? []) as StockFinish[]);
        this.pairs = ((data['colorFinishPairs'] ?? []) as { color_id: string; finish_id: string }[]).map((p) => ({
          colorId: p.color_id,
          finishId: p.finish_id,
        }));
        this.loaded = true;
      }
    } catch {
      // Netzwerkfehler -- wie Fehlerantwort behandeln.
    }
    this.loadFailed.set(!this.loaded);
  }
}
