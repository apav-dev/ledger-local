import { describe, expect, it } from 'vitest';
import { formatTable, money } from '../src/cli/format.js';

describe('money', () => {
  it('formats dollars with sign and null as em dash', () => {
    expect(money(-52.13)).toBe('-$52.13');
    expect(money(1200.5)).toBe('$1,200.50');
    expect(money(null)).toBe('—');
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
