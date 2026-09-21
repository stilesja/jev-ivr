import { describe, expect, it } from 'vitest';
import { fillSlots, nextPrompt, pendingSlotConfirmation, retryStep, applyDtmf, slotCtx } from './fia';
import { newSession, setForm, type Session } from './session';
import { DEFAULT_THRESHOLDS, withOverrides } from './thresholds';
import { EXCLUDED_NAME_TOKENS, SLOTS, slotsFor, type SlotContext, type SlotSpec } from '../domain/slots';
import { ALL_SLOTS, FORMS, type SlotId } from '../domain/forms';
import { choice, noul } from '../testing/answers';
import { candidateSpans, candidateWordSpans } from './spans';
import type { DateWindow } from './extract/date';

const T = { ...DEFAULT_THRESHOLDS };
function ctx(text = ''): SlotContext {
  return { text, candidateSpans: candidateSpans(text), candidateWordSpans: candidateWordSpans(text), todayIso: '2026-09-18', thresholds: T, window: null, excludedNameTokens: EXCLUDED_NAME_TOKENS };
}

describe('retryStep', () => {
  it('goes open, dtmf, agent', () => {
    expect(retryStep(1, T)).toBe('open');
    expect(retryStep(2, T)).toBe('dtmf');
    expect(retryStep(3, T)).toBe('agent');
  });

  it('stays monotonic under overrides', () => {
    const t5 = withOverrides({ MAX_ATTEMPTS: 5 });
    expect([1, 2, 3, 4, 5].map((n) => retryStep(n, t5))).toEqual(['open', 'open', 'open', 'dtmf', 'agent']);

    const t2 = withOverrides({ MAX_ATTEMPTS: 2 });
    expect([1, 2].map((n) => retryStep(n, t2))).toEqual(['dtmf', 'agent']);
  });
});

describe('fillSlots', () => {
  it('fills over-answered slots and collects implicit acks', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    const r = fillSlots(s, {
      // 0.47 sits inside the implicit-confirm band [SLOT_CHOICE_CONFIRM, SLOT_CHOICE_FILL); mass is split three ways so `none` is not the argmax
      provider: choice({ chen: 0.47, none: 0.43, okafor: 0.1 }),
      dateMode: choice({ window: 0.9, none: 0.1 }),
      dateWindow: choice({ next_week: 0.88, none: 0.12 }),
      containsMemberId: noul(0.05),
    }, ctx('reschedule with dr chen next week'), slotsFor('reschedule'));
    expect(r.session.slots.provider).toMatchObject({ value: 'chen', confirmed: false });
    expect(r.session.slots.date.window).toEqual({ start: '2026-09-21', end: '2026-09-27', label: 'next_week' });
    expect(r.acks).toEqual([{ promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }]);
    expect(r.progress).toBe(true);
    expect(r.disambiguate).toBeNull();
  });

  it('reports no progress when nothing fills', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    const r = fillSlots(s, { provider: choice({ none: 0.9 }), containsMemberId: noul(0.1) }, ctx('um'), slotsFor('cancel'));
    expect(r.progress).toBe(false);
  });

  it('surfaces a disambiguation', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    const r = fillSlots(s, { provider: choice({ chen: 0.48, cheng: 0.42, none: 0.1 }), containsMemberId: noul(0.1) }, ctx('chen'), slotsFor('cancel'));
    expect(r.disambiguate).toMatchObject({ slot: 'provider', a: { value: 'chen' }, b: { value: 'cheng' } });
    expect(r.progress).toBe(true);
  });

  it('records invalid extraction as no progress with the reason', () => {
    const s = setForm(newSession('s', 0), 'billing');
    const text = 'four four seven';
    const r = fillSlots(s, {
      containsMemberId: noul(0.9), memberIdSpan: choice({ 'four four seven': 0.9, none: 0.1 }), memberIdComplete: noul(0.9),
    }, ctx(text), slotsFor('billing'));
    expect(r.progress).toBe(false);
    expect(r.events).toEqual([{ slot: 'memberId', outcome: { kind: 'invalid', reason: 'mask', raw: '447' } }]);
  });

  it('keeps a confirmed slot confirmed when re-filled with the same value', () => {
    const s = setForm(newSession('s', 0), 'billing');
    s.slots.memberId.value = '44718293';
    s.slots.memberId.confirmed = true;
    const r = fillSlots(s, {
      containsMemberId: noul(0.9), memberIdSpan: choice({ '44718293': 0.9, none: 0.1 }), memberIdComplete: noul(0.9),
    }, ctx('44718293'), slotsFor('billing'));
    expect(r.session.slots.memberId).toMatchObject({ value: '44718293', confirmed: true });
  });

  it('unconfirms a confirmed slot when re-filled with a different value', () => {
    const s = setForm(newSession('s', 0), 'billing');
    s.slots.memberId.value = '44718293';
    s.slots.memberId.confirmed = true;
    const r = fillSlots(s, {
      containsMemberId: noul(0.9), memberIdSpan: choice({ '11112222': 0.9, none: 0.1 }), memberIdComplete: noul(0.9),
    }, ctx('11112222'), slotsFor('billing'));
    expect(r.session.slots.memberId).toMatchObject({ value: '11112222', confirmed: false });
  });
});

