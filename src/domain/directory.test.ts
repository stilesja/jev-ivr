import { describe, expect, it } from 'vitest';
import { DAYPART_ORDER, DEMO_TIMES, DemoDirectory, daypartBounds, daypartOf, hashOf, minutesOf } from './directory';
import { addDays, parseIso } from '../core/extract/date';

const TODAY = '2026-09-24';
const dir = new DemoDirectory(TODAY);
const PROVIDERS = ['chen', 'cheng', 'patel', 'okafor', 'nguyen', 'rossi', 'kim', 'alvarez'];

/** True when a caller's booking lands on a weekday, after `today`, within the fortnight. */
function isValidBooking(booking: { date: string }, today: string): boolean {
  const day = new Date(parseIso(booking.date)).getUTCDay();
  return day >= 1 && day <= 5 && booking.date > today && booking.date <= addDays(today, 14);
}

describe('dayparts', () => {
  it('splits the day at 11 and 2', () => {
    expect(daypartOf('10:59 AM')).toBe('morning');
    expect(daypartOf('11:00 AM')).toBe('midday');
    expect(daypartOf('1:59 PM')).toBe('midday');
    expect(daypartOf('2:00 PM')).toBe('afternoon');
    expect(DAYPART_ORDER).toEqual(['morning', 'midday', 'afternoon']);
    expect(daypartBounds('midday')).toEqual({ start: 660, end: 840 });
  });

  it('reads clock times and rejects anything else', () => {
    expect(minutesOf('12:30 PM')).toBe(750);
    expect(minutesOf('12:05 AM')).toBe(5);
    expect(() => minutesOf('noon')).toThrow(/not a clock time/);
  });

  it('has three demo times in each window, in clock order', () => {
    expect(DEMO_TIMES.map(daypartOf)).toEqual(['morning', 'morning', 'morning', 'midday', 'midday', 'midday', 'afternoon', 'afternoon', 'afternoon']);
    const mins = DEMO_TIMES.map(minutesOf);
    expect([...mins].sort((a, b) => a - b)).toEqual(mins);
  });
});

describe('DemoDirectory', () => {
  it('finds the same booking for the same caller every time, on a weekday within a fortnight', () => {
    const a = dir.find('jason stiles', '1980-03-05', 'chen');
    expect(dir.find('jason stiles', '1980-03-05', 'chen')).toEqual(a);
    expect(new DemoDirectory(TODAY).find('Jason Stiles', '1980-03-05', 'chen')).toEqual(a);
    const day = new Date(parseIso(a.date)).getUTCDay();
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(5);
    expect(a.date > TODAY).toBe(true);
    expect(a.date <= addDays(TODAY, 14)).toBe(true);
    expect(DEMO_TIMES).toContain(a.time);
  });

  it('gives different callers different bookings', () => {
    const a = dir.find('jason stiles', '1980-03-05', 'chen');
    const b = dir.find('andy middleton', '2000-01-01', 'chen');
    expect(a).not.toEqual(b);
  });

  it('stays inside the fortnight when today sits right at the weekday boundary', () => {
    // A Friday and a Saturday `today` push the weekend-skipping walk against both edges of the
    // fortnight from a different starting weekday than TODAY does.
    for (const today of ['2026-09-25', '2026-09-26']) {
      const d = new DemoDirectory(today);
      for (const [name, dob] of [
        ['jason stiles', '1980-03-05'],
        ['andy middleton', '2000-01-01'],
        ['priya patel', '1992-11-30'],
      ] as const) {
        expect(isValidBooking(d.find(name, dob, 'chen'), today)).toBe(true);
      }
    }
  });

  it('offers three openings in clock order, the same on every call', () => {
    const times = dir.openings('chen', '2026-10-06');
    expect(times).toHaveLength(3);
    expect(new Set(times).size).toBe(3);
    expect(times.map(minutesOf)).toEqual([...times.map(minutesOf)].sort((a, b) => a - b));
    expect(dir.openings('chen', '2026-10-06')).toEqual(times);
    expect(dir.openings('kim', '2026-10-06')).not.toEqual(times);
  });

  it('terminates and stays in the table for every provider and day in a month', () => {
    for (const p of PROVIDERS) {
      for (let d = 0; d < 31; d += 1) {
        const times = dir.openings(p, addDays(TODAY, d));
        expect(times).toHaveLength(3);
        for (const t of times) expect(DEMO_TIMES).toContain(t);
      }
    }
  });

  it('spreads openings across windows: some days cover all three, some miss one', () => {
    let oneEachWindow = 0;
    let missingAWindow = 0;
    for (const p of PROVIDERS) {
      for (let d = 0; d < 31; d += 1) {
        const parts = new Set(dir.openings(p, addDays(TODAY, d)).map(daypartOf));
        if (parts.size === 3) oneEachWindow += 1;
        if (parts.size < 3) missingAWindow += 1;
      }
    }
    // Both the ordinary case (a slot in every window) and the case the nearest-opening rule
    // needs (a day that skips a window) have to actually turn up in the sweep. A fair draw gives
    // one time per window in 27 of the 84 possible sets, about 80 of these 248 days; 40 leaves room.
    expect(oneEachWindow).toBeGreaterThan(40);
    expect(missingAWindow).toBeGreaterThan(0);
  });

  it('stays a three-item draw for the seed that used to spin forever under the shift loop', () => {
    // provider "okafor" on 2026-10-19 never reached three distinct residues under the old
    // `(h >>> (i * 4)) % 9` loop, because that shift repeats every eight steps; the draw-without-
    // replacement rewrite is distinct by construction, so this can no longer hang.
    expect(dir.openings('okafor', '2026-10-19')).toHaveLength(3);
  });

  it('hashes stably and case-insensitively', () => {
    expect(hashOf('Chen')).toBe(hashOf('chen'));
    expect(hashOf('a')).not.toBe(hashOf('b'));
  });
});
