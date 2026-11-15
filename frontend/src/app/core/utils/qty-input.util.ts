/**
 * Mengen-Eingabe aus einem Zahlenfeld prüfen, bevor sie an die DB geht.
 * Leeres Feld (null), keine Zahl, Bruchzahl oder Werte < 1 sind keine
 * gültige Menge -- dann null (nichts senden, alte Menge wieder anzeigen).
 * Entfernen läuft bewusst nur über den Papierkorb, nicht über Menge 0.
 */
export function parseQtyInput(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}
