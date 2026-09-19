import { describe, expect, it } from 'vitest';
import { plan, resolve, type TurnContext } from './turn';
import { newSession, type Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { promptFrame, dtmfFrames, setupFrame, type InterruptFrame } from '../channel/frames';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap } from '../jev/types';

const tc: TurnContext = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS } };

function answers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    provider: choice({ none: 0.95, chen: 0.05 }),
    containsMemberId: noul(0.05),
    dateMode: choice({ none: 0.95, window: 0.05 }),
    ...over,
  };
}

function started(): Session {
  return resolve(newSession('s', 0), setupFrame('s'), null, tc).session;
}

function say(session: Session, text: string, over: AnswerMap) {
  const event = promptFrame(text);
  const p = plan(session, event, tc);
  expect(p.needsModel).toBe(true);
  return resolve(session, event, answers(over), tc);
}

describe('turn', () => {
  it('greets on setup without a model call', () => {
    const p = plan(newSession('s', 0), setupFrame('s'), tc);
    expect(p.needsModel).toBe(false);
    const r = resolve(newSession('s', 0), setupFrame('s'), null, tc);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'greeting', target: 'intent' });
    expect(r.session.lastPromptId).toBe('greeting');
    expect(r.session.turnIndex).toBe(1);
  });

  it('routes an over-answered utterance and asks for the first missing slot with acks', () => {
    const r = say(started(), 'reschedule with dr chen next week', {
      intent: choice({ reschedule: 0.94, cancel: 0.03, none: 0.03 }),
      provider: choice({ chen: 0.91, cheng: 0.05, none: 0.04 }),
      dateMode: choice({ window: 0.9, none: 0.1 }),
      dateWindow: choice({ next_week: 0.88, none: 0.12 }),
    });
    expect(r.session.form).toBe('reschedule');
    expect(r.session.slots.provider.value).toBe('chen');
    expect(r.session.slots.date.window?.label).toBe('next_week');
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId', target: 'memberId', acks: [] });
    expect(r.frames.map((f) => f.type)).toEqual(['text']);
  });

  it('fills a slot from a directed answer and narrows the window next', () => {
    let r = say(started(), 'reschedule with dr chen next week', {
      intent: choice({ reschedule: 0.94, none: 0.06 }),
      provider: choice({ chen: 0.91, none: 0.09 }),
      dateMode: choice({ window: 0.9, none: 0.1 }),
      dateWindow: choice({ next_week: 0.88, none: 0.12 }),
    });
    r = say(r.session, 'four four seven one eight two nine three', {
      containsMemberId: noul(0.95),
      memberIdSpan: choice({ 'four four seven one eight two nine three': 0.9, none: 0.1 }),
      memberIdComplete: noul(0.9),
    });
    expect(r.session.slots.memberId.value).toBe('44718293');
    expect(r.decision).toMatchObject({
      kind: 'prompt', promptId: 'date_narrow_window', target: 'date', vars: { window: 'next week' },
      acks: [{ promptId: 'ack_memberId', vars: { memberId: '4471 8293' } }],
    });
  });

  it('completes the form and ends the call', () => {
    let r = say(started(), 'cancel with dr patel', {
      intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }),
    });
    r = resolve(r.session, dtmfFrames('44718293')[0]!, null, tc);
    for (const d of dtmfFrames('4718293')) r = resolve(r.session, d, null, tc);
    expect(r.decision).toMatchObject({ kind: 'complete', form: 'cancel', promptId: 'cancel_confirmed' });
    expect(r.frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed"}' });
    expect(r.session.ended).toBe(true);
  });

  it('walks the retry policy: open, dtmf menu, then agent', () => {
    let r = say(started(), 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'nomatch_open' });
    r = say(r.session, 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'nomatch_dtmf_menu' });
    expect(r.session.menuActive).toBe(true);
    r = say(r.session, 'blah', { intent: choice({ none: 0.7, other: 0.3 }), menuNumberSaid: choice({ none: 0.9, '1': 0.1 }) });
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('routes a dtmf menu digit', () => {
    let r = say(started(), 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    r = say(r.session, 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    r = resolve(r.session, dtmfFrames('3')[0]!, null, tc);
    expect(r.session.form).toBe('cancel');
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId' });
  });

  it('asks an explicit confirmation and acts on yes', () => {
    let r = say(started(), 'maybe cancel', { intent: choice({ cancel: 0.5, none: 0.5 }) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit', options: ['yes', 'no'] });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'intent', intent: 'cancel' });
    r = say(r.session, 'yes', { confirmsYes: noul(0.9), confirmsNo: noul(0.1) });
    expect(r.session.form).toBe('cancel');
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId' });
  });

  it('re-asks an unanswered confirmation and counts an attempt', () => {
    let r = say(started(), 'maybe cancel', { intent: choice({ cancel: 0.5, none: 0.5 }) });
    r = say(r.session, 'um not sure', { confirmsYes: noul(0.4), confirmsNo: noul(0.4) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit' });
    expect(r.session.intentAttempts).toBe(1);
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'intent', intent: 'cancel' });
  });

  it('does not let a stale mid-form confirmation hijack a later yes', () => {
    let r = say(started(), 'reschedule with dr chen', {
      intent: choice({ reschedule: 0.94, none: 0.06 }),
      provider: choice({ chen: 0.91, none: 0.09 }),
    });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId' });
    r = say(r.session, 'four four seven one eight two nine three', {
      containsMemberId: noul(0.95),
      memberIdSpan: choice({ 'four four seven one eight two nine three': 0.9, none: 0.1 }),
      memberIdComplete: noul(0.9),
    });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_date' });

    r = say(r.session, 'actually cancel', { intent: choice({ cancel: 0.7, none: 0.3 }), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit' });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'intent', intent: 'cancel' });

    r = say(r.session, 'um', { confirmsYes: noul(0.3), confirmsNo: noul(0.3) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit' });
    expect(r.session.form).toBe('reschedule');
    expect(r.session.intentAttempts).toBe(1);

    r = say(r.session, 'no', { confirmsNo: noul(0.9), confirmsYes: noul(0.05) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_date' });
    expect(r.session.pendingConfirmation).toBeNull();
    expect(r.session.form).toBe('reschedule');
  });

  it('counts a wrong menu key as an attempt', () => {
    let r = say(started(), 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    r = say(r.session, 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    r = resolve(r.session, dtmfFrames('9')[0]!, null, tc);
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('handles a client failure once with a hint and twice with a handoff', () => {
    const err = { name: 'JevClientError', message: 'timeout' };
    let r = resolve(started(), promptFrame('hello'), null, tc, err);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'system_slow_dtmf_hint' });
    r = resolve(r.session, promptFrame('hello'), null, tc, err);
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'system-failure' });
  });

  it('traces a gate row for every slot the turn touched', () => {
    const r = say(started(), 'reschedule with dr chen next week', {
      intent: choice({ reschedule: 0.94, none: 0.06 }),
      provider: choice({ chen: 0.91, none: 0.09 }),
      dateMode: choice({ window: 0.9, none: 0.1 }),
      dateWindow: choice({ next_week: 0.88, none: 0.12 }),
    });
    expect(r.rows.find((g) => g.gate === 'slot:provider')).toMatchObject({ outcome: 'filled', passed: true });
    expect(r.rows.find((g) => g.gate === 'slot:date')).toMatchObject({ outcome: 'window', passed: true });
  });

  it('traces a failed mask as an invalid slot row', () => {
    let r = say(started(), 'cancel with dr patel', {
      intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }),
    });
    r = say(r.session, 'four four seven', {
      containsMemberId: noul(0.95),
      memberIdSpan: choice({ 'four four seven': 0.9, none: 0.1 }),
      memberIdComplete: noul(0.9),
    });
    expect(r.rows.find((g) => g.gate === 'slot:memberId')).toMatchObject({ outcome: 'invalid:mask', passed: false, value: null });
  });

  it('traces a dtmf fill as a slot row', () => {
    let r = say(started(), 'cancel with dr patel', {
      intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }),
    });
    for (const d of dtmfFrames('44718293')) r = resolve(r.session, d, null, tc);
    expect(r.rows).toEqual([{ gate: 'slot:memberId', value: null, threshold: null, passed: true, outcome: 'dtmf', decided: false }]);
  });

  it('reports a barge-in to the model on the next prompt turn only', () => {
    const interrupt: InterruptFrame = { type: 'interrupt', utteranceUntilInterrupt: 'wait no', durationUntilInterruptMs: 420 };
    const i = resolve(started(), interrupt, null, tc);
    expect(i.decision).toEqual({ kind: 'ignore' });
    expect(i.session.lastInterrupt).toEqual({ utteranceUntilInterrupt: 'wait no', durationUntilInterruptMs: 420 });
    expect(plan(i.session, promptFrame('cancel with dr patel'), tc).turnState!.asr.bargeIn).toBe(true);

    const r = say(i.session, 'cancel with dr patel', {
      intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }),
    });
    expect(r.turnState!.asr.bargeIn).toBe(true);
    expect(plan(r.session, promptFrame('hello'), tc).turnState!.asr.bargeIn).toBe(false);
  });

  it('ignores side speech without counting an attempt', () => {
    const r = say(started(), 'honey where are the keys', { addressedToSystem: noul(0.1) });
    expect(r.decision).toEqual({ kind: 'ignore' });
    expect(r.session.intentAttempts).toBe(0);
    expect(r.frames).toEqual([]);
  });

  it('fills slots from the confirmed utterance, not from the yes', () => {
    const asked = say(started(), 'maybe cancel it with dr chen', {
      intent: choice({ cancel: 0.97, none: 0.03 }), intentTentative: noul(0.9),
      provider: choice({ chen: 0.95, cheng: 0.03, none: 0.02 }),
    });
    expect(asked.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit' });
    expect(asked.session.form).toBeNull();
    const yes = say(asked.session, 'yes', {
      confirmsYes: noul(0.95), confirmsNo: noul(0.02), intent: choice({ none: 0.95, cancel: 0.05 }),
      provider: choice({ patel: 0.95, chen: 0.03, none: 0.02 }),
    });
    expect(yes.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId' });
    expect(yes.session.form).toBe('cancel');
    expect(yes.session.slots.provider.value).toBe('chen');
  });
});