describe('one calendar day heard twice', () => {
  /** What the dob questions come back with for a spoken month and day, with or without a year. */
  function dobAnswers(year?: string): Record<string, ReturnType<typeof choice> | ReturnType<typeof noul>> {
    return {
      dobGiven: noul(0.9),
      dobMonth: choice({ march: 0.9, none: 0.1 }),
      dobDay: choice({ '5': 0.9, none: 0.1 }),
      dobYear: year ? choice({ [year]: 0.9, none: 0.1 }) : choice({ none: 0.9 }),
    };
  }

  /** What the date questions come back with when they read the same "march fifth" as a day to be seen on. */
  const dateMarchFifth = {
    dateMode: choice({ absolute: 0.9, none: 0.1 }),
    dateMonth: choice({ march: 0.9, none: 0.1 }),
    dateDay: choice({ '5': 0.9, none: 0.1 }),
  };

  it('drops an appointment date that repeats the birthday the caller was just asked for', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.promptedFor = 'dob';
    const r = fillSlots(s, { ...dobAnswers(), ...dateMarchFifth }, ctx('march fifth'), slotsFor('reschedule'));
    expect(r.session.slots.dob.window).toEqual({ kind: 'dob', month: 3, day: 5 });
    expect(r.session.slots.date).toMatchObject({ value: null, window: null });
    expect(r.events.map((e) => e.slot)).toEqual(['dob']);
  });

  it('drops it when the birthday is complete, year and all', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.promptedFor = 'dob';
    const r = fillSlots(s, { ...dobAnswers('nineteen eighty'), ...dateMarchFifth }, ctx('march fifth nineteen eighty'), slotsFor('reschedule'));
    expect(r.session.slots.dob.value).toBe('1980-03-05');
    expect(r.session.slots.date.value).toBeNull();
  });

  it('drops it when the birthday itself was rejected (a birthday in the future is still a birthday)', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.promptedFor = 'dob';
    const r = fillSlots(s, {
      dobGiven: noul(0.9),
      dobMonth: choice({ december: 0.9, none: 0.1 }),
      dobDay: choice({ '25': 0.9, none: 0.1 }),
      dobYear: choice({ 'twenty thirty': 0.9, none: 0.1 }),
      dateMode: choice({ absolute: 0.9, none: 0.1 }),
      dateMonth: choice({ december: 0.9, none: 0.1 }),
      dateDay: choice({ '25': 0.9, none: 0.1 }),
    }, ctx('december twenty fifth twenty thirty'), slotsFor('reschedule'));
    expect(r.events).toEqual([{ slot: 'dob', outcome: { kind: 'invalid', reason: 'future', raw: '2030-12-25' } }]);
    expect(r.session.slots.date.value).toBeNull();
  });

  it('keeps an appointment date that is a different day (a real over-answer)', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.promptedFor = 'dob';
    const r = fillSlots(s, {
      ...dobAnswers(),
      dateMode: choice({ weekday: 0.9, none: 0.1 }),
      dateWeekday: choice({ tuesday: 0.9, none: 0.1 }),
      dateWeekdayQualifier: choice({ next: 0.9, none: 0.1 }),
    }, ctx('march fifth and i want to come in next tuesday'), slotsFor('reschedule'));
    expect(r.session.slots.dob.window).toEqual({ kind: 'dob', month: 3, day: 5 });
    expect(r.session.slots.date.value).toBe('2026-09-22');
  });

  it('fills the date when the date is what was asked: the prompted slot is the one that wins', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.slots.dob.value = '1980-03-05';
    s.slots.dob.display = 'March 5th, 1980';
    s.promptedFor = 'date';
    const r = fillSlots(s, { ...dobAnswers(), ...dateMarchFifth }, ctx('march fifth'), slotsFor('reschedule'));
    expect(r.session.slots.date.value).toBe('2027-03-05');
    expect(r.session.slots.dob.value).toBe('1980-03-05');
  });

  it('leaves both alone when the prompt was not a slot\'s', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.promptedFor = 'intent';
    const r = fillSlots(s, { ...dobAnswers(), ...dateMarchFifth }, ctx('march fifth'), slotsFor('reschedule'));
    expect(r.session.slots.dob.window).toEqual({ kind: 'dob', month: 3, day: 5 });
    expect(r.session.slots.date.value).toBe('2027-03-05');
  });
});

