import { addDays, parseIso } from '../core/extract/date';

/** An appointment as the caller hears it: an ISO day and a clock time such as "2:45 PM". */
export interface Booking {
  date: string;
  time: string;
}

/**
 * The seam a real deployment backs with its scheduling system (spec 2026-09-24 appointment-slots
 * §2). The core never asks the caller for a time: it reads the booking they have and offers the
 * openings it finds. Synchronous by design for the demo, since `resolve` calls `find`/`openings`
 * inline on the turn that fills the slots. A network-backed directory would need `resolve` to hand
 * a lookup step back to the async `runTurn` instead, which is a change to the framework's turn
 * loop, not something a server-side implementation of this interface can do on its own.
 */
export interface AppointmentDirectory {
  /** The caller's existing booking with this provider, or null when there is none. */
  find(name: string, dob: string, provider: string): Booking | null;
  /** That provider's open times on that ISO day, in clock order. Empty when the day is full. */
  openings(provider: string, date: string): string[];
}

/** Three-hour windows over the clinic's day: 8 to 11, 11 to 2, 2 to 5. */
export type Daypart = 'morning' | 'midday' | 'afternoon';
export const DAYPART_ORDER: readonly Daypart[] = ['morning', 'midday', 'afternoon'];

/** Minutes since midnight for a clock time such as "2:45 PM". */
export function minutesOf(time: string): number {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(time);
  if (!m) throw new Error(`not a clock time: ${time}`);
  const h = (Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0);
  return h * 60 + Number(m[2]);
}

/** The window a clock time falls in. Before 11:00 is morning; 2:00 PM and later is afternoon. */
export function daypartOf(time: string): Daypart {
  const min = minutesOf(time);
  if (min < 11 * 60) return 'morning';
  if (min < 14 * 60) return 'midday';
  return 'afternoon';
}

/** The first minute of a window, and the first minute after it, for the nearest-opening rule. */
export function daypartBounds(part: Daypart): { start: number; end: number } {
  return part === 'morning'
    ? { start: 8 * 60, end: 11 * 60 }
    : part === 'midday'
      ? { start: 11 * 60, end: 14 * 60 }
      : { start: 14 * 60, end: 17 * 60 };
}

/** The demo's nine times, three in each window, in clock order. */
export const DEMO_TIMES: readonly string[] = [
  '8:30 AM',
  '9:15 AM',
  '10:00 AM',
  '11:15 AM',
  '12:30 PM',
  '1:00 PM',
  '2:45 PM',
  '3:30 PM',
  '4:15 PM',
];

/**
 * FNV-1a over the string, as a non-negative 32-bit integer. Stable across runs and platforms.
 * Walks UTF-16 code units rather than code points, so a high and low surrogate of an astral
 * character each contribute their own byte instead of the pair collapsing to one.
 */
export function hashOf(text: string): number {
  const s = text.toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function isWeekend(iso: string): boolean {
  const day = new Date(parseIso(iso)).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Invents bookings and openings deterministically, so the same caller hears the same appointment
 * on every call and the harness reproduces a run from its date alone. Never returns null and never
 * an empty day; both paths belong to the framework, not the demo.
 */
export class DemoDirectory implements AppointmentDirectory {
  constructor(private readonly todayIso: string) {}

  find(name: string, dob: string, provider: string): Booking {
    const h = hashOf(`${name}|${dob}|${provider}`);
    // A weekday one to fourteen days out: step forward from tomorrow, skipping weekends, as many
    // weekdays as the hash says (one to ten), which always lands inside the fortnight.
    let date = this.todayIso;
    for (let left = (h % 10) + 1; left > 0; ) {
      date = addDays(date, 1);
      if (!isWeekend(date)) left -= 1;
    }
    return { date, time: DEMO_TIMES[(h >>> 8) % DEMO_TIMES.length]! };
  }

  openings(provider: string, date: string): string[] {
    // Three of the nine table indexes, drawn without replacement from one hash: distinct by
    // construction rather than by retrying until three distinct values turn up, so there is no
    // loop that can stall, and each of the 9*8*7 orderings is close to equally likely. Base-(9,8,7)
    // digits of the hash pick the draw order (9*8*7 = 504 fits well inside 32 bits), then the
    // result is sorted back into clock order.
    let h = hashOf(`${provider}|${date}`);
    const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const out: number[] = [];
    for (let n = 9; n > 6; n -= 1) {
      out.push(pool.splice(h % n, 1)[0]!);
      h = Math.floor(h / n);
    }
    return out.sort((a, b) => a - b).map((i) => DEMO_TIMES[i]!);
  }
}
