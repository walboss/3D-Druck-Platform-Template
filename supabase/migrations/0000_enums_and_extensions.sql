-- Migration 0000: Extensions + zentrale ENUM-Typen
-- Siehe specs/implementierungsplan-schritt9.md §1, §2

create extension if not exists pgcrypto;

create type order_status as enum (
  'New', 'Confirmed', 'InProduction', 'Finished', 'ReadyForPickup', 'HandedOver', 'Cancelled'
);

create type order_item_status as enum (
  'Offen', 'WartetAufMaterial', 'InProduktion', 'Fertig', 'Storniert'
);

create type production_order_status as enum (
  'Geplant', 'Laeuft', 'Abgeschlossen', 'Fehlgeschlagen'
);

create type reservation_status as enum (
  'aktiv', 'freigegeben', 'verbraucht'
);

create type fg_reservation_status as enum (
  'aktiv', 'freigegeben', 'verbraucht_bei_uebergabe'
);

create type license_status as enum (
  'aktiv', 'abgelaufen', 'widerrufen'
);

create type custom_request_status as enum (
  'neu', 'geprueft', 'angebot_erstellt', 'abgelehnt'
);

create type offer_status as enum (
  'offen', 'akzeptiert', 'abgelehnt', 'abgelaufen', 'widerrufen'
);

create type stock_type as enum (
  'normal', 'b_ware'
);

create type fg_movement_type as enum (
  'produktion_erfolgreich', 'uebergabe', 'korrektur', 'ausschuss_umbuchung', 'sonstige'
);

create type filament_movement_type as enum (
  'einkauf', 'produktion', 'fehldruck', 'korrektur', 'sonstige'
);

create type calc_scope_type as enum (
  'product_variant', 'offer_item'
);

create type calc_reason as enum (
  'kundenwunsch', 'admin_korrektur', 'falsche_variante', 'sonstiger_grund'
);

create type license_cost_type as enum (
  'kostenlos', 'pro_stueck', 'einmalig', 'wiederkehrend', 'sonstige'
);

create type complaint_decision as enum (
  'ersatzproduktion', 'rueckerstattung', 'sonstige'
);

create type order_source as enum (
  'catalog', 'custom_offer'
);
