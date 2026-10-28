/**
 * All money in the system is stored as integer cents of South African rand (ZAR).
 * Never store or add floating point rand values.
 */
export type Cents = number;

export const CURRENCY = 'ZAR';

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertCents(value: unknown, field: string, opts: { min?: number; max?: number } = {}): Cents {
  const min = opts.min ?? 0;
  const max = opts.max ?? 100_000_000; // R1,000,000 hard ceiling per value
  if (!isCents(value) || value < min || value > max) {
    throw new RangeError(`${field} must be a whole number of cents between ${min} and ${max}`);
  }
  return value;
}

/** Parses user input such as "45", "45.5", "45,50" or "R 45.50" into cents. Returns null if invalid. */
export function parseRandToCents(input: string | number | null | undefined): Cents | null {
  if (input === null || input === undefined) return null;
  const text = String(input).replace(/[R\s ]/gi, '').replace(',', '.');
  if (!/^\d{1,7}(\.\d{0,2})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

const zarFormat = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: CURRENCY });

export function formatZar(cents: Cents): string {
  return zarFormat.format((cents || 0) / 100); // `|| 0` turns -0 into 0 so it never shows "-R 0,00"
}

export function centsToRandString(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
