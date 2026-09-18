import { describe, expect, it } from 'vitest';
import { fillSlots, nextPrompt, retryStep, applyDtmf } from './fia';
import { newSession, setForm } from './session';
import { DEFAULT_THRESHOLDS, withOverrides } from './thresholds';
import { slotsFor, type SlotContext } from '../domain/slots';
import { choice, noul } from '../testing/answers';
import { candidateSpans } from './spans';

const T = { ...DEFAULT_THRESHOLDS };
function ctx(text = ''): SlotContext {
  return { text, candidateSpans: candidateSpans(text), todayIso: '2026-09-18', thresholds: T };
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
      provider: choice({ chen: 0.65, none: 0.35 }),
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

describe('nextPrompt', () => {
  it('asks for the highest-priority missing slot, narrowing a window', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    expect(nextPrompt(s)).toEqual({ kind: 'ask', slot: 'memberId', window: null });
    s.slots.memberId.value = '44718293';
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
});
