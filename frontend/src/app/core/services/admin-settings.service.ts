import { Injectable } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { AdminIdentityService } from './admin-identity.service';

export interface SettingsData {
  id: string;
  emailSystemEnabled: boolean;
  emailRequiredAtOrder: boolean;
  electricityPricePerKwh: number;
  defaultLaborRatePerHour: number;
  minOrderValue: number | null;
  customerDataRetentionDays: number;
  storefrontPricesVisible: boolean;
  storefrontShopEnabled: boolean;
  storefrontCustomRequestEnabled: boolean;
  storefrontSeasonsEnabled: boolean;
}

@Injectable({ providedIn: 'root' })
export class AdminSettingsService {
  constructor(private readonly supabase: SupabaseClientService, private readonly identity: AdminIdentityService) {}

  async getSettings(): Promise<SettingsData> {
    const { data, error } = await this.supabase.client.from('settings').select('*').single();
    if (error) throw error;
    return {
      id: data['id'],
      emailSystemEnabled: data['email_system_enabled'],
      emailRequiredAtOrder: data['email_required_at_order'],
      electricityPricePerKwh: data['electricity_price_per_kwh'],
      defaultLaborRatePerHour: data['default_labor_rate_per_hour'],
      minOrderValue: data['min_order_value'],
      customerDataRetentionDays: data['customer_data_retention_days'],
      storefrontPricesVisible: data['storefront_prices_visible'],
      storefrontShopEnabled: data['storefront_shop_enabled'],
      storefrontCustomRequestEnabled: data['storefront_custom_request_enabled'],
      storefrontSeasonsEnabled: data['storefront_seasons_enabled'],
    };
  }

  async updateSettings(previous: SettingsData, next: Omit<SettingsData, 'id'>): Promise<void> {
    const { error } = await this.supabase.client
      .from('settings')
      .update({
        email_system_enabled: next.emailSystemEnabled,
        email_required_at_order: next.emailRequiredAtOrder,
        electricity_price_per_kwh: next.electricityPricePerKwh,
        default_labor_rate_per_hour: next.defaultLaborRatePerHour,
        min_order_value: next.minOrderValue,
        customer_data_retention_days: next.customerDataRetentionDays,
        storefront_prices_visible: next.storefrontPricesVisible,
        storefront_shop_enabled: next.storefrontShopEnabled,
        storefront_custom_request_enabled: next.storefrontCustomRequestEnabled,
        storefront_seasons_enabled: next.storefrontSeasonsEnabled,
      })
      .eq('id', previous.id);
    if (error) throw error;

    const actor = await this.identity.getActor();
    const fieldChanges: [string, unknown, unknown][] = [
      ['email_system_enabled', previous.emailSystemEnabled, next.emailSystemEnabled],
      ['email_required_at_order', previous.emailRequiredAtOrder, next.emailRequiredAtOrder],
      ['electricity_price_per_kwh', previous.electricityPricePerKwh, next.electricityPricePerKwh],
      ['default_labor_rate_per_hour', previous.defaultLaborRatePerHour, next.defaultLaborRatePerHour],
      ['min_order_value', previous.minOrderValue, next.minOrderValue],
      ['customer_data_retention_days', previous.customerDataRetentionDays, next.customerDataRetentionDays],
      ['storefront_prices_visible', previous.storefrontPricesVisible, next.storefrontPricesVisible],
      ['storefront_shop_enabled', previous.storefrontShopEnabled, next.storefrontShopEnabled],
      [
        'storefront_custom_request_enabled',
        previous.storefrontCustomRequestEnabled,
        next.storefrontCustomRequestEnabled,
      ],
      ['storefront_seasons_enabled', previous.storefrontSeasonsEnabled, next.storefrontSeasonsEnabled],
    ];

    for (const [field, oldValue, newValue] of fieldChanges) {
      if (oldValue !== newValue) {
        await this.supabase.client.rpc('fn_write_audit', {
          p_entity_type: 'settings',
          p_entity_id: previous.id,
          p_action: 'update',
          p_field_name: field,
          p_old_value: oldValue === null ? null : String(oldValue),
          p_new_value: newValue === null ? null : String(newValue),
          p_reason: null,
          p_actor: actor,
        });
      }
    }
  }
}
