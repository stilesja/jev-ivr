import { describe, expect, it } from 'vitest';
import { plan, resolve, type TurnContext, type TurnResult } from './turn';
import { newSession, type Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { promptFrame, dtmfFrames, setupFrame, silenceFrame, type InterruptFrame } from '../channel/frames';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap } from '../jev/types';
import { answerHeuristically } from '../jev/heuristicStub';
import { spokenText } from '../prompts/render';
import type { DateWindow } from './extract/date';

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

const ANSWERING = choice({ answering: 0.95, adding: 0.03, replacing: 0.02 });
const NAME_ANSWERS: AnswerMap = { nameGiven: noul(0.95), nameSpan: choice({ 'jason stiles': 0.9, none: 0.1 }) };
const DOB_ANSWERS: AnswerMap = {
  dobGiven: noul(0.95), dobMonth: choice({ march: 0.9 }), dobDay: choice({ '5': 0.9 }),
  dobYear: choice({ 'nineteen eighty': 0.9, none: 0.1 }),
};

function started(): Session {
  return resolve(newSession('s', 0), setupFrame('s'), null, tc).session;
}

function say(session: Session, text: string, over: AnswerMap) {
  const event = promptFrame(text);
  const p = plan(session, event, tc);
  expect(p.needsModel).toBe(true);
  return resolve(session, event, answers(over), tc);
}

