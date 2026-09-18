export interface Pick {
  choice: string;
  p: number;
}

export interface DateComponents {
  mode: Pick;            // absolute | relative_day | weekday | window | none
  month: Pick;           // january..december | none
  day: Pick;             // 1..31 | none
  weekday: Pick;         // monday..sunday | none
  weekdayQualifier: Pick; // this | next | none
  relativeDay: Pick;     // today | tomorrow | day_after_tomorrow | none
  window: Pick;          // this_week | next_week | this_month | next_month | none
}

export interface DateWindow {
  start: string;
  end: string;
  label: string;
}

export type DateResolution =
  | { kind: 'day'; iso: string; confidence: number }
  | ({ kind: 'window'; confidence: number } & DateWindow)
  | { kind: 'none' };

export const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export const DATE_MODES = ['absolute', 'relative_day', 'weekday', 'window', 'none'] as const;
export const RELATIVE_DAYS = ['today', 'tomorrow', 'day_after_tomorrow', 'none'] as const;
export const WINDOWS = ['this_week', 'next_week', 'this_month', 'next_month', 'none'] as const;
export const QUALIFIERS = ['this', 'next', 'none'] as const;

const DAY_MS = 86_400_000;

export function parseIso(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toIso(parseIso(iso) + days * DAY_MS);
}

/** Monday = 0 ... Sunday = 6 */
function weekdayIndex(iso: string): number {
  return (new Date(parseIso(iso)).getUTCDay() + 6) % 7;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function endOfMonth(year: number, monthIndex: number): string {
  return toIso(Date.UTC(year, monthIndex, daysInMonth(year, monthIndex)));
}

function minP(...picks: Pick[]): number {
  return Math.min(...picks.map((p) => p.p));
}

export function resolveDate(c: DateComponents, todayIso: string): DateResolution {
  const today = new Date(parseIso(todayIso));
  const year = today.getUTCFullYear();

  switch (c.mode.choice) {
    case 'relative_day': {
      const offset = { today: 0, tomorrow: 1, day_after_tomorrow: 2 }[c.relativeDay.choice];
      if (offset === undefined) return { kind: 'none' };
      return { kind: 'day', iso: addDays(todayIso, offset), confidence: minP(c.mode, c.relativeDay) };
    }

    case 'weekday': {
      const target = WEEKDAYS.indexOf(c.weekday.choice as (typeof WEEKDAYS)[number]);
      if (target < 0) return { kind: 'none' };
      const todayIdx = weekdayIndex(todayIso);
      let iso: string;
      if (c.weekdayQualifier.choice === 'next') {
        const nextMonday = addDays(todayIso, 7 - todayIdx);
        iso = addDays(nextMonday, target);
      } else {
        const ahead = ((target - todayIdx + 7) % 7) || 7;
        iso = addDays(todayIso, ahead);
      }
      const picks = [c.mode, c.weekday];
      if (c.weekdayQualifier.choice !== 'none') picks.push(c.weekdayQualifier);
      return { kind: 'day', iso, confidence: minP(...picks) };
    }

    case 'window': {
      const todayIdx = weekdayIndex(todayIso);
      const monthIdx = today.getUTCMonth();
      const confidence = minP(c.mode, c.window);
      const label = c.window.choice;
      switch (label) {
        case 'this_week':
          return { kind: 'window', start: todayIso, end: addDays(todayIso, 6 - todayIdx), label, confidence };
        case 'next_week': {
          const start = addDays(todayIso, 7 - todayIdx);
          return { kind: 'window', start, end: addDays(start, 6), label, confidence };
        }
        case 'this_month':
          return { kind: 'window', start: todayIso, end: endOfMonth(year, monthIdx), label, confidence };
        case 'next_month': {
          const y = monthIdx === 11 ? year + 1 : year;
          const m = (monthIdx + 1) % 12;
          return { kind: 'window', start: toIso(Date.UTC(y, m, 1)), end: endOfMonth(y, m), label, confidence };
        }
        default:
          return { kind: 'none' };
      }
    }

    case 'absolute': {
      const monthIdx = MONTHS.indexOf(c.month.choice as (typeof MONTHS)[number]);
      if (monthIdx < 0) return { kind: 'none' };
      if (c.day.choice === 'none') {
        const y = monthIdx < today.getUTCMonth() ? year + 1 : year;
        return {
          kind: 'window',
          start: toIso(Date.UTC(y, monthIdx, 1)),
          end: endOfMonth(y, monthIdx),
          label: c.month.choice,
          confidence: minP(c.mode, c.month),
        };
      }
      const day = Number(c.day.choice);
      if (!Number.isInteger(day) || day < 1) return { kind: 'none' };
      let y = year;
      if (day > daysInMonth(y, monthIdx)) return { kind: 'none' };
      let iso = toIso(Date.UTC(y, monthIdx, day));
      if (parseIso(iso) < parseIso(todayIso) - 31 * DAY_MS) {
        y += 1;
        if (day > daysInMonth(y, monthIdx)) return { kind: 'none' };
        iso = toIso(Date.UTC(y, monthIdx, day));
      }
      return { kind: 'day', iso, confidence: minP(c.mode, c.month, c.day) };
    }

    default:
      return { kind: 'none' };
  }
}

/** Human-readable form for prompts, e.g. "Tuesday, September 22". */
export function describeDay(iso: string): string {
  const d = new Date(parseIso(iso));
  const wd = WEEKDAYS[weekdayIndex(iso)]!;
  const mo = MONTHS[d.getUTCMonth()]!;
  const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
  return `${cap(wd)}, ${cap(mo)} ${d.getUTCDate()}`;
}

export function describeWindow(w: DateWindow): string {
  return w.label.replace(/_/g, ' ');
}
