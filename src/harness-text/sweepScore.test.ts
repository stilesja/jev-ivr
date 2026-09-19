import { describe, expect, it } from 'vitest';
import { better, flips, scoreOutcomes, type ScoreInput } from './sweepScore';
import type { Outcome } from './runner';
import type { ScenarioOutcome } from './baseline';
import type { TraceRecord } from '../trace/types';
import { CASSETTE_MISS } from '../jev/cassette';

function outcome(id: string, over: Partial<Outcome> = {}): Outcome {
  return { id, decision: 'prompt', promptId: 'ask_memberId', acks: [], reason: null, decidedGate: 'intent', verdict: 'route', form: 'cancel', slots: { memberId: null, provider: null, date: null }, queued: [], ...over };
}
function scenario(id: string, pass: boolean, over: Partial<Outcome> = {}): ScenarioOutcome {
  return { ...outcome(id, over), pass, mismatches: pass ? [] : ['x'] };
}
function record(errorMessage: string | null, text = 'hello'): Pick<TraceRecord, 'error' | 'event' | 'source'> {
  return { error: errorMessage ? { name: 'JevClientError', message: errorMessage } : null, event: { type: 'prompt', voicePrompt: text, lang: 'en-US', last: true }, source: errorMessage ? 'error' : 'recorded' };
}

const base: ScoreInput = {
  expectedCorpus: { a: outcome('a'), b: outcome('b'), c: outcome('c', { form: 'reschedule', promptId: 'ask_memberId' }) },
  expectedScenarios: { s1: scenario('s1', true), s2: scenario('s2', true) },
  actualCorpus: { a: outcome('a'), b: outcome('b', { acks: ['ack_intent'] }), c: outcome('c', { form: 'cancel' }) },
  actualScenarios: { s1: scenario('s1', true, { decidedGate: 'confirmation' }), s2: scenario('s2', false) },
  scenarioRecords: { s1: [record(null)], s2: [record(null)] },
};

describe('scoreOutcomes', () => {
  it('counts decision matches, scenario passes, and cosmetic matches separately', () => {
    const s = scoreOutcomes(base);
    expect(s.corpusMatch).toBe(2);           // a and b (b differs only in acks)
    expect(s.scenarioPass).toBe(1);          // s1
    expect(s.cosmeticMatch).toBe(1);         // a only (b has an extra ack, s1 a different gate, s2 fails)
    expect(s.primary).toBe(3);
    expect(s.secondary).toBe(1);
    expect([...s.matched].sort()).toEqual(['a', 'b', 's1']);
    expect(s.misses).toEqual([]);
  });

  it('excludes a missed scenario from both scores and lists its utterance', () => {
    const s = scoreOutcomes({ ...base, scenarioRecords: { s1: [record(null), record(`${CASSETTE_MISS} abc four four`, 'four four')], s2: [record(null)] } });
    expect(s.scenarioPass).toBe(0);
    expect(s.cosmeticMatch).toBe(1);
    expect(s.misses).toEqual([{ id: 's1', text: 'four four' }]);
    expect(s.matched.has('s1')).toBe(false);
  });

  it('orders by primary then secondary', () => {
    const lo = scoreOutcomes(base);
    const hi = scoreOutcomes({ ...base, actualCorpus: { ...base.actualCorpus, c: outcome('c', { form: 'reschedule' }) } });
    expect(better(hi, lo)).toBe(true);
    expect(better(lo, hi)).toBe(false);
    const tidier = scoreOutcomes({ ...base, actualCorpus: { ...base.actualCorpus, b: outcome('b') } });
    expect(better(tidier, lo)).toBe(true);
    expect(better(lo, lo)).toBe(false);
  });

  it('reports flips as ids gained and lost', () => {
    const before = scoreOutcomes(base);
    const after = scoreOutcomes({ ...base, actualCorpus: { ...base.actualCorpus, a: outcome('a', { form: 'billing' }), c: outcome('c', { form: 'reschedule' }) } });
    expect(flips(before, after)).toEqual({ gained: ['c'], lost: ['a'] });
  });
});