describe('per-spec context', () => {
  /** A spec that fills nothing; it only records the window it was handed, for inspection. */
  function echoSpec(id: SlotId, seen: Record<string, unknown>): SlotSpec {
    return {
      id,
      spokenConfirm: 'summary',
      questions: () => ({}),
      fill: (_answers, c) => { seen[id] = c.window; return { kind: 'absent' }; },
      display: (v) => v,
    };
  }

  it('slotCtx substitutes only the named slot\'s own pending partial', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.slots.date.window = { start: '2026-09-21', end: '2026-09-27', label: 'next_week' };
    s.slots.memberId.window = { kind: 'dob', month: 3, day: 5 };
    const base = ctx('');
    expect(slotCtx(s, base, 'date').window).toEqual(s.slots.date.window);
    expect(slotCtx(s, base, 'memberId').window).toEqual(s.slots.memberId.window);
    expect(slotCtx(s, base, 'provider').window).toBeNull();
  });

  it('gives each spec in fillSlots its own slot\'s window, never another spec\'s (the Task 1 bug: slotContext always sent the date slot\'s window to every spec)', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.slots.date.window = { start: '2026-09-21', end: '2026-09-27', label: 'next_week' };
    s.slots.dob.window = { kind: 'dob', month: 3, day: 5 };
    const seen: Record<string, unknown> = {};
    // The base context's own window is deliberately wrong-looking (the date window), so this
    // only passes if fillSlots substitutes per spec rather than forwarding the base context.
    const wrongBase = { ...ctx(''), window: s.slots.date.window };
    fillSlots(s, {}, wrongBase, [echoSpec('date', seen), echoSpec('dob', seen)]);
    expect(seen.date).toEqual(s.slots.date.window);
    expect(seen.dob).toEqual(s.slots.dob.window);
    expect(seen.dob).not.toEqual(seen.date);
  });
});

describe('nextPrompt', () => {
  it('asks for the highest-priority missing slot, narrowing a window', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    expect(nextPrompt(s)).toEqual({ kind: 'ask', slot: 'name', window: null });
    s.slots.name.value = 'jason stiles';
    s.slots.dob.value = '1980-03-05';
    s.slots.provider.value = 'chen';
    s.slots.date.window = { start: '2026-09-21', end: '2026-09-27', label: 'next_week' };
    expect(nextPrompt(s)).toEqual({ kind: 'ask', slot: 'date', window: s.slots.date.window });
    s.slots.date.value = '2026-09-22';
    expect(nextPrompt(s)).toEqual({ kind: 'complete' });
  });
});

describe('applyDtmf', () => {
  it('fills the prompted slot once enough digits arrive', () => {
    const s = setForm(newSession('s', 0), 'billing');
    s.promptedFor = 'memberId';
    expect(applyDtmf(s, '4471829', ctx())).toEqual({ kind: 'collecting' });
    expect(applyDtmf(s, '44718293', ctx())).toEqual({ kind: 'filled', slot: 'memberId', display: '4471 8293' });
    expect(s.slots.memberId).toMatchObject({ value: '44718293', confirmed: true });
  });

  it('rejects invalid digits', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    s.promptedFor = 'provider';
    expect(applyDtmf(s, '9', ctx())).toEqual({ kind: 'invalid', slot: 'provider' });
  });

  it('ignores a target not on the active form', () => {
    const s = setForm(newSession('s', 0), 'billing');
    s.promptedFor = 'date';
    expect(applyDtmf(s, '0922', ctx())).toEqual({ kind: 'no_target' });
    expect(s.slots.date).toMatchObject({ value: null, display: null, confirmed: false });
  });

  it('ignores the confirm target (the confirm keypad is handled in turn.ts)', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    s.promptedFor = 'confirm';
    expect(applyDtmf(s, '1', ctx())).toEqual({ kind: 'no_target' });
  });

  it('treats a slot with no dtmf as no_target, distinct from a target that is simply off the form', () => {
    // `name` is on the scheduling forms and has no keypad rung (spec 2026-09-20 2.1), so the
    // requiredSlots gate passes and the missing-`dtmf` branch is what produces the result.
    expect(SLOTS.name.dtmf).toBeUndefined();
    const s = setForm(newSession('s', 0), 'cancel');
    s.promptedFor = 'name';
    expect(FORMS.cancel.slots).toContain('name');
    expect(applyDtmf(s, '1', ctx())).toEqual({ kind: 'no_target' });
  });
});

