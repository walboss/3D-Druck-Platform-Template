/**
 * Summe für Warenkorb/Kasse (Spec 17 §2, Entscheidung 2026-11-14, Review A2):
 * Positionen ohne Preis zählen NICHT als 0 € mit, sondern werden gezählt und
 * als Hinweis angezeigt („Zwischensumme“ + „+ N Position(en) …“).
 */
export interface PriceSummary {
  /** Summe aller Positionen MIT Preis */
  total: number;
  /** Anzahl Positionen ohne Preis */
  unpricedCount: number;
}

export function priceSummary(rows: { finalPrice: number | null; qty: number }[]): PriceSummary {
  let total = 0;
  let unpricedCount = 0;
  for (const row of rows) {
    if (row.finalPrice === null) unpricedCount++;
    else total += row.finalPrice * row.qty;
  }
  return { total, unpricedCount };
}

export function unpricedHint(count: number): string {
  return count === 1
    ? '+ 1 Position, deren Preis wir dir noch mitteilen'
    : `+ ${count} Positionen, deren Preis wir dir noch mitteilen`;
}
