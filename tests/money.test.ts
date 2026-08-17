import { describe, expect, it } from 'vitest';
import {
  centsToDollars,
  centsToDollarsOrNull,
  toCents,
  toCentsOrNull,
} from '../src/core/money.js';

describe('toCents', () => {
  it('converts two-decimal dollars exactly', () => {
    expect(toCents(45.99)).toBe(4599);
    expect(toCents(0.01)).toBe(1);
    expect(toCents(0)).toBe(0);
    expect(toCents(1200.5)).toBe(120050);
  });

  it('preserves Plaid\'s sign convention', () => {
    // Negative is money arriving. The conversion must not normalize it.
    expect(toCents(-2000)).toBe(-200000);
    expect(toCents(-52.13)).toBe(-5213);
  });

  it('survives the float multiply that trips naive conversion', () => {
    // 12.34 * 100 === 1233.9999999999998 in IEEE 754; truncation would give 1233.
    expect(toCents(12.34)).toBe(1234);
    expect(toCents(2.67)).toBe(267);
    expect(toCents(129.95)).toBe(12995);
  });

  it('round-trips every cent value across a wide range', () => {
    // The property that makes storing cents safe at all. A single failure here
    // means an amount is silently off by a penny somewhere.
    for (let cents = -200_000; cents <= 200_000; cents += 7) {
      expect(toCents(cents / 100)).toBe(cents);
    }
  });

  it('rounds a true half-cent to the nearest cent rather than truncating', () => {
    // 2.675 is not representable; the nearest double is just above, so 268 is
    // the correct nearest-cent answer. toFixed(2) disagrees, which is exactly
    // why the display path no longer uses it.
    expect(toCents(2.675)).toBe(268);
    expect(toCents(1234.565)).toBe(123457);
  });

  it('throws on non-finite input instead of storing NaN', () => {
    expect(() => toCents(Number.NaN)).toThrow(RangeError);
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toCents('12.34' as unknown as number)).toThrow(RangeError);
  });

  it('throws when the amount exceeds the supported range', () => {
    expect(() => toCents(1e15)).toThrow(/out of range/);
    expect(() => toCents(Number.MAX_SAFE_INTEGER)).toThrow(/out of range/);
  });
});

describe('toCentsOrNull', () => {
  it('passes null and undefined through', () => {
    // Plaid omits balances that an institution does not report.
    expect(toCentsOrNull(null)).toBeNull();
    expect(toCentsOrNull(undefined)).toBeNull();
  });

  it('converts a present value', () => {
    expect(toCentsOrNull(-200)).toBe(-20000);
  });
});

describe('centsToDollars', () => {
  it('produces the same double a JSON literal would', () => {
    // Output must be indistinguishable from having stored dollars all along.
    expect(centsToDollars(4599)).toBe(45.99);
    expect(centsToDollars(-5213)).toBe(-52.13);
    expect(centsToDollars(120050)).toBe(1200.5);
    expect(centsToDollars(0)).toBe(0);
  });

  it('rejects a non-integer, which would mean cents leaked a fraction', () => {
    expect(() => centsToDollars(45.5)).toThrow(RangeError);
  });

  it('round-trips through toCents', () => {
    for (const cents of [1, 99, 4599, -20000, 123457]) {
      expect(toCents(centsToDollars(cents))).toBe(cents);
    }
  });
});

describe('centsToDollarsOrNull', () => {
  it('passes null through', () => {
    expect(centsToDollarsOrNull(null)).toBeNull();
    expect(centsToDollarsOrNull(4599)).toBe(45.99);
  });
});
