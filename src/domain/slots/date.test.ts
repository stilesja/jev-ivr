import { describe, expect, it } from 'vitest';
import { dateSlot } from './date';
import { EXCLUDED_NAME_TOKENS, SLOTS, slotsFor } from './index';
import type { SlotContext } from './types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { choice } from '../../testing/answers';
import type { AnswerMap } from '../../jev/types';

const ctx: SlotContext = { text: '', candidateSpans: [], candidateWordSpans: [], todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, window: null, excludedNameTokens: EXCLUDED_NAME_TOKENS };

function dateAnswers(picks: Record<string, [string, number]>): AnswerMap {
  const ids = ['dateMode', 'dateMonth', 'dateDay', 'dateWeekday', 'dateWeekdayQualifier', 'dateRelativeDay', 'dateWindow'];
  const out: AnswerMap = {};
  for (const id of ids) {
    const [label, p] = picks[id] ?? ['none', 0.95];
    out[id] = choice({ [label]: p, ...(label === 'none' ? {} : { none: 1 - p }) });
  }
  return out;
}

describe('dateSlot', () => {
  it('asks the seven component questions', () => {
    expect(Object.keys(dateSlot.questions(ctx))).toEqual([
      'dateMode', 'dateMonth', 'dateDay', 'dateWeekday', 'dateWeekdayQualifier', 'dateRelativeDay', 'dateWindow',
    ]);
  });

  it('fills a specific day silently when confident', () => {
    const out = dateSlot.fill(dateAnswers({ dateMode: ['relative_day', 0.9], dateRelativeDay: ['tomorrow', 0.9] }), ctx);
    expect(out).toEqual({ kind: 'filled', value: '2026-09-19', display: 'Saturday, September 19', confidence: 0.9, confirm: 'none' });
  });

  it('fills with implicit confirm when the weakest component is in the confirm band', () => {
    const answers = dateAnswers({ dateMode: ['absolute', 0.9], dateMonth: ['october', 0.9] });
    // 0.47 sits inside the implicit-confirm band [SLOT_CHOICE_CONFIRM, SLOT_CHOICE_FILL); mass is split three ways so `none` is not the argmax
    answers.dateDay = choice({ '5': 0.47, none: 0.33, '6': 0.2 });
    const out = dateSlot.fill(answers, ctx);
    expect(out).toMatchObject({ kind: 'filled', value: '2026-10-05', confirm: 'implicit' });
  });

  it('returns a window for next week', () => {
    const out = dateSlot.fill(dateAnswers({ dateMode: ['window', 0.9], dateWindow: ['next_week', 0.88] }), ctx);
    expect(out).toEqual({ kind: 'window', window: { start: '2026-09-21', end: '2026-09-27', label: 'next_week' }, confidence: 0.88 });
  });

  it('is absent when no date is mentioned', () => {
    expect(dateSlot.fill(dateAnswers({}), ctx)).toEqual({ kind: 'absent' });
  });

  it('is absent when the mode is below the confirm band', () => {
    expect(dateSlot.fill(dateAnswers({ dateMode: ['relative_day', 0.3], dateRelativeDay: ['tomorrow', 0.9] }), ctx)).toEqual({ kind: 'absent' });
  });

  it('reports an unresolvable date as invalid', () => {
    const out = dateSlot.fill(dateAnswers({ dateMode: ['absolute', 0.9], dateMonth: ['february', 0.9], dateDay: ['30', 0.9] }), ctx);
    expect(out).toEqual({ kind: 'invalid', reason: 'unresolvable', raw: 'absolute' });
  });

  it('reports a low-confidence day as invalid', () => {
    const answers = {
      ...dateAnswers({ dateMode: ['absolute', 0.9], dateMonth: ['october', 0.9] }),
      dateDay: choice({ '5': 0.3, '15': 0.25, '25': 0.25, none: 0.2 }),
    };
    expect(dateSlot.fill(answers, ctx)).toMatchObject({ kind: 'invalid', reason: 'low_confidence', raw: '2026-10-05' });
  });

  it('snaps a weekday into a pending month window', () => {
    const windowed = { ...ctx, window: { start: '2026-12-01', end: '2026-12-31', label: 'december' } };
    const out = dateSlot.fill(dateAnswers({ dateMode: ['weekday', 0.9], dateWeekday: ['wednesday', 0.9] }), windowed);
    expect(out).toMatchObject({ kind: 'filled', value: '2026-12-02', display: 'Wednesday, December 2' });
  });

  it('keeps a weekday that already falls inside a pending next-week window', () => {
    const windowed = { ...ctx, window: { start: '2026-09-21', end: '2026-09-27', label: 'next_week' } };
    const out = dateSlot.fill(dateAnswers({ dateMode: ['weekday', 0.9], dateWeekday: ['friday', 0.9] }), windowed);
    expect(out).toMatchObject({ kind: 'filled', value: '2026-09-25' });
  });

  it('rejects a weekday with no occurrence inside the window', () => {
    const windowed = { ...ctx, window: { start: '2026-12-01', end: '2026-12-02', label: 'december' } };
    const out = dateSlot.fill(dateAnswers({ dateMode: ['weekday', 0.9], dateWeekday: ['friday', 0.9] }), windowed);
    expect(out).toEqual({ kind: 'invalid', reason: 'outside_window', raw: '2026-09-25' });
  });

  it('never snaps into the part of a window that is already past', () => {
    const windowed = { ...ctx, window: { start: '2026-09-14', end: '2026-09-20', label: 'this_week' } };
    const out = dateSlot.fill(dateAnswers({ dateMode: ['weekday', 0.9], dateWeekday: ['monday', 0.9] }), windowed);
    expect(out).toEqual({ kind: 'invalid', reason: 'outside_window', raw: '2026-09-21' });
  });

  it('takes an absolute day outside the window as spoken', () => {
    const windowed = { ...ctx, window: { start: '2026-12-01', end: '2026-12-31', label: 'december' } };
    const out = dateSlot.fill(dateAnswers({ dateMode: ['absolute', 0.9], dateMonth: ['october', 0.9], dateDay: ['5', 0.9] }), windowed);
    expect(out).toMatchObject({ kind: 'filled', value: '2026-10-05' });
  });

  it('parses MMDD dtmf', () => {
    expect(dateSlot.dtmf!.parse('1005', ctx)).toEqual({ value: '2026-10-05', display: 'Monday, October 5' });
    expect(dateSlot.dtmf!.parse('1305', ctx)).toBeNull();
  });
});

describe('slot registry', () => {
  it('exposes all five slots', () => {
    expect(Object.keys(SLOTS)).toEqual(['name', 'dob', 'memberId', 'provider', 'date']);
  });
  it('returns the slot specs for a form in priority order', () => {
    expect(slotsFor('cancel').map((s) => s.id)).toEqual(['name', 'dob', 'provider']);
  });
});
