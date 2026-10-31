/**
 * Calories and weight as the Food screens show and read them (v0.4 spec
 * 5.0, 5.5): kcal and kg through Intl.NumberFormat in the phone's locale,
 * a weight change with its sign, and the typed kcal and kg turned into the
 * numbers the daemon takes (whole kcal; kg with one decimal, 20 to 400).
 */
import { FoodTargetsBodySchema, WeightBodySchema, type WeightSummary } from '@jantar/protocol';

/** 1,240 */
export function kcalText(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

/** 72.4 */
export function kgText(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
}

/** -0.6, +1.2, 0.0 */
export function kgChange(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(n);
}

/** Whole kcal, 0 to 10,000; null when it is not one. */
export function parseKcal(text: string): number | null {
  const s = text.trim().replace(/[\s,]/g, '');
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n <= 10_000 ? n : null;
}

/** A weight in kg ("72.4" or "72,4"), rounded to one decimal; null outside 20 to 400. */
export function parseKg(text: string): number | null {
  const s = text.trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s) * 10) / 10;
  return WeightBodySchema.safeParse({ kg: n }).success ? n : null;
}

/** A daily calorie target the daemon takes (800 to 6,000). */
export function parseTarget(text: string): number | null {
  const n = parseKcal(text);
  return n !== null && FoodTargetsBodySchema.safeParse({ kcalTarget: n }).success ? n : null;
}

/** "72.4 kg · -0.6 in 7 days · -1.8 in 30 · goal 70.0", or null with no weight logged. */
export function weightLine(w: WeightSummary, locale?: string): string | null {
  if (!w.latest) return null;
  const parts = [`${kgText(w.latest.kg, locale)} kg`];
  if (w.change7 !== null) parts.push(`${kgChange(w.change7, locale)} in 7 days`);
  if (w.change30 !== null) parts.push(`${kgChange(w.change30, locale)} in 30`);
  if (w.goalKg !== null) parts.push(`goal ${kgText(w.goalKg, locale)}`);
  return parts.join(' · ');
}