/** Says the name, then the birthday: what every scheduling form asks for before its own slots. */
function identify(session: Session) {
  const named = say(session, 'jason stiles', { intentChange: ANSWERING, ...NAME_ANSWERS });
  return say(named.session, 'march fifth nineteen eighty', { intentChange: ANSWERING, ...DOB_ANSWERS });
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
    expect((r.session.slots.date.window as DateWindow | null)?.label).toBe('next_week');
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_name', target: 'name', acks: [] });
    expect(r.frames.map((f) => f.type)).toEqual(['text']);
  });

  it('fills a slot from a directed answer and narrows the window next', () => {
    let r = say(started(), 'reschedule with dr chen next week', {
      intent: choice({ reschedule: 0.94, none: 0.06 }),
      provider: choice({ chen: 0.91, none: 0.09 }),
      dateMode: choice({ window: 0.9, none: 0.1 }),
      dateWindow: choice({ next_week: 0.88, none: 0.12 }),
    });
    r = identify(r.session);
    expect(r.session.slots.name.value).toBe('jason stiles');
    expect(r.session.slots.dob.value).toBe('1980-03-05');
    expect(r.decision).toMatchObject({
      kind: 'prompt', promptId: 'date_narrow_window', target: 'date', vars: { window: 'next week' }, acks: [],
    });
  });

  it('completes the form and ends the call', () => {
    let r = say(started(), 'cancel with dr patel', {
      intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }),
    });
    r = say(r.session, 'jason stiles', { intentChange: ANSWERING, ...NAME_ANSWERS });
    for (const d of dtmfFrames('03051980')) r = resolve(r.session, d, null, tc);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_cancel', target: 'confirm' });
    r = say(r.session, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02) });
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
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_name' });
  });

  it('asks an explicit confirmation and acts on yes', () => {
    let r = say(started(), 'maybe cancel', { intent: choice({ cancel: 0.5, none: 0.5 }) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit', options: ['yes', 'no'] });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'intent', intent: 'cancel' });
    r = say(r.session, 'yes', { confirmsYes: noul(0.9), confirmsNo: noul(0.1) });
    expect(r.session.form).toBe('cancel');
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_name' });
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
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_name' });
    r = identify(r.session);
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
    let r = say(started(), 'i have a question about my bill', { intent: choice({ billing: 0.95, none: 0.05 }) });
    r = say(r.session, 'four four seven', {
      containsMemberId: noul(0.95),
      memberIdSpan: choice({ 'four four seven': 0.9, none: 0.1 }),
      memberIdComplete: noul(0.9),
    });
    expect(r.rows.find((g) => g.gate === 'slot:memberId')).toMatchObject({ outcome: 'invalid:mask', passed: false, value: null });
  });

  it('traces a dtmf fill as a slot row', () => {
    let r = say(started(), 'i have a question about my bill', { intent: choice({ billing: 0.95, none: 0.05 }) });
    for (const d of dtmfFrames('44718293')) r = resolve(r.session, d, null, tc);
    expect(r.rows).toEqual([{ gate: 'slot:memberId', value: null, threshold: null, passed: true, outcome: 'dtmf', decided: false }]);
  });

  it('walks the dob ladder when the answer carries nothing the components can read', () => {
    const nothing = { dobGiven: noul(0.9), dobMonth: choice({ none: 0.9 }), dobDay: choice({ none: 0.9 }), dobYear: choice({ none: 0.9 }) };
    let r = say(started(), 'cancel with dr patel', {
      intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }),
    });
    r = say(r.session, 'jason stiles', { nameGiven: noul(0.95), nameSpan: choice({ 'jason stiles': 0.9, none: 0.1 }) });
    expect(r.decision).toMatchObject({ promptId: 'ask_dob' });

    // No partial pending: the plain retry text, and the attempt is counted.
    r = say(r.session, 'uh let me think', nothing);
    expect(r.decision).toMatchObject({ promptId: 'ask_dob_retry' });
    expect(r.session.slots.dob.attempts).toBe(1);

    // A month and day narrow the slot; the year question is what the caller then fails to answer.
    r = say(r.session, 'march fifth', {
      dobGiven: noul(0.95), dobMonth: choice({ march: 0.9 }), dobDay: choice({ '5': 0.9 }), dobYear: choice({ none: 0.9 }),
    });
    expect(r.decision).toMatchObject({ promptId: 'ask_dob_year' });
    expect(r.session.slots.dob.attempts).toBe(1);

    // The pending partial must not be replayed as progress: the ladder keeps walking.
    r = say(r.session, 'uh let me think', nothing);
    expect(r.decision).toMatchObject({ promptId: 'ask_dob_dtmf' });
    expect(r.session.slots.dob.attempts).toBe(2);
    expect(r.rows.find((g) => g.gate === 'slot:dob')).toBeUndefined();
    r = say(r.session, 'uh let me think', nothing);
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });


  it('counts a repeated dob partial as a failed answer instead of re-asking forever', () => {
    // Month and day with no year: the same outcome the caller's first answer produced, so the
    // slot's pending partial is rebuilt unchanged every time it is said again.
    const marchFifth = {
      dobGiven: noul(0.95), dobMonth: choice({ march: 0.9 }), dobDay: choice({ '5': 0.9 }), dobYear: choice({ none: 0.9 }),
    };
    let r = say(started(), 'cancel with dr patel', {
      intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }),
    });
    r = say(r.session, 'jason stiles', NAME_ANSWERS);
    expect(r.decision).toMatchObject({ promptId: 'ask_dob' });

    // The partial itself is progress: it narrows an empty slot, so no attempt is counted.
    r = say(r.session, 'march fifth', marchFifth);
    expect(r.decision).toMatchObject({ promptId: 'ask_dob_year' });
    expect(r.session.slots.dob.attempts).toBe(0);

    // Repeating it answers the year question with nothing new. failAttempt's open rung re-asks
    // the window question (not ask_dob_retry) because that is what went unanswered -- but the
    // attempt is counted, so the ladder walks to the keypad and then to an agent.
    r = say(r.session, 'march fifth', marchFifth);
    expect(r.decision).toMatchObject({ promptId: 'ask_dob_year' });
    expect(r.session.slots.dob.attempts).toBe(1);

    r = say(r.session, 'march fifth', marchFifth);
    expect(r.decision).toMatchObject({ promptId: 'ask_dob_dtmf' });
    expect(r.session.slots.dob.attempts).toBe(2);

    r = say(r.session, 'march fifth', marchFifth);
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('completes a dob partial when the next answer carries the year alone', () => {
    let r = say(started(), 'cancel with dr patel', {
      intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }),
    });
    r = say(r.session, 'jason stiles', NAME_ANSWERS);
    r = say(r.session, 'march fifth', {
      dobGiven: noul(0.95), dobMonth: choice({ march: 0.9 }), dobDay: choice({ '5': 0.9 }), dobYear: choice({ none: 0.9 }),
    });
    expect(r.decision).toMatchObject({ promptId: 'ask_dob_year' });

    r = say(r.session, 'nineteen eighty', {
      dobGiven: noul(0.95), dobMonth: choice({ none: 0.9 }), dobDay: choice({ none: 0.9 }),
      dobYear: choice({ 'nineteen eighty': 0.9, none: 0.1 }),
    });
    expect(r.session.slots.dob.value).toBe('1980-03-05');
    expect(r.session.slots.dob.attempts).toBe(0);
  });

  it('counts a repeated date window as a failed answer on the narrow question', () => {
    const nextWeek = {
      dateMode: choice({ window: 0.9, none: 0.1 }), dateWindow: choice({ next_week: 0.88, none: 0.12 }),
    };
    let r = say(started(), 'reschedule with dr chen', {
      intent: choice({ reschedule: 0.94, none: 0.06 }), provider: choice({ chen: 0.91, none: 0.09 }),
    });
    r = identify(r.session);
    expect(r.decision).toMatchObject({ promptId: 'ask_date' });

    r = say(r.session, 'next week', { intentChange: ANSWERING, ...nextWeek });
    expect(r.decision).toMatchObject({ promptId: 'date_narrow_window', vars: { window: 'next week' } });
    expect(r.session.slots.date.attempts).toBe(0);

    // "Next week" again narrows nothing: the same window question, but an attempt spent.
    r = say(r.session, 'next week', { intentChange: ANSWERING, ...nextWeek });
    expect(r.decision).toMatchObject({ promptId: 'date_narrow_window', vars: { window: 'next week' } });
    expect(r.session.slots.date.attempts).toBe(1);
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
    expect(yes.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_name' });
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

  describe('member id', () => {
    const inBilling = () => say(started(), 'i have a question about my bill', { intent: choice({ billing: 0.95, none: 0.05 }) }).session;
    const idAnswers = {
      intent: choice({ none: 0.95, cancel: 0.05 }), intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
      containsMemberId: noul(0.95), memberIdComplete: noul(0.95),
      memberIdSpan: choice({ 'four four seven one eight two nine three': 0.9, none: 0.1 }),
    };

    it('fills a spoken id silently and hands the form off with nothing else to ask', () => {
      const r = say(inBilling(), 'four four seven one eight two nine three', idAnswers);
      expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'billing', acks: [] });
      // Never read back: billing hands off instead of asking a summary.
      expect(r.session.slots.memberId).toMatchObject({ value: '44718293', confirmed: false });
      expect(r.session.pendingConfirmation).toBeNull();
    });

    it('says the new task out loud when a switch follows the id', () => {
      // Said before the form hands off, so the switch lands on a billing form that has its ID.
      const asked = say(inBilling(), 'actually reschedule it instead', {
        intent: choice({ reschedule: 0.95, cancel: 0.03, none: 0.02 }),
        intentChange: choice({ replacing: 0.9, answering: 0.07, adding: 0.03 }),
      });
      expect(asked.session.form).toBe('reschedule');
      expect(asked.decision).toMatchObject({
        kind: 'prompt', promptId: 'ask_name',
        acks: [{ promptId: 'ack_intent', vars: { intentLabel: 'reschedule an appointment' } }],
      });
    });

    it('takes keypad digits as confirmed without a readback', () => {
      let s = inBilling();
      let r;
      for (const f of dtmfFrames('81793314')) { r = resolve(s, f, null, tc); s = r.session; }
      expect(r!.decision).toMatchObject({ kind: 'handoff', reason: 'billing' });
      expect(s.slots.memberId).toMatchObject({ value: '81793314', confirmed: true });
      expect(s.pendingConfirmation).toBeNull();
    });
  });
  describe('queue and chain', () => {
    const answering = choice({ answering: 0.95, adding: 0.03, replacing: 0.02 });
    const adding = choice({ adding: 0.9, answering: 0.05, replacing: 0.05 });

    it('queues an added intent, acks it once, re-asks the current slot without counting an attempt, and bridges into it after completion', () => {
      const routed = say(started(), 'reschedule with dr chen next tuesday', {
        intent: choice({ reschedule: 0.95, none: 0.05 }), provider: choice({ chen: 0.95, none: 0.05 }),
        dateMode: choice({ weekday: 0.9, none: 0.1 }), dateWeekday: choice({ tuesday: 0.95, none: 0.05 }), dateWeekdayQualifier: choice({ next: 0.9, none: 0.1 }),
      });
      expect(routed.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_name' });
      const added = say(routed.session, 'and can i also ask about my bill', { intent: choice({ billing: 0.95, none: 0.05 }), intentChange: adding });
      expect(added.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_name', acks: [{ promptId: 'ack_queued', vars: { intentLabel: 'ask about billing' } }] });
      expect(added.session.queued).toEqual(['billing']);
      expect(added.session.slots.name.attempts).toBe(0);
      const again = say(added.session, 'and can i also ask about my bill', { intent: choice({ billing: 0.95, none: 0.05 }), intentChange: adding });
      expect(again.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_name', acks: [] });
      expect(again.session.queued).toEqual(['billing']);
      let r = identify(again.session);
      let s = r.session;
      expect(r!.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule', target: 'confirm' });
      r = say(s, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02), intentChange: answering });
      s = r.session;
      // Billing asks for the member ID itself: a scheduling form leaves none behind to carry over.
      expect(r!.decision).toMatchObject({
        kind: 'prompt', promptId: 'ask_memberId',
        acks: [{ promptId: 'reschedule_confirmed' }, { promptId: 'bridge_next', vars: { intentLabel: 'ask about billing' } }],
      });
      expect(s.form).toBe('billing');
      expect(s.completed).toEqual(['reschedule']);
      expect(s.ended).toBe(false);
    });

    it('chains into a slot form with the name and birthday carried over and the rest cleared', () => {
      const routed = say(started(), 'cancel with dr chen', { intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ chen: 0.95, none: 0.05 }) });
      const added = say(routed.session, 'also book a new one', { intent: choice({ schedule_new: 0.95, none: 0.05 }), intentChange: adding });
      let r = identify(added.session);
      let s = r.session;
      expect(r!.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_cancel', target: 'confirm' });
      r = say(s, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02), intentChange: answering });
      s = r.session;
      expect(r!.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider', acks: [{ promptId: 'cancel_confirmed' }, { promptId: 'bridge_next' }] });
      expect(s.form).toBe('schedule_new');
      expect(s.slots.name).toMatchObject({ value: 'jason stiles', confirmed: true });
      expect(s.slots.dob).toMatchObject({ value: '1980-03-05', confirmed: true });
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
      let r = identify(switched.session);
      let s = r.session;
      expect(r!.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_cancel', target: 'confirm' });
      r = say(s, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02), intentChange: answering });
      s = r.session;
      expect(r!.decision).toMatchObject({ kind: 'complete', promptId: 'cancel_confirmed', completed: ['cancel'] });
      expect(s.completed).toEqual(['cancel']);
      expect(s.queued).toEqual([]);
    });

    it('runs the forms it can finish before the one that ends the call', () => {
      const routed = say(started(), 'cancel with dr chen', { intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ chen: 0.95, none: 0.05 }) });
      const bill = say(routed.session, 'i also have a billing question', { intent: choice({ billing: 0.95, none: 0.05 }), intentChange: adding });
      const book = say(bill.session, 'and also book a new one', { intent: choice({ schedule_new: 0.95, none: 0.05 }), intentChange: adding });
      expect(book.session.queued).toEqual(['billing', 'schedule_new']);
      let r = identify(book.session);
      let s = r.session;
      expect(r!.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_cancel', target: 'confirm' });
      r = say(s, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02), intentChange: answering });
      s = r.session;
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
      const r = identify(routed.session);
      const s = r.session;
      expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider' });
      // The last slot and the added request land together, so the summary carries the promise.
      const full = say(s, 'doctor kim, and also i have a billing question', {
        intent: choice({ billing: 0.95, none: 0.05 }), intentChange: adding, provider: choice({ kim: 0.95, none: 0.05 }),
      });
      expect(full.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_cancel', acks: [{ promptId: 'ack_queued' }] });
      const done = say(full.session, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02), intentChange: answering });
      expect(done.decision).toMatchObject({
        kind: 'prompt', promptId: 'ask_memberId',
        acks: [{ promptId: 'cancel_confirmed' }, { promptId: 'bridge_next', vars: { intentLabel: 'ask about billing' } }],
      });
      expect(done.session.completed).toEqual(['cancel']);
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
      let r = identify(bill.session);
      let s = r.session;
      expect(r!.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule', target: 'confirm' });
      r = say(s, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02), intentChange: answering });
      s = r.session;
      expect(r!.decision).toMatchObject({
        kind: 'prompt', promptId: 'ask_provider',
        acks: [{ promptId: 'reschedule_confirmed' }, { promptId: 'bridge_next', vars: { intentLabel: 'cancel an appointment' } }],
      });
      expect(s.form).toBe('cancel');
      const full = say(s, 'doctor kim', { intent: choice({ none: 0.95, cancel: 0.05 }), intentChange: answering, provider: choice({ kim: 0.95, none: 0.05 }) });
      expect(full.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_cancel' });
      const last = say(full.session, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02), intentChange: answering });
      expect(last.decision).toMatchObject({
        kind: 'prompt', promptId: 'ask_memberId',
        acks: [{ promptId: 'cancel_confirmed' }, { promptId: 'bridge_next', vars: { intentLabel: 'ask about billing' } }],
      });
      expect(last.session.completed).toEqual(['reschedule', 'cancel']);
      expect(last.session.queued).toEqual([]);
    });

    it('keeps an added intent that arrives while the summary is pending, and re-asks it with the ack', () => {
      const inCancel = say(started(), 'cancel my appointment with dr patel', {
        intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }),
      }).session;
      const asked = identify(inCancel);
      expect(asked.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_cancel', target: 'confirm' });
      const added = say(asked.session, 'and can i also ask about my bill', { intent: choice({ billing: 0.95, none: 0.05 }), intentChange: adding, confirmsYes: noul(0.1), confirmsNo: noul(0.1) });
      expect(added.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_cancel', acks: [{ promptId: 'ack_queued' }] });
      expect(added.session.queued).toEqual(['billing']);
      expect(added.session.pendingConfirmation).toEqual({ target: 'form', form: 'cancel', attempts: 0 });
      // Adding a request is not a dodged summary, so it must not walk the caller to the keypad.
      const second = say(added.session, 'and i want to book another one too', { intent: choice({ schedule_new: 0.95, none: 0.05 }), intentChange: adding, confirmsYes: noul(0.1), confirmsNo: noul(0.1) });
      expect(second.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_cancel', acks: [{ promptId: 'ack_queued' }] });
      expect(second.session.pendingConfirmation).toEqual({ target: 'form', form: 'cancel', attempts: 0 });
      expect(second.session.queued).toEqual(['billing', 'schedule_new']);
    });
  });
});

