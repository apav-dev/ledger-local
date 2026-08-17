/**
 * Formats integer cents as a dollar string.
 *
 * Splits the integer before formatting so no float ever enters the display path.
 * The old dollars-based version leaned on `toLocaleString`'s rounding, which
 * disagrees with nearest-cent on true half-cent values — `2.675` renders as
 * `$2.67` when the correct answer is `$2.68`.
 */
export function money(cents: number | null): string {
  if (cents === null) return '—';
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${whole.toLocaleString('en-US')}.${String(frac).padStart(2, '0')}`;
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
