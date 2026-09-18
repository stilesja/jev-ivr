import { describe, expect, it } from 'vitest';
import { runTurn, runCorpusEntry, runScenario, type Scenario } from './runner';
import { summarize } from './metrics';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { CorpusEntry } from '../jev/corpus';
import { newSession } from '../core/session';
import { setupFrame } from '../channel/frames';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

const entries: CorpusEntry[] = [
  { id: 'c1', text: 'cancel my appointment with dr patel', intent: 'cancel', context: 'no_form', slots: { provider: 'patel' } },
  { id: 'm1', text: 'four four seven one eight two nine three', intent: 'none', context: 'cancel',
    slots: { memberId: { span: 'four four seven one eight two nine three', value: '44718293' } } },
];

const opts = {
  client: new FixtureStubClient(entries, { sharpness: 0.9, fallback: new HeuristicStubClient() }),
  thresholds: { ...DEFAULT_THRESHOLDS },
  todayIso: '2026-09-18',
  now: () => 1_000,
};

describe('runTurn', () => {
  it('runs setup without asking the client and returns a trace record', async () => {
    const run = await runTurn(newSession('s', 0), setupFrame('s'), opts);
    expect(run.response).toBeNull();
    expect(run.record.source).toBe('none');
    expect(run.record.decision.kind).toBe('prompt');
  });
});

describe('runCorpusEntry', () => {
  it('runs a first-utterance entry from the greeting', async () => {
    const { outcome } = await runCorpusEntry(entries[0]!, opts);
    expect(outcome).toMatchObject({ id: 'c1', decision: 'prompt', promptId: 'ask_memberId', form: 'cancel', decidedGate: 'intent' });
    expect(outcome.slots.provider).toBe('patel');
  });

  it('runs an in-form entry with the form active and the first slot prompted', async () => {
    const { outcome } = await runCorpusEntry(entries[1]!, opts);
    expect(outcome).toMatchObject({ decision: 'prompt', promptId: 'ask_provider', form: 'cancel' });
    expect(outcome.slots.memberId).toBe('44718293');
  });
});

describe('runScenario', () => {
  const scenario: Scenario = {
    id: 'cancel-happy',
    steps: [
      { say: 'cancel my appointment with dr patel' },
      { say: 'four four seven one eight two nine three' },
    ],
    expect: { decision: 'complete', promptId: 'cancel_confirmed', form: 'cancel', slots: { memberId: '44718293', provider: 'patel' } },
  };

  it('runs steps and checks the expectation', async () => {
    const r = await runScenario(scenario, opts);
    expect(r.pass).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.runs).toHaveLength(3);
  });

  it('injects a failure on a step marked fail', async () => {
    const r = await runScenario({
      id: 'fail-once',
      steps: [{ say: 'cancel my appointment with dr patel', fail: true }],
      expect: { decision: 'prompt', promptId: 'system_slow_dtmf_hint' },
    }, opts);
    expect(r.pass).toBe(true);
  });

  it('reports mismatches', async () => {
    const r = await runScenario({ ...scenario, expect: { decision: 'handoff' } }, opts);
    expect(r.pass).toBe(false);
    expect(r.mismatches[0]).toMatch(/decision/);
  });
});

describe('summarize', () => {
  it('computes completion turns against the baseline and slots per utterance', async () => {
    const r = await runScenario({
      id: 'cancel-happy',
      steps: [{ say: 'cancel my appointment with dr patel' }, { say: 'four four seven one eight two nine three' }],
      expect: { decision: 'complete' },
    }, opts);
    const m = summarize(r.runs.map((x) => x.record));
    expect(m.completions).toEqual([{ sessionId: 'cancel-happy', form: 'cancel', turns: 2, baseline: 5 }]);
    expect(m.slotsFilledPerUtterance).toBeCloseTo(1, 5);
    expect(m.bySource['stub:fixture']).toBe(2);
    // turn 1 routed at the intent gate; turn 2 proceeded to slot filling with no gate deciding
    expect(m.byDecidingGate).toEqual({ intent: 1, none: 1 });
  });
});