/**
 * The final confirm is a conversation, not a single turn, so these drive `resolve` with the
 * heuristic stub over the questions each turn actually asks -- the same answers the text
 * harness would produce -- rather than hand-written distributions per turn.
 */
type Turn = string | { say: string; over: AnswerMap };

function heuristicAnswers(session: Session, text: string, over: AnswerMap): AnswerMap {
  const questions = plan(session, promptFrame(text), tc).questions ?? {};
  const out: AnswerMap = {};
  for (const [id, q] of Object.entries(questions)) out[id] = answerHeuristically(id, q, text.toLowerCase());
  return { ...out, ...over };
}

function heuristicTurn(session: Session, text: string, over: AnswerMap = {}): TurnResult {
  return resolve(session, promptFrame(text), heuristicAnswers(session, text, over), tc);
}

function runTurns(steps: Turn[]): TurnResult[] {
  const out: TurnResult[] = [];
  let session = started();
  for (const step of steps) {
    const r = typeof step === 'string' ? heuristicTurn(session, step) : heuristicTurn(session, step.say, step.over);
    out.push(r);
    session = r.session;
  }
  return out;
}

const afterTurns = (steps: Turn[]): TurnResult => runTurns(steps).at(-1)!;

function afterTurnsAndDtmf(steps: Turn[], digit: string): TurnResult {
  let r = afterTurns(steps);
  for (const f of dtmfFrames(digit)) r = resolve(r.session, f, null, tc);
  return r;
}

