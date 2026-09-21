import { describe, expect, it } from 'vitest';
import { newSession, bucketAttempt, bucketElapsed, bucketPriorCalls, missingSlots, currentAttempts, setForm, cloneSession } from './session';
import type { DateWindow } from './extract/date';

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
    (clone.slots.date.window as DateWindow).label = 'changed';
    expect(s.slots.date.window.label).toBe('next_week');
    expect(clone.slots.date.window).not.toBe(s.slots.date.window);
  });

  it('has five slots, including name and dob', () => {
    const s = newSession('s1', 0);
    expect(Object.keys(s.slots).sort()).toEqual(['date', 'dob', 'memberId', 'name', 'provider']);
  });

  it('cloneSession copies a dob partial by value', () => {
    const s = newSession('s1', 0);
    s.slots.dob.window = { kind: 'dob', month: 3, day: 5 };
    const clone = cloneSession(s);
    clone.slots.dob.window = { kind: 'dob', month: 3, day: 6 };
    expect(s.slots.dob.window).toEqual({ kind: 'dob', month: 3, day: 5 });
    expect(clone.slots.dob.window).not.toBe(s.slots.dob.window);
  });

  it('starts with nothing queued or completed and clones both', () => {
    const s = newSession('s', 0);
    expect(s.queued).toEqual([]);
    expect(s.completed).toEqual([]);
    s.queued.push('billing');
    s.completed.push('reschedule');
    const c = cloneSession(s);
    c.queued.push('cancel');
    expect(s.queued).toEqual(['billing']);
    expect(c.completed).toEqual(['reschedule']);
  });

  describe('confirm target', () => {
    it('reports the form confirmation attempts as the current attempts', () => {
      const s = newSession('s', 0);
      s.promptedFor = 'confirm';
      s.pendingConfirmation = { target: 'form', form: 'cancel', attempts: 2 };
      expect(currentAttempts(s)).toBe(2);
      expect(cloneSession(s).pendingConfirmation).toEqual({ target: 'form', form: 'cancel', attempts: 2 });
    });
  });
});
