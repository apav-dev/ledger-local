import { describe, expect, it } from 'vitest';
import { assertDateOrder, resolveDate } from '../src/core/dates.js';

const NOW = Date.UTC(2026, 7, 17); // 2026-08-17
const now = () => NOW;

describe('resolveDate', () => {
  it('passes an absolute yyyy-mm-dd through unchanged', () => {
    expect(resolveDate('2026-08-01', now)).toBe('2026-08-01');
  });

  it('rejects shape-valid but impossible calendar dates', () => {
    expect(() => resolveDate('2026-02-30', now)).toThrow(/not a valid date/);
    expect(() => resolveDate('2026-13-45', now)).toThrow(/not a valid date/);
  });

  it('rejects garbage strings', () => {
    expect(() => resolveDate('last month', now)).toThrow(/not a valid date/);
    expect(() => resolveDate('today ', now)).toThrow(/not a valid date/); // no trailing-space tolerance
  });

  it.each([
    ['today', '2026-08-17'],
    ['yesterday', '2026-08-16'],
    ['this-month', '2026-08-01'],
    ['last-month', '2026-07-01'],
    ['end-of-last-month', '2026-07-31'],
    ['this-year', '2026-01-01'],
    ['7-days-ago', '2026-08-10'],
    ['30-days-ago', '2026-07-18'],
  ])('resolves relative keyword %s to %s', (keyword, expected) => {
    expect(resolveDate(keyword, now)).toBe(expected);
  });

  it('is case-insensitive on relative keywords', () => {
    expect(resolveDate('Today', now)).toBe('2026-08-17');
    expect(resolveDate('THIS-MONTH', now)).toBe('2026-08-01');
  });

  it('resolves last-month across a year boundary', () => {
    expect(resolveDate('last-month', () => Date.UTC(2026, 0, 15))).toBe('2025-12-01');
  });
});

describe('assertDateOrder', () => {
  it('throws when from is after to', () => {
    expect(() => assertDateOrder('2026-08-31', '2026-08-01')).toThrow(/must not be after/);
  });

  it('passes when from is before or equal to to', () => {
    expect(() => assertDateOrder('2026-08-01', '2026-08-31')).not.toThrow();
    expect(() => assertDateOrder('2026-08-01', '2026-08-01')).not.toThrow();
  });
});