function varsOf(decision: TurnResult['decision']): Record<string, string> {
  return 'vars' in decision ? decision.vars : {};
}

/** Reschedule, filled to the last slot: provider and window, the name, the birthday, then the day. */
const HAPPY: Turn[] = [
  'I need to reschedule my appointment with Dr. Chen next week',
  'Jason Stiles',
  'March fifth nineteen eighty',
  'Tuesday',
];

describe('final confirm', () => {
  it('asks the summary instead of completing, with the name and birthday filled silently', () => {
    const turns = runTurns(HAPPY);
    const r = turns.at(-1)!;
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule', target: 'confirm', options: ['yes', 'no'] });
    // The member ID is on the billing form only, so it is the summary's one empty var.
    expect(varsOf(r.decision)).toEqual({ name: 'Jason Stiles', dob: 'March 5th, 1980', memberId: '', provider: 'Dr. Chen', date: 'Tuesday, September 22' });
    expect(r.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 0 });
    // the name and birthday turns asked the next question directly: no readback, no ack
    expect(turns[1]!.decision).toMatchObject({ promptId: 'ask_dob', acks: [] });
    expect(turns[2]!.decision).toMatchObject({ promptId: 'date_narrow_window', acks: [] });
  });

  it('completes on yes with the short completion line and confirmed slots', () => {
    const r = afterTurns([...HAPPY, 'yes']);
    expect(r.decision).toMatchObject({ kind: 'complete', promptId: 'reschedule_confirmed' });
    expect(r.session.slots.name.confirmed).toBe(true);
    expect(r.session.slots.dob.confirmed).toBe(true);
    expect(r.session.slots.provider.confirmed).toBe(true);
    expect(r.session.slots.date.confirmed).toBe(true);
    expect(spokenText(r.decision)).toBe('Your appointment is moved. Goodbye.');
  });

  it('refills a corrected slot from a no and re-asks the summary', () => {
    const r = afterTurns([...HAPPY, 'no, Thursday']);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule' });
    expect(r.session.slots.date.display).toBe('Thursday, September 24');
    expect(r.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 0 });
  });

  it('refills two slots from one correction', () => {
    const r = afterTurns([...HAPPY, 'no, Thursday with Dr. Alvarez']);
    expect(varsOf(r.decision)).toMatchObject({ provider: 'Dr. Alvarez', date: 'Thursday, September 24' });
  });

  it('narrows first when the correction is a window', () => {
    const r = afterTurns([...HAPPY, 'no, next week']);
    expect(r.decision).toMatchObject({ promptId: 'date_narrow_window' });
    expect(r.session.pendingConfirmation).toBeNull();
    expect(afterTurns([...HAPPY, 'no, next week', 'Wednesday']).decision).toMatchObject({ promptId: 'confirm_reschedule' });
  });

  it('asks what to change on a bare no, then reopens the named slot', () => {
    const r = afterTurns([...HAPPY, 'no']);
    expect(r.decision).toMatchObject({ promptId: 'ask_change', target: 'confirm' });
    // The question takes the ladder's first rung, so it is asked once per summary.
    expect(r.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 1, askedChange: true });
    const r2 = afterTurns([...HAPPY, 'no', 'the day']);
    expect(r2.decision).toMatchObject({ promptId: 'ask_date', target: 'date' });
    expect(r2.session.slots.date.value).toBeNull();
    expect(r2.session.pendingConfirmation).toBeNull();
    expect(afterTurns([...HAPPY, 'no', 'the day', 'Friday']).decision).toMatchObject({ promptId: 'confirm_reschedule' });
  });

  it('reads a correction with no "no" in it', () => {
    const r = afterTurns([...HAPPY, 'Thursday']);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule' });
    expect(r.session.slots.date.display).toBe('Thursday, September 24');
    expect(r.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 0 });
  });

  it('takes a value in answer to ask_change, rather than a slot name', () => {
    const r = afterTurns([...HAPPY, 'no', 'Thursday']);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule' });
    expect(varsOf(r.decision)).toMatchObject({ date: 'Thursday, September 24' });
    const done = afterTurns([...HAPPY, 'no', 'Thursday', 'yes']);
    expect(done.decision).toMatchObject({ kind: 'complete', promptId: 'reschedule_confirmed' });
    expect(done.session.slots.date.value).toBe('2026-09-24');
  });

  it('fills the new value when the caller names a detail and replaces it in one breath', () => {
    const r = afterTurns([...HAPPY, 'not that doctor, make it Dr. Alvarez']);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule' });
    expect(varsOf(r.decision)).toMatchObject({ provider: 'Dr. Alvarez', date: 'Tuesday, September 22' });
    expect(r.session.slots.provider.value).toBe('alvarez');
  });

  it('counts every bare no from ask_change on, up to the keypad and an agent', () => {
    const no = (n: number): Turn[] => [...HAPPY, ...Array.from({ length: n }, () => 'no')];
    expect(afterTurns(no(1)).decision).toMatchObject({ promptId: 'ask_change' });
    expect(afterTurns(no(1)).session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 1, askedChange: true });
    expect(afterTurns(no(2)).decision).toMatchObject({ promptId: 'confirm_dtmf' });
    expect(afterTurns(no(3)).decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('still offers ask_change once when the first no follows an unanswered turn', () => {
    const r = afterTurns([...HAPPY, 'what are your hours', 'no']);
    expect(r.decision).toMatchObject({ promptId: 'ask_change' });
    expect(r.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 1, askedChange: true });
    expect(afterTurns([...HAPPY, 'what are your hours', 'no', 'no']).decision).toMatchObject({ promptId: 'confirm_dtmf' });
  });

  it('does not take the value it just read back as a correction', () => {
    // "Tuesday" at the Tuesday summary changes nothing, so it is an unanswered turn, not a reset.
    const again = (n: number): Turn[] => [...HAPPY, ...Array.from({ length: n }, () => 'Tuesday')];
    const first = afterTurns(again(1));
    expect(first.decision).toMatchObject({ promptId: 'confirm_reschedule' });
    expect(first.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 1 });
    expect(afterTurns(again(2)).decision).toMatchObject({ promptId: 'confirm_dtmf' });
    expect(afterTurns(again(3)).decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('counts the turn when the request added to the queue was already on it', () => {
    const adding = { intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }) };
    const bill: Turn = { say: 'and can I also ask about my bill', over: adding };
    const queued = afterTurns([...HAPPY, 'no', bill]);
    // The first one buys the turn: it is a request to keep, not a dodged question.
    expect(queued.decision).toMatchObject({ promptId: 'confirm_reschedule', acks: [{ promptId: 'ack_queued' }] });
    expect(queued.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 1, askedChange: true });
    // Asking for the same thing again adds nothing, so the ladder moves on.
    const r = afterTurns([...HAPPY, 'no', bill, 'no', bill]);
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
    expect(r.session.queued).toEqual(['billing']);
  });

  it('reopens the named detail when the value in the same breath belongs to another one', () => {
    // Not "not that doctor, Thursday": the confirmation gate reads that as a no and takes the
    // correction path, which fills Thursday and re-asks the summary without reopening the doctor.
    const r = afterTurns([...HAPPY, 'the doctor, Thursday']);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider', target: 'provider' });
    expect(r.session.slots.provider).toMatchObject({ value: null, display: null });
    expect(r.session.slots.date.display).toBe('Thursday, September 24');
    expect(r.session.pendingConfirmation).toBeNull();
    // A confidently heard date needs no ack of its own; the next summary reads it back.
    expect(spokenText(r.decision)).toBe('Which provider is the appointment with?');
    // And a new value for the detail they named answers it outright.
    const both = afterTurns([...HAPPY, 'the doctor, Dr. Alvarez']);
    expect(both.decision).toMatchObject({ promptId: 'confirm_reschedule' });
    expect(varsOf(both.decision)).toMatchObject({ provider: 'Dr. Alvarez' });
  });

  it('reopens the detail a no names, instead of asking what to change', () => {
    const r = afterTurns([...HAPPY, 'no, the doctor is wrong']);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider', target: 'provider' });
    expect(r.session.slots.provider).toMatchObject({ value: null, display: null });
    expect(r.session.slots.date.value).toBe('2026-09-22');
    expect(r.session.pendingConfirmation).toBeNull();
    const answered = afterTurns([...HAPPY, 'no, the doctor is wrong', 'Dr. Kim']);
    expect(answered.decision).toMatchObject({ promptId: 'confirm_reschedule' });
    expect(varsOf(answered.decision)).toMatchObject({ provider: 'Dr. Kim', date: 'Tuesday, September 22' });
  });

  it('still corrects, rather than reopens, when the no carries a value instead of a name', () => {
    const r = afterTurns([...HAPPY, 'no, Thursday']);
    expect(r.decision).toMatchObject({ promptId: 'confirm_reschedule' });
    expect(varsOf(r.decision)).toMatchObject({ provider: 'Dr. Chen', date: 'Thursday, September 24' });
  });

  it('reopens the named detail when the caller repeats the value it already holds', () => {
    // "The doctor, Dr. Chen" at a Dr. Chen summary answers nothing: taking it as a correction
    // would re-arm the summary at attempts 0 and let the caller loop there forever.
    const again: Turn[] = [...HAPPY, 'the doctor, Dr. Chen'];
    const first = afterTurns(again);
    expect(first.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider', target: 'provider' });
    expect(first.session.slots.provider).toMatchObject({ value: null, display: null });
    expect(first.session.pendingConfirmation).toBeNull();
    // Answering that question re-arms the summary, and repeating the round reopens the slot again
    // rather than spinning on a summary that never counts a turn.
    const second = afterTurns([...again, 'Dr. Chen', 'the doctor, Dr. Chen']);
    expect(second.decision).toMatchObject({ promptId: 'ask_provider' });
    expect(second.session.pendingConfirmation).toBeNull();
    const third = afterTurns([...again, 'Dr. Chen', 'the doctor, Dr. Chen', 'Dr. Chen', 'the doctor, Dr. Chen']);
    expect(third.decision).toMatchObject({ promptId: 'ask_provider' });
    expect(third.session.slots.provider.value).toBeNull();
  });

  it('corrects the name at the summary', () => {
    const r = afterTurns([...HAPPY, "no, it's Jason Styles"]);
    expect(r.decision).toMatchObject({ promptId: 'confirm_reschedule' });
    expect(varsOf(r.decision)).toMatchObject({ name: 'Jason Styles' });
    expect(r.session.slots.name).toMatchObject({ value: 'jason styles', confirmed: false });
  });

  it('corrects the birthday at the summary', () => {
    const r = afterTurns([...HAPPY, 'no, born March 6th 1980']);
    expect(r.decision).toMatchObject({ promptId: 'confirm_reschedule' });
    expect(varsOf(r.decision)).toMatchObject({ dob: 'March 6th, 1980' });
    expect(r.session.slots.dob).toMatchObject({ value: '1980-03-06', confirmed: false });
  });

  it('walks the unanswered ladder: re-ask, keypad, agent', () => {
    const hours = 'what are your hours';
    const first = afterTurns([...HAPPY, hours]);
    expect(first.decision).toMatchObject({ promptId: 'confirm_reschedule' });
    expect(first.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 1 });
    expect(afterTurns([...HAPPY, hours, hours]).decision).toMatchObject({ promptId: 'confirm_dtmf', target: 'confirm', options: ['1', '2'] });
    expect(afterTurns([...HAPPY, hours, hours, hours]).decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('takes 1 and 2 on the keypad', () => {
    const asked: Turn[] = [...HAPPY, 'what are your hours', 'what are your hours'];
    expect(afterTurnsAndDtmf(asked, '1').decision).toMatchObject({ kind: 'complete', promptId: 'reschedule_confirmed' });
    const two = afterTurnsAndDtmf(asked, '2');
    expect(two.decision).toMatchObject({ promptId: 'ask_change', target: 'confirm' });
    // The keypad's 2 asks the same question as a bare no, and spends it the same way.
    expect(two.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 2, askedChange: true });
    expect(heuristicTurn(two.session, 'no').decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
    // A key that answers neither is a missed turn, and the third one hands off.
    expect(afterTurnsAndDtmf(asked, '5').decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('takes the keypad after a slow turn, which offers it', () => {
    const asked = afterTurns(HAPPY);
    const failed = resolve(asked.session, promptFrame('yes'), null, tc, { name: 'JevClientError', message: 'timeout' });
    expect(failed.decision).toMatchObject({ promptId: 'system_slow_dtmf_hint', target: 'confirm' });
    let r = failed;
    for (const f of dtmfFrames('1')) r = resolve(r.session, f, null, tc);
    expect(r.decision).toMatchObject({ kind: 'complete', promptId: 'reschedule_confirmed' });
  });

  it('ignores the keypad where no keys were offered', () => {
    const atAskChange = afterTurns([...HAPPY, 'no']);
    expect(atAskChange.decision).toMatchObject({ promptId: 'ask_change' });
    const digit = resolve(atAskChange.session, dtmfFrames('1')[0]!, null, tc);
    expect(digit.decision).toEqual({ kind: 'ignore' });
    expect(digit.session.pendingConfirmation).toEqual(atAskChange.session.pendingConfirmation);
    expect(digit.session.lastPromptId).toBe('ask_change');
    expect(digit.session.dtmfBuffer).toBe('');
    expect(digit.session.ended).toBe(false);
  });

  it('queues an added intent on yes and bridges after the completion', () => {
    // The fixture stub answers a corpus entry's labels, not a per-question fallback, so the
    // "adding" label this utterance needs is given directly; the rest is the heuristic's.
    const adding = { intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }) };
    const r = afterTurns([...HAPPY, { say: 'yes, and also my bill', over: adding }]);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId' });
    expect(r.session.completed).toEqual(['reschedule']);
    expect(spokenText(r.decision)).toContain("Now, let's ask about billing.");
  });

  it('re-arms the summary when a switch offered at it is declined', () => {
    const switching: Turn = {
      say: 'actually cancel it instead',
      over: {
        intent: choice({ cancel: 0.7, none: 0.3 }),
        intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }),
      },
    };
    const switched = afterTurns([...HAPPY, switching]);
    expect(switched.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit' });
    expect(switched.session.pendingConfirmation).toMatchObject({ target: 'intent', intent: 'cancel' });
    const no = afterTurns([...HAPPY, switching, 'no']);
    expect(no.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule', target: 'confirm' });
    expect(no.session.form).toBe('reschedule');
    expect(no.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 0 });
  });

  it('hands the agent what the call collected', () => {
    const r = afterTurns([...HAPPY, 'get me a person']);
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'live-agent' });
    expect(r.decision).toMatchObject({ slots: { name: 'Jason Stiles', dob: 'March 5th, 1980', provider: 'Dr. Chen', date: 'Tuesday, September 22' } });
    const end = r.frames.at(-1)!;
    expect(end.type === 'end' && end.handoffData).toContain('"slots":{"name":"Jason Stiles"');
  });

  it('confirms only the slots the completed form asked for', () => {
    // The date is left over from the reschedule the caller abandoned; cancel never read it back.
    const switching: Turn = {
      say: 'actually cancel it instead',
      over: {
        intent: choice({ cancel: 0.95, none: 0.05 }),
        intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }),
      },
    };
    const switched = afterTurns([...HAPPY, switching]);
    expect(switched.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_cancel' });
    // A hedged fill lands unconfirmed; this one was confirmed by the reschedule's own fill, so
    // unset it to stand for that case. Either way the cancel summary never read the date back.
    switched.session.slots.date.confirmed = false;
    const r = heuristicTurn(switched.session, 'yes');
    expect(r.decision).toMatchObject({ kind: 'complete', form: 'cancel' });
    expect(r.session.slots.name.confirmed).toBe(true);
    expect(r.session.slots.dob.confirmed).toBe(true);
    expect(r.session.slots.provider.confirmed).toBe(true);
    expect(r.session.slots.date).toMatchObject({ value: '2026-09-22', confirmed: false });
  });

  it('keeps the summary as the prompt target when the model call fails', () => {
    const asked = afterTurns(HAPPY);
    const r = resolve(asked.session, promptFrame('yes'), null, tc, { name: 'JevClientError', message: 'timeout' });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'system_slow_dtmf_hint', target: 'confirm' });
    expect(r.session.promptedFor).toBe('confirm');
    // The failure is not a dodged summary: the ladder keeps its place.
    expect(r.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 0 });
  });
});

