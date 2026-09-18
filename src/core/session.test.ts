import { describe, expect, it } from 'vitest';
import { newSession, bucketAttempt, bucketElapsed, bucketPriorCalls, missingSlots, currentAttempts, setForm, cloneSession } from './session';

describe('session', () => {
  it('starts with no form and empty slots', () => {
    const s = newSession('s1', 1000);
    expect(s.form).toBeNull();
    expect(s.slots.memberId).toEqual({ value: null, display: null, confirmed: false, attempts: 0, window: null });
    expect(s.turnIndex).toBe(0);
  });

  it('buckets attempts, elapsed time and prior calls', () => {
    expect(bucketAttempt(0)).toBe('first');
    expect(bucketAttempt(1)).toBe('second');
    expect(bucketAttempt(5)).toBe('third_or_more');
    expect(bucketElapsed(10_000)).toBe('under_30s');
    expect(bucketElapsed(90_000)).toBe('under_2m');
    expect(bucketElapsed(200_000)).toBe('over_2m');
    expect(bucketPriorCalls(0)).toBe('none');
    expect(bucketPriorCalls(1)).toBe('one');
    expect(bucketPriorCalls(3)).toBe('several');
  });

  it('lists missing slots for the active form in priority order', () => {
    const s = setForm(newSession('s1', 0), 'reschedule');
    s.slots.provider.value = 'chen';
    expect(missingSlots(s)).toEqual(['memberId', 'date']);
  });

  it('reports the attempts of whatever was last prompted', () => {
    const s = setForm(newSession('s1', 0), 'cancel');
    s.promptedFor = 'memberId';
    s.slots.memberId.attempts = 2;
    expect(currentAttempts(s)).toBe(2);
    s.promptedFor = 'intent';
    s.intentAttempts = 1;
    expect(currentAttempts(s)).toBe(1);
  });

  it('cloneSession copies slot windows', () => {
    const s = newSession('s1', 0);
    s.slots.date.window = { start: '2026-09-21', end: '2026-09-27', label: 'next_week' };
    const clone = cloneSession(s);
    clone.slots.date.window!.label = 'changed';
    expect(s.slots.date.window.label).toBe('next_week');
    expect(clone.slots.date.window).not.toBe(s.slots.date.window);
  });
});
