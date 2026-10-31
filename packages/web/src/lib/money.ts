/**
 * Money on the phone (v0.4 spec 1.1 and 5.0). Amounts travel as integer
 * hundredths of the currency unit, whatever the currency: ₹123.45 is 12345,
 * ¥1,234 is 123400, and a currency with three decimals (KWD) is rounded to
 * two. This file is the one place that turns hundredths into text and typed
 * text into hundredths, so no amount is ever a float on the wire.
 *
 * `currency` is the ISO 4217 code from LifeStatus or MoneyMonth; null means
 * none was set at the Mac, and amounts show as plain numbers with two
 * decimals. `locale` is for tests; the app passes none (the phone's own).
 */

/** The largest amount the daemon takes (AmountSchema), in hundredths. */
export const AMOUNT_MAX = 1e12;

/** How many decimals a currency shows here: its own, at most two (KWD's third is rounded away). */
export function currencyDigits(currency: string | null): number {
  if (!currency) return 2;
  try {
    const d = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return Math.min(2, d);
  } catch {
    return 2;
  }
}

function plain(hundredths: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(hundredths / 100);
}

/**
 * An amount for reading: "₹1,20,000", "₹123.45", "¥1,234", "$649". A whole
 * amount drops its zero decimals; with no currency it is a plain number
 * with two decimals ("1,240.00").
 */
export function formatAmount(hundredths: number, currency: string | null, locale?: string): string {
  if (!currency) return plain(hundredths, locale);
  const digits = hundredths % 100 === 0 ? 0 : currencyDigits(currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(hundredths / 100);
  } catch {
    return plain(hundredths, locale);
  }
}

/** The currency's symbol for beside an amount field ("₹", "$", "¥"), or null with no currency. */
export function currencySymbol(currency: string | null, locale?: string): string | null {
  if (!currency) return null;
  try {
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

/** An amount as an editable field value: digits and a "." ("649", "123.45", "1234"), no grouping. */
export function amountInput(hundredths: number, currency: string | null): string {
  if (currencyDigits(currency) === 0) return String(Math.round(hundredths / 100));
  const whole = Math.trunc(hundredths / 100);
  const cents = hundredths % 100;
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, '0')}`;
}

/**
 * What a typed amount may look like: a whole part, either bare digits or
 * grouped by commas (three digits after the last comma, two or three
 * between: "1,240", "1,240,000", "1,20,000"), then at most one "." and
 * the decimals.
 */
const AMOUNT_TEXT = /^(\d+|\d{1,3}(?:,\d{2,3})*,\d{3}|)(?:\.(\d*))?$/;

/**
 * Typed text to hundredths, or null when it is not an amount (or is zero,
 * or above AMOUNT_MAX). One rule on every phone, whatever its language: a
 * dot is the decimal point and commas only group thousands, so "1,240" is
 * 1240 and "1,240.50" is 1240.50. A comma anywhere else ("12,50", "0,50",
 * "1.240,50") is refused rather than guessed at, and the field says how to
 * type it (AMOUNT_HINT in the Finance sheets). Spaces, and the apostrophe
 * some keyboards group with, are ignored. Decimals past the currency's own
 * are rounded half up (¥ "1234.5" is 1235 yen; KWD "1.235" is 1.24).
 */
export function parseAmount(text: string, currency: string | null = null): number | null {
  const s = text.replace(/[\s\u00a0\u202f']/g, '');
  const m = AMOUNT_TEXT.exec(s);
  if (!m || !/[0-9]/.test(s)) return null;
  const frac = m[2] ?? '';
  const intPart = (m[1] ?? '').replace(/,/g, '').replace(/^0+(?=\d)/, '');
  if (intPart.length > 13) return null;
  const digits = currencyDigits(currency);
  const kept = frac.slice(0, digits).padEnd(digits, '0');
  const up = (frac[digits] ?? '0') >= '5' ? 1 : 0;
  const units = Number(intPart || '0') * 10 ** digits + Number(kept || '0') + up;
  const hundredths = units * 10 ** (2 - digits);
  if (!Number.isSafeInteger(hundredths) || hundredths < 1 || hundredths > AMOUNT_MAX) return null;
  return hundredths;
}