/**
 * Spec no-input §3: a silence event is an unanswered turn on whatever was prompted, resolved
 * without a model call, walking the same ladders as an unintelligible answer with the
 * `no_input` ack in front. `started()` is this file's "after the greeting" helper.
 */
describe('silence', () => {
  it('re-asks the plain intent question on silence (not the nomatch_open apology), then the keypad menu, then hands off', () => {
    const one = resolve(started(), silenceFrame(), null, tc);
    expect(one.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_intent', acks: [{ promptId: 'no_input', vars: {} }] });
    expect(one.session.intentAttempts).toBe(1);
    expect(one.session.history.at(-1)).toMatchObject({ intent: 'silence' });
    const two = resolve(one.session, silenceFrame(), null, tc);
    expect(two.decision).toMatchObject({ promptId: 'nomatch_dtmf_menu', menu: true, acks: [{ promptId: 'no_input', vars: {} }] });
    const three = resolve(two.session, silenceFrame(), null, tc);
    expect(three.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts', acks: [{ promptId: 'no_input', vars: {} }] });
  });

  it('re-asks the explicit intent confirmation on silence, then hands off', () => {
    // A tentative opener puts the intent behind an explicit yes/no rather than a form.
    let r = say(started(), 'maybe reschedule', { intent: choice({ reschedule: 0.5, none: 0.5 }) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit' });
    const one = resolve(r.session, silenceFrame(), null, tc);
    expect(one.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit', acks: [{ promptId: 'no_input', vars: {} }] });
    expect(one.session.intentAttempts).toBe(1);
    const two = resolve(one.session, silenceFrame(), null, tc);
    expect(two.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit', acks: [{ promptId: 'no_input', vars: {} }] });
    expect(two.session.intentAttempts).toBe(2);
    const three = resolve(two.session, silenceFrame(), null, tc);
    expect(three.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts', acks: [{ promptId: 'no_input', vars: {} }] });
  });

  it('re-asks the plain slot question on silence (not the ask_dob_retry apology), then the keypad, and clears a half-typed keypad buffer', () => {
    // At ask_dob: the birthday is the first slot on a scheduling form that has a keypad rung.
    const s = afterTurns(['I need to reschedule my appointment', 'Jason Stiles']).session;
    expect(s.promptedFor).toBe('dob');
    s.dtmfBuffer = '0305';
    const one = resolve(s, silenceFrame(), null, tc);
    expect(one.decision).toMatchObject({ promptId: 'ask_dob', acks: [{ promptId: 'no_input', vars: {} }] });
    expect(one.session.dtmfBuffer).toBe('');
    expect(one.session.slots.dob.attempts).toBe(1);
    const two = resolve(one.session, silenceFrame(), null, tc);
    expect(two.decision).toMatchObject({ promptId: 'ask_dob_dtmf', acks: [{ promptId: 'no_input', vars: {} }] });
  });

  it('re-asks a pending window question on silence, unaffected by the plain-question change since the window branch already ran first', () => {
    const s = afterTurns([...HAPPY, 'no, next week']).session; // date narrowed to a window, not yet answered
    expect(s.promptedFor).toBe('date');
    const r = resolve(s, silenceFrame(), null, tc);
    expect(r.decision).toMatchObject({ promptId: 'date_narrow_window', acks: [{ promptId: 'no_input', vars: {} }] });
  });

  it('walks the summary ladder', () => {
    const s = afterTurns(HAPPY).session; // at confirm_reschedule
    const one = resolve(s, silenceFrame(), null, tc);
    expect(one.decision).toMatchObject({ promptId: 'confirm_reschedule', target: 'confirm', acks: [{ promptId: 'no_input', vars: {} }] });
    expect(one.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 1 });
    const two = resolve(one.session, silenceFrame(), null, tc);
    expect(two.decision).toMatchObject({ promptId: 'confirm_dtmf' });
    const three = resolve(two.session, silenceFrame(), null, tc);
    expect(three.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  // `ask_change` already spends the summary ladder's first rung, so a silence right after it
  // lands on the keypad offer rather than a second open re-ask of the summary.
  it('silence at ask_change moves straight to the keypad offer', () => {
    const r = afterTurns([...HAPPY, 'no']);
    expect(r.decision).toMatchObject({ promptId: 'ask_change', target: 'confirm' });
    const s = resolve(r.session, silenceFrame(), null, tc);
    expect(s.decision).toMatchObject({ promptId: 'confirm_dtmf', acks: [{ promptId: 'no_input', vars: {} }] });
  });

  // No slot's spokenConfirm policy is `always` in the current domain (date and provider are
  // `by-confidence`, memberId is `summary`), so a silence during a slot readback confirmation
  // (the `pc.target === 'slot'` branch of reaskConfirmation) cannot be driven from a scenario
  // today; there is nothing to add a test for here.

  it('is ignored after the call ended and clears a barge-in marker', () => {
    const done = afterTurns([...HAPPY, 'yes']).session;
    expect(resolve(done, silenceFrame(), null, tc).decision).toEqual({ kind: 'ignore' });
    const s = afterTurns(HAPPY).session;
    s.lastInterrupt = { utteranceUntilInterrupt: 'x', durationUntilInterruptMs: 10 };
    expect(resolve(s, silenceFrame(), null, tc).session.lastInterrupt).toBeNull();
  });

  it('is ignored before anything has been prompted, and leaves history and turnIndex untouched', () => {
    const before = newSession('s', 0);
    const r = resolve(before, silenceFrame(), null, tc);
    expect(r.decision).toEqual({ kind: 'ignore' });
    expect(r.session.turnIndex).toBe(before.turnIndex);
    expect(r.session.history).toHaveLength(before.history.length);
  });

  it('needs no model', () => {
    expect(plan(started(), silenceFrame(), tc).needsModel).toBe(false);
  });
});
