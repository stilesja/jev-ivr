import { describe, expect, it } from 'vitest';
import { buildTurnState } from './state';
import { newSession, setForm } from './session';

describe('buildTurnState', () => {
  it('buckets numbers, trims history and exposes candidate spans', () => {
    const s = setForm(newSession('s1', 0), 'cancel');
    s.promptedFor = 'memberId';
    s.slots.memberId.attempts = 1;
    s.lastPromptId = 'ask_memberId';
    s.lastPromptText = "What's your member ID?";
    s.history = [1, 2, 3, 4].map((i) => ({ node: `n${i}`, intent: 'none', outcome: 'prompt' }));
    s.caller.priorCalls7d = 2;

    const ts = buildTurnState(s, { text: 'it is four four seven', isFinal: true, dtmf: null }, 45_000);

    expect(ts.turn).toEqual({ attempt: 'second', elapsed: 'under_2m' });
    expect(ts.node).toEqual({ id: 'ask_memberId', promptJustPlayed: "What's your member ID?", options: [] });
    expect(ts.history.map((h) => h.node)).toEqual(['n2', 'n3', 'n4']);
    expect(ts.caller.priorCalls).toBe('several');
    expect(ts.asr).toEqual({ text: 'it is four four seven', isFinal: true, bargeIn: false, dtmf: null });
    expect(ts.candidateSpans).toContain('four four seven');
    expect(ts.slots.memberId).toEqual({ value: null, confirmed: false });
    expect(ts.activeForm).toBe('cancel');
    expect(ts.pendingConfirmation).toBeNull();
  });

  it('exposes the spoken label of the active form', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    expect(buildTurnState(s, { text: 'x', isFinal: true, dtmf: null }, 0).activeFormLabel).toBe('cancel your appointment');
    expect(buildTurnState(newSession('s', 0), { text: 'x', isFinal: true, dtmf: null }, 0).activeFormLabel).toBeNull();
  });

  it('reports a pending slot confirmation by slot and spoken value', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    s.pendingConfirmation = { target: 'slot', slot: 'memberId', value: '44718293', display: '4471 8293' };
    expect(buildTurnState(s, { text: 'x', isFinal: true, dtmf: null }, 0).pendingConfirmation).toEqual({ target: 'memberId', value: '4471 8293' });
  });

  it('shows the transfer offer to the model as what a yes buys', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.pendingConfirmation = { target: 'transfer', attempts: 0 };
    expect(buildTurnState(s, { text: 'yes', isFinal: true, dtmf: null }, 0).pendingConfirmation)
      .toEqual({ target: 'transfer', value: 'connect you to a person' });
  });

  it('shows a form confirmation to the model as the form label', () => {
    const s = newSession('s', 0);
    s.form = 'reschedule';
    s.pendingConfirmation = { target: 'form', form: 'reschedule', attempts: 0 };
    expect(buildTurnState(s, { text: 'yes', isFinal: true, dtmf: null }, 0).pendingConfirmation).toEqual({ target: 'form', value: 'reschedule your appointment' });
  });
});
