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
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_memberId', target: 'memberId' });
    r = say(r.session, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02) });
    expect(r.decision).toMatchObject({
      kind: 'prompt', promptId: 'date_narrow_window', target: 'date', vars: { window: 'next week' }, acks: [],
    });
  });

  it('completes the form and ends the call', () => {
    let r = say(started(), 'cancel with dr patel', {
      intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }),
    });
    r = resolve(r.session, dtmfFrames('44718293')[0]!, null, tc);
    for (const d of dtmfFrames('4718293')) r = resolve(r.session, d, null, tc);
    expect(r.decision).toMatchObject({ kind: 'complete', form: 'cancel', promptId: 'cancel_confirmed' });
    expect(r.frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed","completed":["cancel"]}' });
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
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_memberId' });
    r = say(r.session, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02) });
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

  it('renders play frames when the turn context carries clips, and text otherwise', () => {
    const ctx = { clips: new Map([['greeting.0', 'greeting.0.wav']]), audioBase: 'https://h/audio/' };
    const r = resolve(newSession('s', 0), setupFrame('s'), null, { ...tc, render: ctx });
    expect(r.frames).toEqual([{ type: 'play', source: 'https://h/audio/greeting.0.wav', loop: 1, preemptible: false, interruptible: true }]);
    expect(resolve(newSession('s', 0), setupFrame('s'), null, tc).frames[0]).toEqual({
      type: 'text', token: 'Thanks for calling the clinic. How can I help you today?', last: true, lang: 'en-US', interruptible: true, preemptible: false,
    });
    expect(r.session.lastPromptText).toBe('Thanks for calling the clinic. How can I help you today?');
  });

  describe('member id confirmation', () => {
    const inCancel = () => say(started(), 'cancel my appointment', { intent: choice({ cancel: 0.95, none: 0.05 }) }).session;
    const idAnswers = {
      intent: choice({ none: 0.95, cancel: 0.05 }), intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
      containsMemberId: noul(0.95), memberIdComplete: noul(0.95),
      memberIdSpan: choice({ 'four four seven one eight two nine three': 0.9, none: 0.1 }),
    };

    it('asks the caller to confirm a spoken id instead of acking it', () => {
      const r = say(inCancel(), 'four four seven one eight two nine three', idAnswers);
      expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_memberId', target: 'memberId', options: ['yes', 'no'], acks: [] });
      expect(r.session.slots.memberId).toMatchObject({ value: '44718293', confirmed: false });
      expect(r.session.pendingConfirmation).toEqual({ target: 'slot', slot: 'memberId', value: '44718293', display: '4471 8293' });
    });

    it('confirms on yes and moves to the next slot', () => {
      const asked = say(inCancel(), 'four four seven one eight two nine three', idAnswers);
      const r = say(asked.session, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02), intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }) });
      expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider' });
      expect(r.session.slots.memberId.confirmed).toBe(true);
      expect(r.session.pendingConfirmation).toBeNull();
    });

    const declines = { confirmsYes: noul(0.02), confirmsNo: noul(0.95), intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }) };

    it('sends a declined id straight to the keypad, then hands off if that fails too', () => {
      const asked = say(inCancel(), 'four four seven one eight two nine three', idAnswers);
      const no = say(asked.session, 'no', declines);
      expect(no.decision).toMatchObject({
        kind: 'prompt', promptId: 'ask_memberId_dtmf', target: 'memberId',
        acks: [{ promptId: 'ack_declined', vars: {} }],
      });
      expect(no.session.slots.memberId).toMatchObject({ value: null, display: null, confirmed: false, window: null });
      const again = say(no.session, 'um', { intelligible: noul(0.2) });
      expect(again.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
    });

    it('hands off rather than read a third id back when a second one is declined too', () => {
      const asked = say(inCancel(), 'four four seven one eight two nine three', idAnswers);
      const no = say(asked.session, 'no', declines);
      const retry = say(no.session, 'eight one seven nine three three one four', {
        ...idAnswers,
        memberIdSpan: choice({ 'eight one seven nine three three one four': 0.9, none: 0.1 }),
      });
      expect(retry.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_memberId' });
      expect(retry.session.slots.memberId).toMatchObject({ value: '81793314', confirmed: false });
      const no2 = say(retry.session, 'no', declines);
      expect(no2.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
    });

    it('walks an unanswered readback to the keypad and then to an agent', () => {
      const asked = say(inCancel(), 'four four seven one eight two nine three', idAnswers);
      const first = say(asked.session, 'um', { intelligible: noul(0.2) });
      expect(first.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_memberId' });
      const second = say(first.session, 'um', { intelligible: noul(0.2) });
      expect(second.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId_dtmf', target: 'memberId' });
      expect(second.session.slots.memberId).toMatchObject({ value: null, display: null, confirmed: false });
      expect(second.session.pendingConfirmation).toBeNull();
      const third = say(second.session, 'um', { intelligible: noul(0.2) });
      expect(third.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
    });

    it('says the new task out loud when a switch interrupts the readback', () => {
      const asked = say(inCancel(), 'four four seven one eight two nine three', idAnswers);
      const r = say(asked.session, 'actually reschedule it instead', {
        intent: choice({ reschedule: 0.95, cancel: 0.03, none: 0.02 }),
        intentChange: choice({ replacing: 0.9, answering: 0.07, adding: 0.03 }),
      });
      expect(r.session.form).toBe('reschedule');
      expect(r.decision).toMatchObject({
        kind: 'prompt', promptId: 'confirm_memberId',
        acks: [{ promptId: 'ack_intent', vars: { intentLabel: 'reschedule an appointment' } }],
      });
    });

    it('needs no confirmation for keypad digits', () => {
      const asked = say(inCancel(), 'four four seven one eight two nine three', idAnswers);
      let s = asked.session;
      let r;
      for (const f of dtmfFrames('81793314')) { r = resolve(s, f, null, tc); s = r.session; }
      expect(r!.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider' });
      expect(s.slots.memberId).toMatchObject({ value: '81793314', confirmed: true });
      expect(s.pendingConfirmation).toBeNull();
    });
  });
  describe('queue and chain', () => {
    const answering = choice({ answering: 0.95, adding: 0.03, replacing: 0.02 });
    const adding = choice({ adding: 0.9, answering: 0.05, replacing: 0.05 });

    it('queues an added intent, acks it once, re-asks the current slot without counting an attempt, and chains into a handoff after completion', () => {
      const routed = say(started(), 'reschedule with dr chen next tuesday', {
        intent: choice({ reschedule: 0.95, none: 0.05 }), provider: choice({ chen: 0.95, none: 0.05 }),
        dateMode: choice({ weekday: 0.9, none: 0.1 }), dateWeekday: choice({ tuesday: 0.95, none: 0.05 }), dateWeekdayQualifier: choice({ next: 0.9, none: 0.1 }),
      });
      expect(routed.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId' });
      const added = say(routed.session, 'and can i also ask about my bill', { intent: choice({ billing: 0.95, none: 0.05 }), intentChange: adding });
      expect(added.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId', acks: [{ promptId: 'ack_queued', vars: { intentLabel: 'ask about billing' } }] });
      expect(added.session.queued).toEqual(['billing']);
      expect(added.session.slots.memberId.attempts).toBe(0);
      const again = say(added.session, 'and can i also ask about my bill', { intent: choice({ billing: 0.95, none: 0.05 }), intentChange: adding });
      expect(again.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId', acks: [] });
      expect(again.session.queued).toEqual(['billing']);
      let s = again.session;
      let r;
      for (const f of dtmfFrames('44718293')) { r = resolve(s, f, null, tc); s = r.session; }
      expect(r!.decision).toMatchObject({
        kind: 'handoff', reason: 'billing', completed: ['reschedule'],
        acks: [{ promptId: 'reschedule_confirmed' }, { promptId: 'bridge_next', vars: { intentLabel: 'ask about billing' } }],
      });
      expect(s.completed).toEqual(['reschedule']);
      expect(s.ended).toBe(true);
    });

    it('chains into a slot form with the member id carried over and the rest cleared', () => {
      const routed = say(started(), 'cancel with dr chen', { intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ chen: 0.95, none: 0.05 }) });
      const added = say(routed.session, 'also book a new one', { intent: choice({ schedule_new: 0.95, none: 0.05 }), intentChange: adding });
      let s = added.session;
      let r;
      for (const f of dtmfFrames('44718293')) { r = resolve(s, f, null, tc); s = r.session; }
      expect(r!.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider', acks: [{ promptId: 'cancel_confirmed' }, { promptId: 'bridge_next' }] });
      expect(s.form).toBe('schedule_new');
      expect(s.slots.memberId).toMatchObject({ value: '44718293', confirmed: true });
      expect(s.slots.provider.value).toBeNull();
      expect(s.completed).toEqual(['cancel']);
      expect(s.queued).toEqual([]);
    });

    it('starts a queued intent the caller switches to instead of promising it twice', () => {
      const routed = say(started(), 'reschedule with dr chen next tuesday', {
        intent: choice({ reschedule: 0.95, none: 0.05 }), provider: choice({ chen: 0.95, none: 0.05 }),
        dateMode: choice({ weekday: 0.9, none: 0.1 }), dateWeekday: choice({ tuesday: 0.95, none: 0.05 }), dateWeekdayQualifier: choice({ next: 0.9, none: 0.1 }),
      });
      const added = say(routed.session, 'also cancel my appointment', { intent: choice({ cancel: 0.95, none: 0.05 }), intentChange: adding });
      expect(added.session.queued).toEqual(['cancel']);
      const switched = say(added.session, 'actually just cancel it instead', {
        intent: choice({ cancel: 0.95, none: 0.05 }), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }),
      });
      expect(switched.session.form).toBe('cancel');
      expect(switched.session.queued).toEqual([]);
      let s = switched.session;
      let r;
      for (const f of dtmfFrames('44718293')) { r = resolve(s, f, null, tc); s = r.session; }
      expect(r!.decision).toMatchObject({ kind: 'complete', promptId: 'cancel_confirmed', completed: ['cancel'] });
      expect(s.completed).toEqual(['cancel']);
      expect(s.queued).toEqual([]);
    });

    it('runs the forms it can finish before the one that ends the call', () => {
      const routed = say(started(), 'cancel with dr chen', { intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ chen: 0.95, none: 0.05 }) });
      const bill = say(routed.session, 'i also have a billing question', { intent: choice({ billing: 0.95, none: 0.05 }), intentChange: adding });
      const book = say(bill.session, 'and also book a new one', { intent: choice({ schedule_new: 0.95, none: 0.05 }), intentChange: adding });
      expect(book.session.queued).toEqual(['billing', 'schedule_new']);
      let s = book.session;
      let r;
      for (const f of dtmfFrames('44718293')) { r = resolve(s, f, null, tc); s = r.session; }
      expect(r!.decision).toMatchObject({
        kind: 'prompt', promptId: 'ask_provider',
        acks: [{ promptId: 'cancel_confirmed' }, { promptId: 'bridge_next', vars: { intentLabel: 'schedule a new appointment' } }],
      });
      expect(s.form).toBe('schedule_new');
      expect(s.queued).toEqual(['billing']);
    });

    it('hands the unstarted queue to the agent', () => {
      const routed = say(started(), 'cancel with dr chen', { intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ chen: 0.95, none: 0.05 }) });
      const added = say(routed.session, 'also book a new one', { intent: choice({ schedule_new: 0.95, none: 0.05 }), intentChange: adding });
      const human = say(added.session, 'get me a person', { wantsHuman: noul(0.9) });
      expect(human.decision).toMatchObject({ kind: 'handoff', reason: 'live-agent', queued: ['schedule_new'] });
      expect(human.frames.at(-1)).toMatchObject({ type: 'end' });
      const end = human.frames.at(-1)!;
      expect(end.type === 'end' && end.handoffData).toContain('"queued":["schedule_new"]');
    });

    it('bridges without promising a request the caller added on the completing turn', () => {
      const routed = say(started(), 'cancel my appointment', { intent: choice({ cancel: 0.95, none: 0.05 }) });
      let s = routed.session;
      let r;
      for (const f of dtmfFrames('44718293')) { r = resolve(s, f, null, tc); s = r.session; }
      expect(r!.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider' });
      const done = say(s, 'doctor kim, and also i have a billing question', {
        intent: choice({ billing: 0.95, none: 0.05 }), intentChange: adding, provider: choice({ kim: 0.95, none: 0.05 }),
      });
      expect(done.decision).toMatchObject({
        kind: 'handoff', reason: 'billing', completed: ['cancel'],
        acks: [{ promptId: 'cancel_confirmed' }, { promptId: 'bridge_next', vars: { intentLabel: 'ask about billing' } }],
      });
      expect((done.decision as { acks: { promptId: string }[] }).acks).toHaveLength(2);
    });

    it('chains three forms in the order the caller asked for them', () => {
      const routed = say(started(), 'reschedule with dr chen next tuesday', {
        intent: choice({ reschedule: 0.95, none: 0.05 }), provider: choice({ chen: 0.95, none: 0.05 }),
        dateMode: choice({ weekday: 0.9, none: 0.1 }), dateWeekday: choice({ tuesday: 0.95, none: 0.05 }), dateWeekdayQualifier: choice({ next: 0.9, none: 0.1 }),
      });
      const cancel = say(routed.session, 'also cancel my other appointment', { intent: choice({ cancel: 0.95, none: 0.05 }), intentChange: adding });
      const bill = say(cancel.session, 'and i have a question about my bill', { intent: choice({ billing: 0.95, none: 0.05 }), intentChange: adding });
      expect(bill.session.queued).toEqual(['cancel', 'billing']);
      let s = bill.session;
      let r;
      for (const f of dtmfFrames('44718293')) { r = resolve(s, f, null, tc); s = r.session; }
      expect(r!.decision).toMatchObject({
        kind: 'prompt', promptId: 'ask_provider',
        acks: [{ promptId: 'reschedule_confirmed' }, { promptId: 'bridge_next', vars: { intentLabel: 'cancel an appointment' } }],
      });
      expect(s.form).toBe('cancel');
      const last = say(s, 'doctor kim', { intent: choice({ none: 0.95, cancel: 0.05 }), intentChange: answering, provider: choice({ kim: 0.95, none: 0.05 }) });
      expect(last.decision).toMatchObject({
        kind: 'handoff', reason: 'billing', completed: ['reschedule', 'cancel'],
        acks: [{ promptId: 'cancel_confirmed' }, { promptId: 'bridge_next', vars: { intentLabel: 'ask about billing' } }],
      });
      expect(last.session.queued).toEqual([]);
    });

    it('keeps an added intent that arrives while a readback is pending, and re-asks the readback with the ack', () => {
      const inCancel = say(started(), 'cancel my appointment', { intent: choice({ cancel: 0.95, none: 0.05 }) }).session;
      const asked = say(inCancel, 'four four seven one eight two nine three', {
        intent: choice({ none: 0.95, cancel: 0.05 }), intentChange: answering,
        containsMemberId: noul(0.95), memberIdComplete: noul(0.95),
        memberIdSpan: choice({ 'four four seven one eight two nine three': 0.9, none: 0.1 }),
      });
      expect(asked.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_memberId' });
      const added = say(asked.session, 'and can i also ask about my bill', { intent: choice({ billing: 0.95, none: 0.05 }), intentChange: adding, confirmsYes: noul(0.1), confirmsNo: noul(0.1) });
      expect(added.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_memberId', acks: [{ promptId: 'ack_queued' }] });
      expect(added.session.queued).toEqual(['billing']);
      expect(added.session.pendingConfirmation).toMatchObject({ target: 'slot', slot: 'memberId' });
      // Adding a request is not a dodged readback, so it must not walk the caller to the keypad.
      expect(added.session.slots.memberId.attempts).toBe(0);
      const second = say(added.session, 'and i want to book another one too', { intent: choice({ schedule_new: 0.95, none: 0.05 }), intentChange: adding, confirmsYes: noul(0.1), confirmsNo: noul(0.1) });
      expect(second.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_memberId', acks: [{ promptId: 'ack_queued' }] });
      expect(second.session.slots.memberId.attempts).toBe(0);
      expect(second.session.queued).toEqual(['billing', 'schedule_new']);
    });
  });
});
