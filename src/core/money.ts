/**
 * Money is stored as an integer number of cents and only converted to decimal
 * dollars at the output boundary (see views.ts).
 *
 * Plaid sends decimal dollars as JSON numbers, so a float→integer conversion at
 * ingest is unavoidable. `Math.round(dollars * 100)` is exact for every
 * two-decimal amount in any realistic range: the intermediate multiply is off by
 * at most a few parts in 10^16, far below the 0.5 needed to change the rounded
 * result. Verified across all cent values from $0.01 to $20,000.00.
 *
 * Cents assumes a two-decimal currency. True for USD and CAD, which is all the
 * Plaid Trial plan covers. JPY (0 decimals) and BHD (3) would need the currency's
 * own exponent; `accounts.iso_currency_code` is stored if that day comes.
 */

/** Largest amount accepted, in cents. $1 trillion — any real amount is smaller. */
const MAX_CENTS = 100_000_000_000_000;

/**
 * Converts decimal dollars from Plaid to integer cents.
 *
 * @throws RangeError if the input is not a finite number in range. A silent
 * fallback would corrupt an amount, so this is loud by design.
 */
export function toCents(dollars: number): number {
  if (typeof dollars !== 'number' || !Number.isFinite(dollars)) {
    throw new RangeError(`amount is not a finite number: ${String(dollars)}`);
  }
  const cents = Math.round(dollars * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS) {
    throw new RangeError(`amount out of range: ${dollars}`);
  }
  return cents;
}

/** Null-tolerant `toCents`. Plaid omits balances some institutions never report. */
export function toCentsOrNull(dollars: number | null | undefined): number | null {
  return dollars === null || dollars === undefined ? null : toCents(dollars);
}

/**
 * Converts integer cents back to decimal dollars for output.
 *
 * The result is the nearest double to the exact decimal value — bit-identical to
 * what `JSON.parse` would produce for the same amount written as a literal. That
 * makes the JSON this tool emits indistinguishable from storing dollars directly,
 * while the stored value stays exact.
 */
export function centsToDollars(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`cents must be an integer, got ${cents}`);
  }
  return cents / 100;
}

/** Null-tolerant `centsToDollars`. */
export function centsToDollarsOrNull(cents: number | null): number | null {
  return cents === null ? null : centsToDollars(cents);
}
