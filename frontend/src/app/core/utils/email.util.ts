/**
 * Grobe Formatprüfung für E-Mail-Adressen (Review B13): genau ein @, kein
 * Leerzeichen, Punkt in der Domain. Leeres Feld gilt als „nicht angegeben“,
 * nicht als ungültig — ob es Pflicht ist, entscheidet das Formular.
 */
export function isEmailFormatValid(value: string): boolean {
  const v = value.trim();
  return v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}
