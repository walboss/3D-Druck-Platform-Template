import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';

@Injectable({ providedIn: 'root' })
export class AdminIdentityService {
  constructor(private readonly supabase: SupabaseClientService) {}

  async getActor(): Promise<string> {
    const { data } = await this.supabase.client.auth.getSession();
    return data.session?.user.email ?? 'admin';
  }
}
