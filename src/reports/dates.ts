import { sqlTime } from '../auth/repository.js';
const day = 86400000;
export function nextDate(date: string): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + day).toISOString().slice(0, 10);
}
// Locate the first instant of a society calendar day, including DST/offset changes.
// A skipped civil day has an empty interval. No server/OS or MySQL timezone tables are assumed.
export function dayStart(date: string, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const local = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const value = (key: string) => parts.find((part) => part.type === key)?.value ?? '';
    return value('year') + '-' + value('month') + '-' + value('day');
  };
  const target = Date.parse(date + 'T00:00:00Z');
  let lower = target - 2 * day,
    upper = target + 2 * day;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (local(middle) < date) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}
export function utcRange(from: string, to: string, timezone: string): [string, string] {
  return [sqlTime(dayStart(from, timezone)), sqlTime(dayStart(nextDate(to), timezone))];
}
/** The `count` calendar months ending with the month of `today`, oldest first, as YYYY-MM. */
export function recentMonths(today: string, count: number): string[] {
  const year = Number(today.slice(0, 4)),
    month = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(year, month - (count - 1 - index), 1)).toISOString().slice(0, 7),
  );
}
