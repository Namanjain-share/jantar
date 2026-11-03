/**
 * v0.13: text as a search compares it. Lower case, compatibility forms
 * folded and accents dropped, so "cafe" finds "Café" and "ACME" finds
 * "Acme". Used on both sides of a substring match, in the daemon only
 * (the phone's query never reaches SQL).
 */
export function foldText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Whether any of `fields` holds `folded` (already foldText'ed). */
export function holdsFolded(folded: string, ...fields: readonly unknown[]): boolean {
  return fields.some((f) => typeof f === 'string' && foldText(f).includes(folded));
}
