import { describe, expect, it } from 'vitest';
import { formatTable, money } from '../src/cli/format.js';

describe('money', () => {
  it('formats integer cents with sign and null as em dash', () => {
    expect(money(-5213)).toBe('-$52.13');
    expect(money(120_050)).toBe('$1,200.50');
    expect(money(null)).toBe('—');
  });

  it('pads the cents field and groups thousands', () => {
    expect(money(5)).toBe('$0.05');
    expect(money(100)).toBe('$1.00');
    expect(money(-1)).toBe('-$0.01');
    expect(money(123_456_789)).toBe('$1,234,567.89');
  });

  it('renders zero without a sign', () => {
    expect(money(0)).toBe('$0.00');
  });
});

describe('formatTable', () => {
  it('aligns columns under headers', () => {
    const out = formatTable([
      { name: 'Checking', balance: '$500.00' },
      { name: 'Card', balance: '-$200.00' },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/name\s+balance/);
    expect(lines).toHaveLength(3);
  });

  it('handles empty input', () => {
    expect(formatTable([])).toBe('(none)');
  });
});
