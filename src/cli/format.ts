export function money(n: number | null): string {
  if (n === null) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '(none)';
  const first = rows[0];
  if (first === undefined) return '(none)';
  const keys = Object.keys(first);
  const cell = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => cell(r[k]).length)),
  );
  const line = (vals: string[]): string =>
    vals.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(keys), ...rows.map(r => line(keys.map(k => cell(r[k]))))].join('\n');
}
