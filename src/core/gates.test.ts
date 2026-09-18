import { describe, expect, it } from 'vitest';
import { evaluateGates } from './gates';
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

describe('evaluateGates', () => {
  it('ignores side speech', () => {
    const r = run(newSession('s', 0), baseAnswers({ addressedToSystem: noul(0.2) }));
    expect(r.verdict).toEqual({ kind: 'ignore' });
    expect(r.rows.find((g) => g.gate === 'addressedToSystem')).toMatchObject({ passed: false, decided: true, threshold: 0.7 });
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

  it('escalates high frustration on a repeat attempt but not on the first', () => {
    const angry = baseAnswers({ frustration: score({ none: 0.1, mild: 0.2, high: 0.7 }) });
    expect(run(newSession('s', 0), angry).verdict.kind).toBe('route');
    const s = newSession('s', 0);
    s.promptedFor = 'intent';
    s.intentAttempts = 1;
    expect(run(s, angry).verdict).toEqual({ kind: 'handoff', reason: 'frustrated' });
  });

  it('routes silently, with implicit confirm, or with explicit confirm by band', () => {
    expect(run(newSession('s', 0), baseAnswers()).verdict).toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none' });
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.7, none: 0.3 }) })).verdict)
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
    expect(run(s, baseAnswers({ intent: choice({ reschedule: 0.9, none: 0.1 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none' });
  });

  it('resolves a pending explicit confirmation', () => {
    const s = newSession('s', 0);
    s.pendingConfirmation = { target: 'intent', intent: 'cancel' };
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
    expect(run(s, baseAnswers({ intent: choice({ reschedule: 0.7, none: 0.3 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'reschedule', confirm: 'explicit' });
  });

  it('reports an unanswered confirmation when no new intent is expressed', () => {
    const s = newSession('s', 0);
    s.pendingConfirmation = { target: 'intent', intent: 'cancel' };
    const r = run(s, baseAnswers({
      confirmsYes: noul(0.5), confirmsNo: noul(0.5), intent: choice({ none: 0.9, other: 0.1 }),
    }));
    expect(r.verdict).toEqual({ kind: 'confirm_unanswered' });
  });

  it('handles agent and repeat intents', () => {
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ agent: 0.8, none: 0.2 }) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ repeat_prompt: 0.8, none: 0.2 }) })).verdict).toEqual({ kind: 'replay' });
  });
});
