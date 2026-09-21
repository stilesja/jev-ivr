import { describe, expect, it } from 'vitest';
import { buildQuestions, ALWAYS_ON_IDS, CHANGE_SLOT_ORDER } from './questions';
import { newSession, setForm } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { FORM_INTENTS } from '../domain/intents';
import { ALL_SLOTS } from '../domain/forms';
import type { SlotContext } from '../domain/slots';

const ctx: SlotContext = { text: 'hi', candidateSpans: [], candidateWordSpans: [], todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, window: null };

describe('buildQuestions', () => {
  it('always includes the routing, control, caller and guard questions', () => {
    const q = buildQuestions(newSession('s', 0), ctx);
    for (const id of ALWAYS_ON_IDS) expect(q).toHaveProperty(id);
    expect(q.intent!.type).toBe('choice');
    expect(q.frustration!.type).toBe('score');
    expect(q.intelligible!.type).toBe('noul');
  });

  it('includes every slot fragment when no form is active', () => {
    const q = buildQuestions(newSession('s', 0), ctx);
    expect(q).toHaveProperty('containsMemberId');
    expect(q).toHaveProperty('provider');
    expect(q).toHaveProperty('dateMode');
  });

  it('passes each slot its own pending partial into questions(), not the base context\'s window (which is always null from turn.ts)', () => {
    const s = newSession('s', 0);
    s.slots.dob.window = { kind: 'dob', month: 3, day: 5 };
    const q = buildQuestions(s, ctx);
    expect((q.dobYear as { instructions: string }).instructions).toMatch(/asked for the year of their birth/);
  });

  it('includes only the active form slots', () => {
    const q = buildQuestions(setForm(newSession('s', 0), 'cancel'), ctx);
    expect(q).toHaveProperty('provider');
    expect(q).not.toHaveProperty('dateMode');
  });

  it('adds confirmation questions when a confirmation is pending', () => {
    const s = newSession('s', 0);
    s.pendingConfirmation = { target: 'intent', intent: 'cancel', answers: {}, text: '' };
    const q = buildQuestions(s, ctx);
    expect(q).toHaveProperty('confirmsYes');
    expect(q).toHaveProperty('confirmsNo');
  });

  it('adds the menu question when the dtmf menu is active', () => {
    const s = newSession('s', 0);
    s.menuActive = true;
    const q = buildQuestions(s, ctx).menuNumberSaid!;
    expect(q.type).toBe('choice');
    // JS objects always order integer-like string keys ('0'-'5') ascending before
    // non-numeric keys, regardless of insertion order (ECMAScript OrdinaryOwnPropertyKeys).
    // The plan's asserted order ['1','2','3','4','5','0','none'] is therefore unreachable
    // by any object with these literal keys; this reflects the guaranteed runtime order.
    if (q.type === 'choice') expect(Object.keys(q.criteria)).toEqual(['0', '1', '2', '3', '4', '5', 'none']);
  });
});

describe('question redesign', () => {
  it('asks intentTentative always and never intentSecondary', () => {
    const q = buildQuestions(newSession('s', 0), ctx);
    expect(q.intentTentative?.type).toBe('noul');
    expect(q.intentSecondary).toBeUndefined();
    expect(q.intentChange).toBeUndefined();
  });

  it('asks intentChange only inside a form, with answering first', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    const q = buildQuestions(s, ctx);
    expect(q.intentChange?.type).toBe('choice');
    if (q.intentChange?.type === 'choice') expect(Object.keys(q.intentChange.criteria)).toEqual(['answering', 'adding', 'replacing']);
  });

  it('pins every question the model sees outside a form (a diff here re-keys the cassette)', () => {
    expect(buildQuestions(newSession('s', 0), ctx)).toMatchSnapshot();
  });
  it('pins every question the model sees inside a form (a diff here re-keys the cassette)', () => {
    expect(buildQuestions(setForm(newSession('s', 0), 'reschedule'), ctx)).toMatchSnapshot();
  });
  it('pins every question the model sees at the summary (a diff here re-keys the cassette)', () => {
    const s = newSession('s', 0);
    setForm(s, 'reschedule');
    s.pendingConfirmation = { target: 'form', form: 'reschedule', attempts: 0 };
    expect(buildQuestions(s, ctx)).toMatchSnapshot();
  });

  it('asks which detail to change only while a form confirmation is pending', () => {
    const s = newSession('s', 0);
    setForm(s, 'reschedule');
    expect(buildQuestions(s, ctx).changeSlot).toBeUndefined();
    s.pendingConfirmation = { target: 'form', form: 'reschedule', attempts: 0 };
    const q = buildQuestions(s, ctx);
    expect(q.changeSlot?.type).toBe('choice');
    expect(Object.keys((q.changeSlot as { criteria: Record<string, unknown> }).criteria)).toEqual(['provider', 'date', 'memberId', 'none']);
    expect(q.confirmsYes).toBeDefined();
    expect(q.provider).toBeDefined();
    expect(q.dateMode).toBeDefined();
  });

  it('orders every slot a form can have, so no form loses one from the question', () => {
    expect([...CHANGE_SLOT_ORDER].sort()).toEqual([...ALL_SLOTS].sort());
  });

  it('puts name and dob first, ahead of provider, date and memberId', () => {
    expect(CHANGE_SLOT_ORDER).toEqual(['name', 'dob', 'provider', 'date', 'memberId']);
  });

  it('limits changeSlot to the slots on the pending form (cancel has no date)', () => {
    const s = newSession('s', 0);
    setForm(s, 'cancel');
    s.pendingConfirmation = { target: 'form', form: 'cancel', attempts: 0 };
    const q = buildQuestions(s, ctx);
    expect(Object.keys((q.changeSlot as { criteria: Record<string, unknown> }).criteria)).toEqual(['provider', 'memberId', 'none']);
  });

  it('does not ask changeSlot for a slot-target confirmation', () => {
    const s = newSession('s', 0);
    setForm(s, 'cancel');
    s.pendingConfirmation = { target: 'slot', slot: 'memberId', value: '44718293', display: '4471 8293' };
    expect(buildQuestions(s, ctx).changeSlot).toBeUndefined();
  });

  it('asks for a second task only outside a form', () => {
    const s = newSession('s', 0);
    const q = buildQuestions(s, ctx);
    expect(q.secondIntent?.type).toBe('choice');
    expect(Object.keys((q.secondIntent as { criteria: Record<string, unknown> }).criteria)).toEqual([...FORM_INTENTS, 'none']);
    setForm(s, 'reschedule');
    expect(buildQuestions(s, ctx).secondIntent).toBeUndefined();
  });
});
