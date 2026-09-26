// Baut aus dem in cart_items.configuration_draft gespeicherten JSON
// (siehe product-detail.ts addToCart()) einen lesbaren Text fuer
// Warenkorb/Wunschliste/Checkout, z. B. "Schwarz / Glänzend" oder bei
// mehrfarbigen Produkten "Kopf: Rot / Matt, Sockel: Weiß / Glänzend".

export interface CartConfigurationEntry {
  product_part_id: string | null;
  color_id: string;
  finish_id: string;
}

export function parseConfigurationDraft(raw: unknown): CartConfigurationEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is CartConfigurationEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as Record<string, unknown>)['color_id'] === 'string' &&
      typeof (e as Record<string, unknown>)['finish_id'] === 'string',
  );
}

export function formatConfigurationLabel(
  entries: CartConfigurationEntry[],
  colorNameById: Map<string, string>,
  finishNameById: Map<string, string>,
  partNameById: Map<string, string>,
): string {
  if (entries.length === 0) return '';
  return entries
    .map((entry) => {
      const color = colorNameById.get(entry.color_id) ?? entry.color_id;
      const finish = finishNameById.get(entry.finish_id) ?? entry.finish_id;
      const colorFinish = [color, finish].filter(Boolean).join(' / ');
      const part = entry.product_part_id ? partNameById.get(entry.product_part_id) : null;
      return part ? `${part}: ${colorFinish}` : colorFinish;
    })
    .join(', ');
}
