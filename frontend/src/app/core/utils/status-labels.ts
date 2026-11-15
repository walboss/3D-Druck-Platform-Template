import { Pipe, PipeTransform } from '@angular/core';

import {
  ComplaintDecision,
  CustomRequestStatus,
  OfferStatus,
  OrderItemStatus,
  OrderStatus,
  ProductionOrderStatus,
} from '../models/db-types';

/**
 * Zentrale deutsche Anzeige-Beschriftungen für alle Status-Enums (Review
 * C21/F3) — für Admin und Shop. Nur Anzeige: die gespeicherten Werte
 * bleiben unverändert. Bestellstatus-Texte wie bisher in der Shop-
 * Sendungsverfolgung (neutral, privatmodus-tauglich).
 */
const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  New: 'Eingegangen',
  Confirmed: 'Bestätigt',
  InProduction: 'In Produktion',
  Finished: 'Fertig',
  ReadyForPickup: 'Bereit zur Abholung',
  HandedOver: 'Abgeholt',
  Cancelled: 'Storniert',
};

const ORDER_ITEM_STATUS_LABELS: Record<OrderItemStatus, string> = {
  Offen: 'Offen',
  WartetAufMaterial: 'Wartet auf Material',
  InProduktion: 'In Produktion',
  Fertig: 'Fertig',
  Storniert: 'Storniert',
};

const PRODUCTION_ORDER_STATUS_LABELS: Record<ProductionOrderStatus, string> = {
  Geplant: 'Geplant',
  Laeuft: 'Läuft',
  Abgeschlossen: 'Abgeschlossen',
  Fehlgeschlagen: 'Fehlgeschlagen',
};

const CUSTOM_REQUEST_STATUS_LABELS: Record<CustomRequestStatus, string> = {
  neu: 'Neu',
  geprueft: 'Geprüft',
  angebot_erstellt: 'Angebot erstellt',
  abgelehnt: 'Abgelehnt',
};

const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  offen: 'Offen',
  akzeptiert: 'Akzeptiert',
  abgelehnt: 'Abgelehnt',
  abgelaufen: 'Abgelaufen',
  widerrufen: 'Widerrufen',
};

const COMPLAINT_DECISION_LABELS: Record<ComplaintDecision, string> = {
  ersatzproduktion: 'Ersatzproduktion',
  rueckerstattung: 'Rückerstattung',
  sonstige: 'Sonstige',
};

// Die Enum-Werte überschneiden sich nur dort, wo die Beschriftung gleich ist
// ('abgelehnt', 'Offen'/'offen'), daher reicht eine flache Tabelle.
const ALL_LABELS: Record<string, string> = {
  ...ORDER_STATUS_LABELS,
  ...ORDER_ITEM_STATUS_LABELS,
  ...PRODUCTION_ORDER_STATUS_LABELS,
  ...CUSTOM_REQUEST_STATUS_LABELS,
  ...OFFER_STATUS_LABELS,
  ...COMPLAINT_DECISION_LABELS,
};

/** Deutsche Beschriftung eines Status-/Entscheidungswerts; Unbekanntes bleibt unverändert. */
export function statusLabel(value: string | null | undefined): string {
  if (!value) return '';
  return ALL_LABELS[value] ?? value;
}

@Pipe({ name: 'statusLabel', standalone: true })
export class StatusLabelPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return statusLabel(value);
  }
}
