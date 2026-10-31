// @vitest-environment node
/**
 * lib/money.ts (v0.4 spec 1.1, 5.0, WP-W's done-when): amounts are integer
 * hundredths whatever the currency; typed text is digits with a dot for
 * the decimals and commas only for thousands (a comma anywhere else is
 * refused, never guessed at); INR, USD, JPY and KWD (rounded to
 * hundredths) and plain numbers with no currency round-trip through the
 * field and back. Locales are passed explicitly so the test reads the same
 * on any machine.
 */
import { describe, expect, it } from 'vitest';
import { AMOUNT_MAX, amountInput, currencyDigits, currencySymbol, formatAmount, parseAmount } from '../src/lib/money.js';

describe('formatAmount', () => {
  it('formats hundredths in the currency, dropping zero decimals on a whole amount', () => {
    expect(formatAmount(12_000_000, 'INR', 'en-IN')).toBe('₹1,20,000');
    expect(formatAmount(12_345, 'INR', 'en-IN')).toBe('₹123.45');
    expect(formatAmount(64_900, 'USD', 'en-US')).toBe('$649');
    expect(formatAmount(64_950, 'USD', 'en-US')).toBe('$649.50');
    expect(formatAmount(123_400, 'JPY', 'en-US')).toBe('¥1,234');
    // Intl puts a no-break space after a currency code.
    expect(formatAmount(123, 'KWD', 'en-US')).toMatch(/^KWD\s1\.23$/);
  });

  it('is a plain number with two decimals when no currency is set', () => {
    expect(formatAmount(124_000, null, 'en-US')).toBe('1,240.00');
    expect(formatAmount(5, null, 'en-US')).toBe('0.05');
  });
});

describe('currencyDigits and currencySymbol', () => {
  it('keeps a currency own decimals, at most two', () => {
    expect(currencyDigits('INR')).toBe(2);
    expect(currencyDigits('USD')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('KWD')).toBe(2);
    expect(currencyDigits(null)).toBe(2);
  });

  it('gives the symbol beside an amount field, or nothing without a currency', () => {
    expect(currencySymbol('INR', 'en-IN')).toBe('₹');
    expect(currencySymbol('EUR', 'en-US')).toBe('€');
    expect(currencySymbol(null)).toBeNull();
  });
});

describe('parseAmount', () => {
  it('reads digits with a dot for the decimals into hundredths', () => {
    expect(parseAmount('1240')).toBe(124_000);
    expect(parseAmount('1240.5')).toBe(124_050);
    expect(parseAmount('1240.')).toBe(124_000);
    expect(parseAmount('.5')).toBe(50);
    expect(parseAmount(' 649 ')).toBe(64_900);
    expect(parseAmount('1 240.50')).toBe(124_050);
  });

  it('reads commas as thousands separators only: "1,240" is 1240', () => {
    expect(parseAmount('1,240')).toBe(124_000);
    expect(parseAmount('1,240.50')).toBe(124_050);
    expect(parseAmount('12,345,678')).toBe(1_234_567_800);
    expect(parseAmount('1,20,000')).toBe(12_000_000);
    expect(parseAmount('12,34,567.89')).toBe(123_456_789);
  });

  it('refuses a comma that cannot be a thousands separator, rather than guess', () => {
    for (const bad of ['1240,50', '0,50', '12,5', '1,2345', ',500', '1,240,', '1.240,50', '12.345.678', '1,240.5,0']) expect(parseAmount(bad), bad).toBeNull();
  });

  it('refuses what is not an amount, zero, and anything past the cap', () => {
    for (const bad of ['', ' ', 'abc', '-5', '₹100', '1e3', '0', '0.00', '1.2,3,4', '1.5.0,2,1']) expect(parseAmount(bad), bad).toBeNull();
    expect(parseAmount('10000000000')).toBe(AMOUNT_MAX);
    expect(parseAmount('10000000000.01')).toBeNull();
  });

  it('rounds decimals past the currency own, half up', () => {
    expect(parseAmount('1234.5', 'JPY')).toBe(123_500);
    expect(parseAmount('1234.4', 'JPY')).toBe(123_400);
    expect(parseAmount('1.235', 'KWD')).toBe(124);
    expect(parseAmount('1.234', 'KWD')).toBe(123);
    expect(parseAmount('0.004', 'USD')).toBeNull();
  });
});

describe('round trips through the field', () => {
  const cases: [string | null, number[]][] = [
    ['INR', [1, 50, 64_900, 12_345, 12_000_000, AMOUNT_MAX]],
    ['USD', [99, 64_950, 100]],
    ['JPY', [100, 123_400, 99_900]],
    ['KWD', [123, 100, 5_005]],
    [null, [1, 124_000, 12_345]],
  ];
  for (const [currency, amounts] of cases) {
    it(`${currency ?? 'no currency'}: amountInput then parseAmount gives the same hundredths`, () => {
      for (const h of amounts) expect(parseAmount(amountInput(h, currency), currency), String(h)).toBe(h);
    });
  }

  it('writes the field without grouping or a trailing .00', () => {
    expect(amountInput(64_900, 'INR')).toBe('649');
    expect(amountInput(12_345, 'INR')).toBe('123.45');
    expect(amountInput(64_950, 'USD')).toBe('649.50');
    expect(amountInput(123_400, 'JPY')).toBe('1234');
    expect(amountInput(12_000_000, null)).toBe('120000');
  });
});
