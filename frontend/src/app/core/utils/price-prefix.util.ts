/**
 * „ab“ vor dem Preis nur, wenn die Varianten wirklich verschiedene Preise
 * haben (Review B20) — nicht schon bei mehreren Varianten mit gleichem Preis.
 */
export function hasDifferentPrices(variants: { final_price: number | null }[]): boolean {
  const prices = new Set(variants.map((v) => v.final_price).filter((p): p is number => p !== null));
  return prices.size > 1;
}
