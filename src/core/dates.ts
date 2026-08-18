/**
 * Every date the app accepts (`--from`/`--to` on the CLI, `from`/`to` on the MCP
 * tools) flows through here before it ever reaches a SQL comparison. The
 * `transactions.date` column is TEXT `yyyy-mm-dd`, so `date >= @from` is a
 * lexical string compare — a malformed value doesn't error, it just never
 * matches anything, which reads to a caller as "no spending" instead of "bad
 * input." Resolving and validating once here means both frontends inherit the
 * same behavior for free.
 */
const ABSOLUTE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_AGO_RE = /^(\d+)-days-ago$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Shape-valid isn't enough: rejects 2026-02-30 and 2026-13-45, not just non-yyyy-mm-dd strings. */
function isRealCalendarDate(value: string): boolean {
  if (!ABSOLUTE_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function ymd(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// All UTC, keyed off the injected clock — never local time, so there is no
// DST or timezone drift between the CLI, MCP, and tests.
const RELATIVE_KEYWORDS: Record<string, (now: () => number) => string> = {
  today: now => ymd(now()),
  yesterday: now => ymd(now() - DAY_MS),
  'this-month': now => {
    const d = new Date(now());
    return ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  },
  'last-month': now => {
    const d = new Date(now());
    return ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  },
  // Date.UTC(y, m, 0) is "day 0 of month m", i.e. the last day of month m-1.
  'end-of-last-month': now => {
    const d = new Date(now());
    return ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  },
  'this-year': now => {
    const d = new Date(now());
    return ymd(Date.UTC(d.getUTCFullYear(), 0, 1));
  },
};

const ACCEPTED_FORMATS_HINT =
  'yyyy-mm-dd, or a relative keyword: today, yesterday, this-month, last-month, ' +
  'end-of-last-month, this-year, <N>-days-ago (e.g. 30-days-ago)';

/** Accepts an absolute yyyy-mm-dd or a relative keyword; always returns yyyy-mm-dd. */
export function resolveDate(value: string, now: () => number): string {
  if (isRealCalendarDate(value)) return value;

  const normalized = value.toLowerCase();

  const keyword = RELATIVE_KEYWORDS[normalized];
  if (keyword !== undefined) return keyword(now);

  const daysAgoMatch = DAYS_AGO_RE.exec(normalized);
  if (daysAgoMatch !== null) {
    const [, digits] = daysAgoMatch;
    if (digits !== undefined) return ymd(now() - Number(digits) * DAY_MS);
  }

  throw new Error(`"${value}" is not a valid date. Accepted formats: ${ACCEPTED_FORMATS_HINT}`);
}

export function assertDateOrder(from: string, to: string): void {
  if (from > to) {
    throw new Error(`from (${from}) must not be after to (${to})`);
  }
}
