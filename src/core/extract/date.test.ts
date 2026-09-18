import { describe, expect, it } from 'vitest';
import { describeWindow, resolveDate, type DateComponents } from './date';

// 2026-09-18 is a Friday.
const TODAY = '2026-09-18';

function comps(partial: Partial<Record<keyof DateComponents, string>>): DateComponents {
  const pick = (k: keyof DateComponents) => ({ choice: partial[k] ?? 'none', p: 0.9 });
  return {
    mode: pick('mode'),
    month: pick('month'),
    day: pick('day'),
    weekday: pick('weekday'),
    weekdayQualifier: pick('weekdayQualifier'),
    relativeDay: pick('relativeDay'),
    window: pick('window'),
  };
}

describe('resolveDate', () => {
  it('returns none when no date is mentioned', () => {
    expect(resolveDate(comps({}), TODAY)).toEqual({ kind: 'none' });
  });

  it('resolves tomorrow', () => {
    expect(resolveDate(comps({ mode: 'relative_day', relativeDay: 'tomorrow' }), TODAY))
      .toEqual({ kind: 'day', iso: '2026-09-19', confidence: 0.9 });
  });

  it('resolves a bare weekday to the next occurrence after today', () => {
    expect(resolveDate(comps({ mode: 'weekday', weekday: 'tuesday' }), TODAY))
      .toMatchObject({ kind: 'day', iso: '2026-09-22' });
  });

  it('resolves the same weekday as today to a week ahead', () => {
    expect(resolveDate(comps({ mode: 'weekday', weekday: 'friday' }), TODAY))
      .toMatchObject({ kind: 'day', iso: '2026-09-25' });
  });

  it('resolves "next friday" to the friday of next week', () => {
    expect(resolveDate(comps({ mode: 'weekday', weekday: 'friday', weekdayQualifier: 'next' }), TODAY))
      .toMatchObject({ kind: 'day', iso: '2026-09-25' });
  });

  it('resolves next week to a window', () => {
    expect(resolveDate(comps({ mode: 'window', window: 'next_week' }), TODAY))
      .toEqual({ kind: 'window', start: '2026-09-21', end: '2026-09-27', label: 'next_week', confidence: 0.9 });
  });

  it('resolves a weekday named with a window to that day inside the window', () => {
    const c = comps({ mode: 'window', window: 'next_week', weekday: 'tuesday' });
    c.weekday.p = 0.7;
    expect(resolveDate(c, TODAY)).toEqual({ kind: 'day', iso: '2026-09-22', confidence: 0.7 });
  });

  it('keeps the window when the named weekday cannot fit', () => {
    expect(resolveDate(comps({ mode: 'window', window: 'this_week', weekday: 'monday' }), TODAY))
      .toMatchObject({ kind: 'window', start: '2026-09-18', end: '2026-09-20', label: 'this_week' });
  });

  it('resolves this week from today to sunday', () => {
    expect(resolveDate(comps({ mode: 'window', window: 'this_week' }), TODAY))
      .toMatchObject({ kind: 'window', start: '2026-09-18', end: '2026-09-20' });
  });

  it('places a past absolute date in the next year', () => {
    expect(resolveDate(comps({ mode: 'absolute', month: 'march', day: '3' }), TODAY))
      .toMatchObject({ kind: 'day', iso: '2027-03-03' });
  });

  it('keeps an upcoming absolute date in this year', () => {
    expect(resolveDate(comps({ mode: 'absolute', month: 'october', day: '5' }), TODAY))
      .toMatchObject({ kind: 'day', iso: '2026-10-05' });
  });

  it('rejects impossible dates', () => {
    expect(resolveDate(comps({ mode: 'absolute', month: 'february', day: '30' }), TODAY))
      .toEqual({ kind: 'none' });
  });

  it('treats a month without a day as a window', () => {
    expect(resolveDate(comps({ mode: 'absolute', month: 'december' }), TODAY))
      .toMatchObject({ kind: 'window', start: '2026-12-01', end: '2026-12-31', label: 'december' });
  });

  it('uses the weakest component as confidence', () => {
    const c = comps({ mode: 'absolute', month: 'october', day: '5' });
    c.day.p = 0.55;
    expect(resolveDate(c, TODAY)).toMatchObject({ confidence: 0.55 });
  });

  it('rejects an absolute day in the recent past', () => {
    expect(resolveDate(comps({ mode: 'absolute', month: 'september', day: '17' }), TODAY))
      .toEqual({ kind: 'none' });
  });

  it('starts a current-month window at today', () => {
    expect(resolveDate(comps({ mode: 'absolute', month: 'september' }), TODAY))
      .toMatchObject({ kind: 'window', start: '2026-09-18', end: '2026-09-30' });
  });

  it('collapses a one-day window to a day', () => {
    expect(resolveDate(comps({ mode: 'window', window: 'this_week' }), '2026-09-20'))
      .toEqual({ kind: 'day', iso: '2026-09-20', confidence: 0.9 });
  });

  it('resolves "this friday" on a monday to that week', () => {
    expect(resolveDate(comps({ mode: 'weekday', weekday: 'friday', weekdayQualifier: 'this' }), '2026-09-21'))
      .toMatchObject({ kind: 'day', iso: '2026-09-25' });
  });

  it('resolves "this monday" on a monday to today', () => {
    expect(resolveDate(comps({ mode: 'weekday', weekday: 'monday', weekdayQualifier: 'this' }), '2026-09-21'))
      .toMatchObject({ kind: 'day', iso: '2026-09-21' });
  });

  it('returns none for a prototype-name relative day', () => {
    expect(resolveDate(comps({ mode: 'relative_day', relativeDay: 'constructor' }), TODAY))
      .toEqual({ kind: 'none' });
  });
});

describe('describeWindow', () => {
  it('describes a month window as "in <Month>" and other windows as underscore-to-space', () => {
    expect(describeWindow({ start: '2026-12-01', end: '2026-12-31', label: 'december' })).toBe('in December');
    expect(describeWindow({ start: '2026-09-21', end: '2026-09-27', label: 'next_week' })).toBe('next week');
  });
});
