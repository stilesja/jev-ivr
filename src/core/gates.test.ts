import { describe, expect, it } from 'vitest';
import { evaluateGates, frustrationOf } from './gates';
import { newSession, setForm, type Session } from './session';
import { buildTurnState } from './state';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap } from '../jev/types';

const T = { ...DEFAULT_THRESHOLDS };

function baseAnswers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95),
    intelligible: noul(0.95),
    utteranceComplete: noul(0.9),
    wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1),
    confusedByPrompt: noul(0.1),
    spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ reschedule: 0.9, cancel: 0.05, none: 0.05 }),
    ...over,
  };
}

function run(session: Session, answers: AnswerMap, isFinal = true) {
  const ts = buildTurnState(session, { text: 'x', isFinal, dtmf: null }, 0);
  return evaluateGates(session, ts, answers, T);
}

/** Mid-form, with the transfer offer waiting for an answer (spec 2026-09-22 §3). */
function atOffer(): Session {
  const s = setForm(newSession('s', 0), 'reschedule');
  s.pendingConfirmation = { target: 'transfer', attempts: 0 };
  s.promptedFor = 'confirm';
  return s;
}

describe('evaluateGates', () => {
  it('ignores side speech', () => {
    const r = run(newSession('s', 0), baseAnswers({ addressedToSystem: noul(0.2) }));
    expect(r.verdict).toEqual({ kind: 'ignore' });
    expect(r.rows.find((g) => g.gate === 'addressedToSystem')).toMatchObject({ passed: false, decided: true, threshold: DEFAULT_THRESHOLDS.GATE_ADDRESSED });
  });

  it('reprompts on unintelligible text', () => {
    expect(run(newSession('s', 0), baseAnswers({ intelligible: noul(0.2) })).verdict).toEqual({ kind: 'nomatch' });
  });

  it('holds an incomplete partial but only notes an incomplete final', () => {
    expect(run(newSession('s', 0), baseAnswers({ utteranceComplete: noul(0.2) }), false).verdict).toEqual({ kind: 'hold' });
    const r = run(newSession('s', 0), baseAnswers({ utteranceComplete: noul(0.2) }), true);
    expect(r.verdict.kind).toBe('route');
    expect(r.rows.find((g) => g.gate === 'utteranceComplete')?.outcome).toBe('noted');
  });

  it('hands off when the caller wants a human', () => {
    expect(run(newSession('s', 0), baseAnswers({ wantsHuman: noul(0.9) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
  });

  describe('frustration rungs', () => {
    const angry = (over: AnswerMap = {}) => baseAnswers({ frustration: score({ none: 0.1, mild: 0.2, high: 0.7 }), ...over });
    const frustrationRow = (r: ReturnType<typeof run>) => r.rows.find((g) => g.gate === 'frustration');

    it('acknowledges the first frustrated turn, on any attempt', () => {
      const first = run(newSession('s', 0), angry());
      expect(first.verdict).toMatchObject({ kind: 'route', intent: 'reschedule', frustration: 'ack' });
      expect(frustrationRow(first)).toMatchObject({ value: 0.7, threshold: T.GATE_FRUSTRATION_HIGH, passed: true, outcome: 'ack', decided: false });
      // The old rule -- high frustration on a repeated attempt hands off at once -- is gone.
      const s = newSession('s', 0);
      s.promptedFor = 'intent';
      s.intentAttempts = 1;
      expect(run(s, angry()).verdict).toMatchObject({ kind: 'route', frustration: 'ack' });
    });

    it('offers a transfer on the second frustrated turn', () => {
      const s = newSession('s', 0);
      s.frustratedTurns = 1;
      const r = run(s, angry());
      expect(r.verdict).toMatchObject({ kind: 'route', frustration: 'offer' });
      expect(frustrationRow(r)).toMatchObject({ passed: true, outcome: 'offer', decided: false });
    });

    it('hands off on the third frustrated turn', () => {
      const s = newSession('s', 0);
      s.frustratedTurns = 2;
      const r = run(s, angry());
      expect(r.verdict).toEqual({ kind: 'handoff', reason: 'frustrated' });
      expect(frustrationRow(r)).toMatchObject({ passed: false, outcome: 'handoff', decided: true });
    });

    it('hands off on the second frustrated turn when the offer was already declined', () => {
      const s = newSession('s', 0);
      s.frustratedTurns = 1;
      s.transferDeclined = true;
      expect(run(s, angry()).verdict).toEqual({ kind: 'handoff', reason: 'frustrated' });
    });

    it('transfers on the third rung even when the words came through garbled', () => {
      // Gate 2 settles a `nomatch` first and `decide` is first-wins, so the rung has to take the
      // verdict off it: a caller this upset for the third time gets a person either way.
      const s = newSession('s', 0);
      s.frustratedTurns = 2;
      const r = run(s, angry({ intelligible: noul(0.1) }));
      expect(r.verdict).toEqual({ kind: 'handoff', reason: 'frustrated' });
      expect(frustrationRow(r)).toMatchObject({ passed: false, outcome: 'handoff', decided: true });
      // The intelligible row keeps its failure and loses only the credit for the verdict.
      expect(r.rows.find((g) => g.gate === 'intelligible')).toMatchObject({ passed: false, outcome: 'nomatch', decided: false });
    });

    it('does not transfer on an outburst that was not addressed to it, and says so in the row', () => {
      const s = newSession('s', 0);
      s.frustratedTurns = 2;
      const r = run(s, angry({ addressedToSystem: noul(0.1) }));
      expect(r.verdict).toEqual({ kind: 'ignore' });
      expect(frustrationRow(r)).toMatchObject({ passed: true, outcome: 'not_addressed', decided: false });
      // No rung on the verdict is what keeps `frustratedTurns` where it was: side speech is not
      // a turn the caller spent on us.
      expect(frustrationOf(r.verdict)).toBeUndefined();
    });

    it('does not count the turn that answers the offer', () => {
      const s = atOffer();
      s.frustratedTurns = 2;
      const r = run(s, angry({ confirmsYes: noul(0.9), confirmsNo: noul(0.05) }));
      // Counting it would hand off the caller who is telling us, crossly, to keep going.
      expect(r.verdict).toEqual({ kind: 'confirmed' });
      expect(frustrationRow(r)).toMatchObject({ passed: true, outcome: 'pass' });
    });

    it('ignores mild frustration', () => {
      const r = run(newSession('s', 0), baseAnswers({ frustration: score({ none: 0.3, mild: 0.6, high: 0.1 }) }));
      expect(r.verdict).toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none' });
      expect(frustrationRow(r)).toMatchObject({ passed: true, outcome: 'pass' });
    });
  });

  describe('the transfer offer', () => {
    it('confirms on yes and declines on anything else', () => {
      expect(run(atOffer(), baseAnswers({ confirmsYes: noul(0.9), confirmsNo: noul(0.05) })).verdict).toEqual({ kind: 'confirmed' });
      expect(run(atOffer(), baseAnswers({ confirmsYes: noul(0.05), confirmsNo: noul(0.9) })).verdict).toEqual({ kind: 'rejected' });
      // Spec 2026-09-22 §3: an answer that is neither a yes nor a no declines the offer as well,
      // rather than leaving it pending and asking it again.
      const neither = run(atOffer(), baseAnswers({ confirmsYes: noul(0.1), confirmsNo: noul(0.1), intent: choice({ none: 0.9, other: 0.1 }) }));
      expect(neither.verdict).toEqual({ kind: 'rejected' });
      expect(neither.rows.find((g) => g.gate === 'confirmation')).toMatchObject({ outcome: 'rejected', decided: true });
    });

    it('keeps the frustrated reason when the yes also reads as asking for a person', () => {
      // "yes, connect me" trips the wantsHuman gate, which runs before the confirmation gate.
      // The caller is accepting the transfer we offered, so the reason -- and the line that plays
      // with it -- is the frustrated one, not the generic live-agent handoff.
      const s = atOffer();
      s.frustratedTurns = 2;
      const r = run(s, baseAnswers({
        wantsHuman: noul(0.9), confirmsYes: noul(0.9), confirmsNo: noul(0.05),
        frustration: score({ none: 0.1, mild: 0.2, high: 0.7 }),
      }));
      expect(r.verdict).toEqual({ kind: 'handoff', reason: 'frustrated' });
      expect(r.rows.find((g) => g.gate === 'wantsHuman')).toMatchObject({ passed: false, outcome: 'handoff', decided: true });
      // And it is still the turn that answers the offer, so it is not a frustrated turn to count,
      // however crossly it was said: `frustratedTurns` is the turn's own bookkeeping, driven by a
      // rung on the verdict, and the gate passes rather than reaching for a third rung.
      expect(frustrationOf(r.verdict)).toBeUndefined();
      expect(r.rows.find((g) => g.gate === 'frustration')).toMatchObject({ passed: true, outcome: 'pass' });
    });

    it('still hands off as live-agent when no transfer is pending', () => {
      const s = setForm(newSession('s', 0), 'reschedule');
      expect(run(s, baseAnswers({ wantsHuman: noul(0.9) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
    });
  });

  it('routes silently, with implicit confirm, or with explicit confirm by band', () => {
    expect(run(newSession('s', 0), baseAnswers()).verdict).toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none' });
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.65, none: 0.35 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'reschedule', confirm: 'implicit' });
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.5, none: 0.5 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'reschedule', confirm: 'explicit' });
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.3, none: 0.7 }) })).verdict)
      .toEqual({ kind: 'intent_failed' });
  });

  it('disambiguates a narrow margin between two form intents', () => {
    const r = run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.5, cancel: 0.45, none: 0.05 }) }));
    expect(r.verdict).toEqual({ kind: 'disambiguate_intent', a: 'reschedule', b: 'cancel' });
  });

  it('proceeds to slot filling when a form is active and no new intent is expressed', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    expect(run(s, baseAnswers({ intent: choice({ none: 0.9, cancel: 0.1 }) })).verdict).toEqual({ kind: 'proceed' });
  });

  it('switches forms on a confident new intent', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    expect(run(s, baseAnswers({ intent: choice({ reschedule: 0.9, none: 0.1 }), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none' });
  });

  it('resolves a pending explicit confirmation', () => {
    const s = newSession('s', 0);
    s.pendingConfirmation = { target: 'intent', intent: 'cancel', answers: {}, text: '' };
    expect(run(s, baseAnswers({ confirmsYes: noul(0.9), confirmsNo: noul(0.1) })).verdict).toEqual({ kind: 'confirmed' });
    expect(run(s, baseAnswers({ confirmsYes: noul(0.1), confirmsNo: noul(0.9) })).verdict).toEqual({ kind: 'rejected' });
  });

  it('routes a spoken menu number when the menu is active', () => {
    const s = newSession('s', 0);
    s.menuActive = true;
    const r = run(s, baseAnswers({ intent: choice({ none: 0.9, other: 0.1 }), menuNumberSaid: choice({ '3': 0.9, none: 0.1 }) }));
    expect(r.verdict).toEqual({ kind: 'route', intent: 'cancel', confirm: 'none' });
  });

  it('asks to confirm a mid-confidence intent switch', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    expect(run(s, baseAnswers({ intent: choice({ reschedule: 0.7, none: 0.3 }), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'reschedule', confirm: 'explicit' });
  });

  it('reports an unanswered confirmation when no new intent is expressed', () => {
    const s = newSession('s', 0);
    s.pendingConfirmation = { target: 'intent', intent: 'cancel', answers: {}, text: '' };
    const r = run(s, baseAnswers({
      confirmsYes: noul(0.5), confirmsNo: noul(0.5), intent: choice({ none: 0.9, other: 0.1 }),
    }));
    expect(r.verdict).toEqual({ kind: 'confirm_unanswered' });
  });

  it('handles agent and repeat intents', () => {
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ agent: 0.8, none: 0.2 }) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ repeat_prompt: 0.8, none: 0.2 }) })).verdict).toEqual({ kind: 'replay' });
  });
  it('routes a tentative request with an explicit confirm even at full probability', () => {
    const r = run(newSession('s', 0), baseAnswers({ intent: choice({ cancel: 0.98, none: 0.02 }), intentTentative: noul(0.9) }));
    expect(r.verdict).toEqual({ kind: 'route', intent: 'cancel', confirm: 'explicit' });
    expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toBe('route_tentative:cancel');
    expect(r.rows.find((g) => g.gate === 'intentTentative')).toMatchObject({ threshold: DEFAULT_THRESHOLDS.INTENT_TENTATIVE, passed: true, outcome: 'tentative' });
  });

  it('leaves agent and repeat requests alone when tentative', () => {
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ agent: 0.9, none: 0.1 }), intentTentative: noul(0.9) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
  });

  it('still disambiguates a narrow margin when the request is tentative', () => {
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.52, cancel: 0.48 }), intentTentative: noul(0.9) })).verdict)
      .toEqual({ kind: 'disambiguate_intent', a: 'reschedule', b: 'cancel' });
  });

  describe('inside a form', () => {
    const inForm = () => setForm(newSession('s', 0), 'reschedule');

    it('treats a confident different intent as answering when intentChange says so', () => {
      const r = run(inForm(), baseAnswers({ intent: choice({ billing: 0.95, none: 0.05 }), intentChange: choice({ answering: 0.9, adding: 0.05, replacing: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'proceed' });
      expect(r.rows.find((g) => g.gate === 'intentChange')).toMatchObject({ outcome: 'answering', threshold: DEFAULT_THRESHOLDS.INTENT_CHANGE });
    });

    it('queues an added intent', () => {
      const r = run(inForm(), baseAnswers({ intent: choice({ billing: 0.95, none: 0.05 }), intentChange: choice({ adding: 0.85, answering: 0.1, replacing: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'queue', intent: 'billing' });
      expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toBe('queue:billing');
    });

    it('does not queue the active form or a weak intent', () => {
      const same = run(inForm(), baseAnswers({ intent: choice({ reschedule: 0.95, none: 0.05 }), intentChange: choice({ adding: 0.85, answering: 0.1, replacing: 0.05 }) }));
      expect(same.verdict).toEqual({ kind: 'proceed' });
      expect(same.rows.find((g) => g.gate === 'intent')?.outcome).toBe('add_unused:reschedule');
      expect(run(inForm(), baseAnswers({ intent: choice({ billing: 0.5, none: 0.5 }), intentChange: choice({ adding: 0.85, answering: 0.1, replacing: 0.05 }) })).verdict).toEqual({ kind: 'proceed' });
    });

    it('switches on replacing, explicitly when tentative', () => {
      const replacing = choice({ replacing: 0.9, answering: 0.05, adding: 0.05 });
      expect(run(inForm(), baseAnswers({ intent: choice({ cancel: 0.95, none: 0.05 }), intentChange: replacing })).verdict).toEqual({ kind: 'route', intent: 'cancel', confirm: 'none' });
      const r = run(inForm(), baseAnswers({ intent: choice({ cancel: 0.95, none: 0.05 }), intentChange: replacing, intentTentative: noul(0.8) }));
      expect(r.verdict).toEqual({ kind: 'route', intent: 'cancel', confirm: 'explicit' });
      expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toBe('switch_tentative:cancel');
    });

    it('falls back to answering below the change threshold', () => {
      const r = run(inForm(), baseAnswers({ intent: choice({ cancel: 0.95, none: 0.05 }), intentChange: choice({ replacing: 0.5, answering: 0.45, adding: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'proceed' });
      expect(r.rows.find((g) => g.gate === 'intentChange')).toMatchObject({ passed: false, outcome: 'answering:below' });
    });

    it('proceeds on an unrecognized change label', () => {
      const r = run(inForm(), baseAnswers({ intent: choice({ cancel: 0.95, none: 0.05 }), intentChange: choice({ swapping: 0.9, answering: 0.05, replacing: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'proceed' });
      expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toBe('proceed:cancel');
    });

    it('hands off to an agent before the change mode is consulted', () => {
      expect(run(inForm(), baseAnswers({ intent: choice({ agent: 0.9, none: 0.1 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }) })).verdict)
        .toEqual({ kind: 'handoff', reason: 'live-agent' });
    });

    it('still reports an unanswered confirmation when the intent would be queued', () => {
      const s = inForm();
      s.pendingConfirmation = { target: 'intent', intent: 'cancel', answers: {}, text: '' };
      expect(run(s, baseAnswers({
        confirmsYes: noul(0.1), confirmsNo: noul(0.1),
        intent: choice({ billing: 0.95, none: 0.05 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }),
      })).verdict).toEqual({ kind: 'confirm_unanswered', queue: 'billing' });
    });
  });

  describe('form confirmation', () => {
    const pending = (): Session => {
      const s = setForm(newSession('s', 0), 'reschedule');
      s.pendingConfirmation = { target: 'form', form: 'reschedule', attempts: 0 };
      s.promptedFor = 'confirm';
      return s;
    };

    it('confirms on yes and carries an added intent', () => {
      const a = baseAnswers({ confirmsYes: noul(0.9), intent: choice({ billing: 0.9, none: 0.1 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }) });
      expect(run(pending(), a).verdict).toEqual({ kind: 'confirmed', queue: 'billing' });
    });

    it('rejects on no, with the queue when one was added', () => {
      expect(run(pending(), baseAnswers({ confirmsNo: noul(0.9) })).verdict).toEqual({ kind: 'rejected' });
      expect(run(pending(), baseAnswers({
        confirmsNo: noul(0.9), intent: choice({ billing: 0.9, none: 0.1 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }),
      })).verdict).toEqual({ kind: 'rejected', queue: 'billing' });
    });

    it('reopens the named detail when the no says which one is wrong', () => {
      const r = run(pending(), baseAnswers({ confirmsNo: noul(0.9), changeSlot: choice({ provider: 0.9, date: 0.05, memberId: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'change_slot', slot: 'provider' });
      expect(r.rows.find((x) => x.gate === 'changeSlot')).toMatchObject({ outcome: 'change:provider', decided: true });
      expect(r.rows.find((x) => x.gate === 'confirmation')?.decided).toBe(false);
      // The queue still rides along.
      expect(run(pending(), baseAnswers({
        confirmsNo: noul(0.9), changeSlot: choice({ provider: 0.9, date: 0.05, memberId: 0.05 }),
        intent: choice({ billing: 0.9, none: 0.1 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }),
      })).verdict).toEqual({ kind: 'change_slot', slot: 'provider', queue: 'billing' });
    });

    it('stays a plain no when the answer names no detail', () => {
      const r = run(pending(), baseAnswers({ confirmsNo: noul(0.9), changeSlot: choice({ none: 0.9, provider: 0.05, date: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'rejected' });
      expect(r.rows.find((x) => x.gate === 'changeSlot')).toMatchObject({ outcome: 'none', passed: false, decided: false });
      expect(r.rows.find((x) => x.gate === 'confirmation')?.decided).toBe(true);
      // Below the threshold it is a no as well: turn.ts reads the utterance for a value instead.
      expect(run(pending(), baseAnswers({ confirmsNo: noul(0.9), changeSlot: choice({ provider: 0.5, none: 0.5 }) })).verdict).toEqual({ kind: 'rejected' });
    });

    it('names the slot to change when asked what to change', () => {
      const v = run(pending(), baseAnswers({ changeSlot: choice({ date: 0.9, provider: 0.05, memberId: 0.05 }) })).verdict;
      expect(v).toEqual({ kind: 'change_slot', slot: 'date' });
      expect(run(pending(), baseAnswers({ changeSlot: choice({ date: 0.5, none: 0.5 }) })).verdict).toEqual({ kind: 'confirm_unanswered' });
    });

    it('does not honor a changeSlot naming a slot the form does not have', () => {
      const s = setForm(newSession('s', 0), 'cancel');
      s.pendingConfirmation = { target: 'form', form: 'cancel', attempts: 0 };
      s.promptedFor = 'confirm';
      // 'cancel' has no date slot, so a named 'date' must not be honored as a change target.
      expect(run(s, baseAnswers({ changeSlot: choice({ date: 0.9, none: 0.1 }) })).verdict).toEqual({ kind: 'confirm_unanswered' });
    });

    it('carries an added intent onto a change_slot verdict', () => {
      const v = run(pending(), baseAnswers({
        changeSlot: choice({ date: 0.9, none: 0.1 }), intent: choice({ billing: 0.9, none: 0.1 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }),
      })).verdict;
      expect(v).toEqual({ kind: 'change_slot', slot: 'date', queue: 'billing' });
    });

    it('breaks a yes/no tie toward confirmed', () => {
      expect(run(pending(), baseAnswers({ confirmsYes: noul(0.9), confirmsNo: noul(0.9) })).verdict).toEqual({ kind: 'confirmed' });
    });

    it('confirms on yes even when the intent Choice is quiet', () => {
      // The intent gate has no opinion at all here; the summary's yes still decides.
      expect(run(pending(), baseAnswers({ confirmsYes: noul(0.9), intent: choice({ none: 0.9 }) })).verdict).toEqual({ kind: 'confirmed' });
    });

    it('marks the row that actually decided: confirmation for yes/no/unanswered, changeSlot for a named detail', () => {
      const decidedGate = (r: ReturnType<typeof run>): string | undefined => r.rows.find((x) => x.decided)?.gate;
      const intentOutcome = (r: ReturnType<typeof run>): string | undefined => r.rows.find((x) => x.gate === 'intent')?.outcome;

      const yes = run(pending(), baseAnswers({ confirmsYes: noul(0.9) }));
      expect(decidedGate(yes)).toBe('confirmation');
      expect(intentOutcome(yes)).toBe('summary_confirmed:reschedule');
      expect(yes.rows.find((x) => x.gate === 'intent')?.decided).toBe(false);

      const no = run(pending(), baseAnswers({ confirmsNo: noul(0.9) }));
      expect(decidedGate(no)).toBe('confirmation');
      expect(intentOutcome(no)).toBe('summary_rejected:reschedule');

      const unanswered = run(pending(), baseAnswers());
      expect(decidedGate(unanswered)).toBe('confirmation');
      expect(intentOutcome(unanswered)).toBe('summary_confirm_unanswered:reschedule');

      const change = run(pending(), baseAnswers({ changeSlot: choice({ date: 0.9, none: 0.1 }) }));
      expect(decidedGate(change)).toBe('changeSlot');
      expect(intentOutcome(change)).toBe('summary_change_slot:reschedule');
    });

    it('lets a replace, an agent request, or a replay win over the summary', () => {
      expect(run(pending(), baseAnswers({ confirmsYes: noul(0.9), wantsHuman: noul(0.95) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
      expect(run(pending(), baseAnswers({
        intent: choice({ cancel: 0.95, none: 0.05 }), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }),
      })).verdict).toMatchObject({ kind: 'route', intent: 'cancel' });
    });

    it('still decides slot and intent confirmations at the confirm gate', () => {
      const s = setForm(newSession('s', 0), 'cancel');
      s.pendingConfirmation = { target: 'slot', slot: 'memberId', value: '44718293', display: '4471 8293' };
      const r = run(s, baseAnswers({ confirmsYes: noul(0.9) }));
      expect(r.verdict).toEqual({ kind: 'confirmed' });
      expect(r.rows.find((x) => x.gate === 'confirmation')?.decided).toBe(true);
    });
  });

  describe('second intent on the first utterance', () => {
    it('queues a second form intent on a plain route', () => {
      const v = run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.95, none: 0.05 }), secondIntent: choice({ billing: 0.8, none: 0.2 }) })).verdict;
      expect(v).toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none', queue: 'billing' });
    });

    it('ignores it below threshold, when it repeats the main intent, and on a tentative or explicit route', () => {
      expect(run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.95, none: 0.05 }), secondIntent: choice({ billing: 0.5, none: 0.5 }) })).verdict)
        .toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none' });
      expect(run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.95, none: 0.05 }), secondIntent: choice({ reschedule: 0.9, none: 0.1 }) })).verdict)
        .toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none' });
      const r = run(newSession('s', 0), baseAnswers({
        intent: choice({ reschedule: 0.95, none: 0.05 }), intentTentative: noul(0.9), secondIntent: choice({ billing: 0.9, none: 0.1 }),
      }));
      expect(r.verdict).toEqual({ kind: 'route', intent: 'reschedule', confirm: 'explicit' });
      // Named, but the route wasn't plain: logged as deliberately dropped, not silently lost.
      expect(r.rows.find((x) => x.gate === 'secondIntent')).toMatchObject({ outcome: 'ignored:not_plain_route' });
    });
  });
});
