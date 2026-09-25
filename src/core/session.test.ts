import { describe, expect, it } from 'vitest';
import { newSession, bucketAttempt, bucketElapsed, bucketPriorCalls, missingSlots, currentAttempts, setForm, cloneSession } from './session';
import type { DateWindow } from './extract/date';

describe('session', () => {
  it('starts with no form and empty slots', () => {
    const s = newSession('s1', 1000);
    expect(s.form).toBeNull();
    expect(s.slots.memberId).toEqual({ value: null, display: null, confirmed: false, attempts: 0, window: null, helped: [] });
    expect(s.turnIndex).toBe(0);
  });

  it('starts with no booking, no offer and no daypart', () => {
    const s = newSession('s1', 1000);
    expect(s.existing).toBeNull();
    expect(s.offer).toBeNull();
    expect(s.daypart).toBeNull();
  });

  it('copies an offer and its times when cloning', () => {
    const s = newSession('s1', 0);
    s.offer = { provider: 'chen', date: '2026-09-22', times: ['9:15 AM', '2:45 PM'], index: 1 };
    s.existing = { date: '2026-09-25', time: '10:00 AM' };
    const c = cloneSession(s);
    expect(c.offer).not.toBe(s.offer);
    expect(c.offer!.times).not.toBe(s.offer.times);
    expect(c.offer).toEqual(s.offer);
    expect(c.existing).not.toBe(s.existing);
    expect(c.existing).toEqual(s.existing);
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
    expect(missingSlots(s)).toEqual(['name', 'dob', 'date']);
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

  it('forgets which summary was heard when a form is entered', () => {
    const s = newSession('s', 0);
    s.summaryHeard = 'chen|jason stiles|1980-03-05';
    expect(setForm(s, 'schedule_new').summaryHeard).toBeNull();
  });

  it('cloneSession copies slot windows', () => {
    const s = newSession('s1', 0);
    s.slots.date.window = { start: '2026-09-21', end: '2026-09-27', label: 'next_week' };
    s.slots.provider.helped = ['provider_list'];
    const clone = cloneSession(s);
    (clone.slots.date.window as DateWindow).label = 'changed';
    expect(s.slots.date.window.label).toBe('next_week');
    expect(clone.slots.date.window).not.toBe(s.slots.date.window);
    expect(clone.slots.provider.helped).toEqual(s.slots.provider.helped);
    expect(clone.slots.provider.helped).not.toBe(s.slots.provider.helped);
  });

  it('starts with no frustrated turns and the transfer offer never declined', () => {
    const s = newSession('s1', 0);
    expect(s.frustratedTurns).toBe(0);
    expect(s.transferDeclined).toBe(false);
  });

  it('cloneSession copies the transfer offer, attempts and all, by value', () => {
    const s = newSession('s1', 0);
    s.pendingConfirmation = { target: 'transfer', attempts: 1 };
    s.frustratedTurns = 2;
    const clone = cloneSession(s);
    clone.pendingConfirmation = { target: 'transfer', attempts: 2 };
    clone.frustratedTurns = 3;
    expect(s.pendingConfirmation).toEqual({ target: 'transfer', attempts: 1 });
    expect(s.frustratedTurns).toBe(2);
  });

  it('counts no attempts against the transfer offer', () => {
    const s = newSession('s1', 0);
    s.promptedFor = 'confirm';
    s.pendingConfirmation = { target: 'transfer', attempts: 1 };
    // The offer's own silences are counted on the pending object, not on the intent ladder.
    expect(currentAttempts(s)).toBe(0);
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