describe('pendingSlotConfirmation', () => {
  it('owes no readback for a filled, unconfirmed slot: no slot uses the always policy now', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    expect(pendingSlotConfirmation(s)).toBeNull();
    // The member ID is the slot that used to raise one; under the summary policy the final
    // confirm reads it back instead, so it stays silent however it is filled.
    s.slots.memberId = { value: '44718293', display: '4471 8293', confirmed: false, attempts: 0, window: null };
    expect(pendingSlotConfirmation(s)).toBeNull();
    s.slots.provider = { value: 'chen', display: 'Dr. Chen', confirmed: false, attempts: 0, window: null };
    expect(pendingSlotConfirmation(s)).toBeNull();
    for (const id of ALL_SLOTS) expect(SLOTS[id].spokenConfirm, id).not.toBe('always');
  });
});

describe('fillSlots member id policy', () => {
  const answers = {
    containsMemberId: noul(0.95), memberIdComplete: noul(0.95),
    memberIdSpan: choice({ 'four four seven one eight two nine three': 0.9, none: 0.1 }),
  };
  const spoken = ctx('four four seven one eight two nine three');

  it('leaves a spoken member id unconfirmed and silent, for the summary to voice', () => {
    const s = setForm(newSession('s', 0), 'billing');
    const r = fillSlots(s, answers, spoken, slotsFor('billing'));
    expect(r.session.slots.memberId).toMatchObject({ value: '44718293', display: '4471 8293', confirmed: false });
    expect(r.acks).toEqual([]);
  });

  it('keeps a confirmed member id confirmed when the caller repeats it unchanged', () => {
    const s = setForm(newSession('s', 0), 'billing');
    s.slots.memberId = { value: '44718293', display: '4471 8293', confirmed: true, attempts: 0, window: null };
    const r = fillSlots(s, answers, spoken, slotsFor('billing'));
    expect(r.session.slots.memberId.confirmed).toBe(true);
    expect(r.acks).toEqual([]);
  });

  it('fills a summary-policy slot silently: no ack, not confirmed, no readback owed', () => {
    const spec = { ...SLOTS.memberId, spokenConfirm: 'summary' as const };
    // billing, the form that actually carries the member ID: the slot is required there, so the
    // readback assertion below is the policy answering rather than a slot no form asked for.
    const s = setForm(newSession('s', 0), 'billing');
    const r = fillSlots(s, answers, spoken, [spec]);
    expect(r.acks).toEqual([]);
    expect(s.slots.memberId).toMatchObject({ value: '44718293', confirmed: false });
    expect(pendingSlotConfirmation(s)).toBeNull();
  });

  // Contrasts with the summary-policy test above: passing a spec whose spokenConfirm differs from
  // SLOTS.memberId's own 'summary' policy must change fillSlots' behavior, proving it reads the
  // policy off the spec it is given rather than off the global SLOTS registry (the summary-policy
  // test alone would still pass against code that read SLOTS[spec.id].spokenConfirm instead).
  it('fills a by-confidence-policy spec with an implicit ack and stays unconfirmed', () => {
    const spec = { ...SLOTS.memberId, spokenConfirm: 'by-confidence' as const };
    const s = setForm(newSession('s', 0), 'billing');
    const r = fillSlots(s, answers, spoken, [spec]);
    expect(r.acks).toEqual([{ promptId: 'ack_memberId', vars: { memberId: '4471 8293' } }]);
    expect(s.slots.memberId).toMatchObject({ value: '44718293', confirmed: false });
  });
});

describe('fillSlots correcting a filled slot', () => {
  const nextWeek = { dateMode: choice({ window: 0.9, none: 0.1 }), dateWindow: choice({ next_week: 0.9, none: 0.1 }) };
  const filled = (): Session => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.slots.date = { value: '2026-09-22', display: 'Tuesday, September 22', confirmed: true, attempts: 0, window: null };
    return s;
  };

  it('leaves a filled slot alone when a window is named mid-form', () => {
    const s = filled();
    const r = fillSlots(s, nextWeek, ctx('next week'), slotsFor('reschedule'));
    expect(s.slots.date).toMatchObject({ value: '2026-09-22', window: null });
    expect(r.progress).toBe(false);
  });

  it('reopens a filled slot for narrowing when the window corrects a summary', () => {
    const s = filled();
    const r = fillSlots(s, nextWeek, ctx('next week'), slotsFor('reschedule'), { correcting: true });
    expect(s.slots.date).toMatchObject({ value: null, display: null, confirmed: false });
    expect((s.slots.date.window as DateWindow | null)?.label).toBe('next_week');
    expect(r.progress).toBe(true);
  });
});
