import { describe, expect, it } from 'vitest';
import { buildQuestions, ALWAYS_ON_IDS } from './questions';
import { newSession, setForm } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { SlotContext } from '../domain/slots';

const ctx: SlotContext = { text: 'hi', candidateSpans: [], todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, window: null };

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

  it('includes only the active form slots', () => {
    const q = buildQuestions(setForm(newSession('s', 0), 'cancel'), ctx);
    expect(q).toHaveProperty('provider');
    expect(q).not.toHaveProperty('dateMode');
  });

  it('adds confirmation questions when a confirmation is pending', () => {
    const s = newSession('s', 0);
    s.pendingConfirmation = { target: 'intent', intent: 'cancel' };
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
