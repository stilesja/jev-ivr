import { describe, expect, it } from 'vitest';
import { describeDob, normalizeYear } from '../../core/extract/date';
import { dobSlot } from './dob';
import { choice, noul } from '../../testing/answers';
import { candidateSpans, candidateWordSpans } from '../../core/spans';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';

const ctx = (text: string) => ({ text, candidateSpans: candidateSpans(text), candidateWordSpans: candidateWordSpans(text), todayIso: '2026-09-18', thresholds: DEFAULT_THRESHOLDS, window: null });

describe('dobSlot', () => {
  it('asks given, month, day, and a year span over the number candidates', () => {
    const q = dobSlot.questions(ctx('march fifth nineteen eighty'));
    expect(Object.keys(q)).toEqual(['dobGiven', 'dobMonth', 'dobDay', 'dobYear']);
    expect(Object.keys((q.dobYear as { criteria: Record<string, unknown> }).criteria)).toEqual([...candidateSpans('march fifth nineteen eighty'), 'none']);
  });

  it('still asks all four when a month/day partial is pending, with a year instruction that says so', () => {
    const c = { ...ctx('nineteen eighty'), window: { kind: 'dob' as const, month: 3, day: 5 } };
    const q = dobSlot.questions(c);
    expect(Object.keys(q)).toEqual(['dobGiven', 'dobMonth', 'dobDay', 'dobYear']);
    expect((q.dobYear as { instructions: string }).instructions).toMatch(/asked for the year of their birth/);
  });

  it('fills a full date', () => {
    const r = dobSlot.fill({ dobGiven: noul(0.95), dobMonth: choice({ march: 0.9 }), dobDay: choice({ '5': 0.9 }), dobYear: choice({ 'nineteen eighty': 0.9, none: 0.1 }) }, ctx('march fifth nineteen eighty'));
    expect(r).toMatchObject({ kind: 'filled', value: '1980-03-05', display: 'March 5th, 1980', confirm: 'none' });
  });

  it('narrows to the year when month and day are given without one', () => {
    const r = dobSlot.fill({ dobGiven: noul(0.95), dobMonth: choice({ march: 0.9 }), dobDay: choice({ '5': 0.9 }), dobYear: choice({ none: 0.9 }) }, ctx('march fifth'));
    expect(r).toMatchObject({ kind: 'window', window: { kind: 'dob', month: 3, day: 5 } });
  });

  it('completes from a year alone when a partial is pending', () => {
    const c = { ...ctx('nineteen eighty'), window: { kind: 'dob' as const, month: 3, day: 5 } };
    const r = dobSlot.fill({ dobGiven: noul(0.6), dobMonth: choice({ none: 0.9 }), dobDay: choice({ none: 0.9 }), dobYear: choice({ 'nineteen eighty': 0.9 }) }, c);
    expect(r).toMatchObject({ kind: 'filled', value: '1980-03-05' });
  });

  it('maps a two-digit year into the past', () => {
    expect(normalizeYear('eighty', '2026-09-18')).toBe(1980);
    expect(normalizeYear('ten', '2026-09-18')).toBe(2010);
    expect(normalizeYear('nineteen eighty', '2026-09-18')).toBe(1980);
    expect(normalizeYear('two thousand five', '2026-09-18')).toBe(2005);
  });

  it('rejects a future date, an impossible date, and a year before 1900', () => {
    const f = (m: string, d: string, y: string) => dobSlot.fill({ dobGiven: noul(0.95), dobMonth: choice({ [m]: 0.9 }), dobDay: choice({ [d]: 0.9 }), dobYear: choice({ [y]: 0.9 }) }, ctx(`${m} ${d} ${y}`));
    expect(f('december', '25', 'twenty thirty')).toMatchObject({ kind: 'invalid', reason: 'future' });
    expect(f('february', '30', 'nineteen eighty')).toMatchObject({ kind: 'invalid', reason: 'impossible' });
    expect(f('march', '5', 'eighteen fifty')).toMatchObject({ kind: 'invalid', reason: 'impossible' });
  });

  it('parses the keypad as MMDDYYYY with the same rules', () => {
    expect(dobSlot.dtmf!.parse('03051980', ctx(''))).toEqual({ value: '1980-03-05', display: 'March 5th, 1980' });
    expect(dobSlot.dtmf!.parse('02301980', ctx(''))).toBeNull();
    expect(dobSlot.dtmf!.parse('03052030', ctx(''))).toBeNull();
    expect(dobSlot.dtmf!.length).toBe(8);
  });

  it('describes with an ordinal day', () => {
    expect(describeDob('1980-03-05')).toBe('March 5th, 1980');
    expect(describeDob('1991-11-22')).toBe('November 22nd, 1991');
    expect(describeDob('2001-01-11')).toBe('January 11th, 2001');
  });

  it('is absent when no component is read, so a pending partial is not replayed as fresh progress', () => {
    // dobGiven can run high on an answer the components cannot read ("uh, let me think"). Rebuilding
    // the pending partial as a window outcome would count as progress every turn, and the caller
    // would loop on ask_dob_year with the attempt counter stuck at zero.
    const c = { ...ctx('uh let me think'), window: { kind: 'dob' as const, month: 3, day: 5 } };
    const r = dobSlot.fill({ dobGiven: noul(0.9), dobMonth: choice({ none: 0.9 }), dobDay: choice({ none: 0.9 }), dobYear: choice({ none: 0.9 }) }, c);
    expect(r).toEqual({ kind: 'absent' });
  });

  it('ignores a component below the choice threshold rather than averaging it into the confidence', () => {
    const r = dobSlot.fill(
      { dobGiven: noul(0.95), dobMonth: choice({ march: 0.9 }), dobDay: choice({ '5': 0.88 }), dobYear: choice({ 'nineteen eighty': 0.3, none: 0.7 }) },
      { ...ctx('march fifth'), window: { kind: 'dob' as const, month: 3, day: 5 } },
    );
    expect(r).toMatchObject({ kind: 'window', confidence: 0.88 });
  });

  it('has an eight-digit keypad rung and no confirm-always policy', () => {
    expect(dobSlot.spokenConfirm).toBe('summary');
    expect(dobSlot.dtmf?.length).toBe(8);
  });
});
