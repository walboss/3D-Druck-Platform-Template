import { ConfirmOrderResult } from '../services/admin-orders.service';
import { statusLabel } from './status-labels';

/**
 * Text für die Erfolgsmeldung nach „Bestätigen“ (Review C22): neuer
 * Bestellstatus plus Aufschlüsselung der Positionen, damit klar ist, warum
 * die Bestellung z. B. noch nicht „In Produktion“ ist. Nur Anzeige der
 * Rückgabe von fn_confirm_order, keine eigene Logik.
 */
export function confirmOrderSummary(result: ConfirmOrderResult): string {
  const status = result.order_status ? `Status: ${statusLabel(result.order_status)}.` : '';
  const counts = new Map<string, number>();
  for (const item of result.items ?? []) {
    if (item.status === 'Storniert') continue;
    const label = statusLabel(item.status) + (item.reserved ? ' (aus Lager)' : '');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = Array.from(counts, ([label, n]) => `${n}× ${label}`);
  const positions = parts.length > 0 ? `Positionen: ${parts.join(', ')}.` : '';
  return [status, positions].filter(Boolean).join(' ');
}
