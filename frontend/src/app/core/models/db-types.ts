// Enum-Typen exakt wie in supabase/migrations/0000_enums_and_extensions.sql definiert.

export type OrderStatus =
  | 'New'
  | 'Confirmed'
  | 'InProduction'
  | 'Finished'
  | 'ReadyForPickup'
  | 'HandedOver'
  | 'Cancelled';

export type OrderItemStatus = 'Offen' | 'WartetAufMaterial' | 'InProduktion' | 'Fertig' | 'Storniert';

export type ProductionOrderStatus = 'Geplant' | 'Laeuft' | 'Abgeschlossen' | 'Fehlgeschlagen';

export type CustomRequestStatus = 'neu' | 'geprueft' | 'angebot_erstellt' | 'abgelehnt';

export type OfferStatus = 'offen' | 'akzeptiert' | 'abgelehnt' | 'abgelaufen' | 'widerrufen';

export type FilamentMovementType = 'einkauf' | 'produktion' | 'fehldruck' | 'korrektur' | 'sonstige';

export type CalcReason = 'kundenwunsch' | 'admin_korrektur' | 'falsche_variante' | 'sonstiger_grund';

export type ComplaintDecision = 'ersatzproduktion' | 'rueckerstattung' | 'sonstige';

export interface ProductImage {
  url: string;
  source_type: 'extern_link' | 'eigenes_hosting';
}

export interface VCatalogRow {
  product_id: string;
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  images: ProductImage[];
  variant_id: string;
  size_label: string;
  min_qty: number;
  max_qty: number;
  step_qty: number;
  final_price: number | null;
}

export interface CatalogProduct {
  product_id: string;
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  images: ProductImage[];
  created_at?: string;
  variants: VCatalogRow[];
  minPrice: number | null;
  hasMultiplePrices: boolean;
  // Like-System (specs/like-system.md), unabhängig von Privatmodus/Preisen.
  likesCount: number;
  likedByMe: boolean;
}

export interface Color {
  id: string;
  name: string;
  hex: string | null;
  active: boolean;
}

export interface Finish {
  id: string;
  name: string;
  active: boolean;
}

export interface ProductPart {
  id: string;
  product_id: string;
  name: string;
  sort_order: number;
}

export interface OrderTrackingItem {
  description: string;
  qty: number;
  status: OrderItemStatus;
  final_price: number | null;
}

export interface OrderTrackingResult {
  order_number: string;
  status: OrderStatus;
  confirmed_at: string | null;
  finished_at: string | null;
  ready_for_pickup_at: string | null;
  handed_over_at: string | null;
  items: OrderTrackingItem[];
}

export interface OfferViewItem {
  desired_variant_description: string;
  qty: number;
  final_price: number;
}

export interface OfferViewResult {
  valid_from: string;
  valid_until: string;
  items: OfferViewItem[];
}
