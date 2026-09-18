import { describe, expect, it } from 'vitest';
import { formatAnswers, formatGates, formatDecision } from './print';
import { choice, noul, score } from '../testing/answers';
import type { QuestionMap } from '../jev/types';

describe('print', () => {
  it('formats top choices, all score levels and noul values', () => {
    const q: QuestionMap = {
      intent: { type: 'choice', instructions: '', criteria: { a: null, b: null, c: null, d: null } },
      frustration: { type: 'score', instructions: '', levels: [{ label: 'none', description: '' }, { label: 'high', description: '' }] },
      ok: { type: 'noul', instructions: '' },
    };
    const text = formatAnswers(q, {
      intent: choice({ a: 0.5, b: 0.3, c: 0.15, d: 0.05 }),
      frustration: score({ none: 0.9, high: 0.1 }),
      ok: noul(0.42),
    });
    expect(text).toContain('intent');
    expect(text).toContain('a 0.50');
    expect(text).not.toContain('d 0.05');
    expect(text).toContain('none 0.90');
    expect(text).toContain('ok');
    expect(text).toContain('0.42');
  });

  it('formats gate rows with a marker on the deciding gate', () => {
    const text = formatGates([
      { gate: 'addressedToSystem', value: 0.9, threshold: 0.7, passed: true, outcome: 'pass', decided: false },
      { gate: 'intent', value: 0.3, threshold: 0.4, passed: false, outcome: 'failed:none', decided: true },
    ]);
    expect(text).toContain('addressedToSystem');
    expect(text).toMatch(/intent.*0\.30.*0\.40.*FAIL.*failed:none.*<==/);
  });

  it('formats a decision with its spoken text', () => {
    const text = formatDecision(
      { kind: 'prompt', promptId: 'ask_memberId', vars: {}, acks: [], target: 'memberId', options: [] },
      [{ type: 'text', token: "What's your member ID?", last: true, lang: 'en-US', interruptible: true, preemptible: false }],
    );
    expect(text).toContain('prompt ask_memberId');
    expect(text).toContain("What's your member ID?");
  });
});
