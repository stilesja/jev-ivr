import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTurn, runCorpusEntry, runScenario, loadScenarios, type Scenario } from './runner';
import { summarize } from './metrics';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { CorpusEntry } from '../jev/corpus';
import { newSession } from '../core/session';
import { promptFrame, setupFrame } from '../channel/frames';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import type { JevClient } from '../jev/types';
import type { TraceRecord } from '../trace/types';
import { TraceWriter } from '../trace/writer';

/** Every record a run wrote, read back from a throwaway trace file. */
function traceSink(): { trace: TraceWriter; records: () => TraceRecord[] } {
  const path = join(mkdtempSync(join(tmpdir(), 'trace-')), 'run.jsonl');
  return {
    trace: new TraceWriter(path),
    records: () => readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord),
  };
}

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

  it('rethrows non-client errors', async () => {
    const badClient: JevClient = {
      ask: () => {
        throw new Error('boom');
      },
    };
    await expect(runTurn(newSession('s', 0), promptFrame('hello'), { ...opts, client: badClient })).rejects.toThrow(/boom/);
  });
});

const prompted: CorpusEntry = {
  id: 'd1', text: 'tomorrow', intent: 'none', context: 'reschedule', prompted: 'date',
  slots: { date: { mode: 'relative_day', relativeDay: 'tomorrow' } },
};
const promptedClient = new FixtureStubClient([prompted], { sharpness: 0.9, fallback: new HeuristicStubClient() });

/** The second entry is a trailing-off utterance the complete gate should hold on. */
const partialClient = new FixtureStubClient([
  entries[0]!,
  { id: 'p1', text: 'four four seven one', intent: 'none', context: 'cancel', answers: { utteranceComplete: { noul: 0.25 } } },
], { sharpness: 0.9, fallback: new HeuristicStubClient() });

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

  it('prompts the requested slot for an in-form entry', async () => {
    const { outcome } = await runCorpusEntry(prompted, { ...opts, client: promptedClient });
    expect(outcome.decision).toBe('complete');
    expect(outcome.slots.date).toBe('2026-09-19');
    expect(outcome.slots.memberId).toBe('00000000');
    expect(outcome.slots.provider).toBe('patel');
  });

  it('credits a seeded entry only with what its own utterance fills', async () => {
    const sink = traceSink();
    const { run } = await runCorpusEntry(prompted, { ...opts, client: promptedClient, trace: sink.trace });
    const m = summarize(sink.records());
    expect(run.record.slots.memberId.value).toBe('00000000');
    // the greeting already showed memberId and provider filled, so only the date counts
    expect(m.promptTurns).toBe(1);
    expect(m.slotsFilledPerUtterance).toBeCloseTo(1, 5);
    // a session that started mid-form is not a whole call to compare against the baseline
    expect(m.completions).toEqual([]);
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

  it('sends a partial step as a non-final prompt frame', async () => {
    const r = await runScenario({
      id: 'partial',
      steps: [{ say: 'cancel my appointment with dr patel' }, { say: 'four four seven one', partial: true }],
      expect: { decision: 'hold', form: 'cancel' },
    }, { ...opts, client: partialClient });
    expect(r.mismatches).toEqual([]);
    expect(r.runs.at(-1)!.record.event).toMatchObject({ type: 'prompt', last: false });
  });

  it('checks the spoken text of the last turn', async () => {
    const steps = [{ say: 'cancel my appointment with dr patel' }];
    const ok = await runScenario({ id: 'text-ok', steps, expect: { decision: 'prompt', text: 'member ID' } }, opts);
    expect(ok.mismatches).toEqual([]);
    const bad = await runScenario({ id: 'text-bad', steps, expect: { decision: 'prompt', text: 'not spoken' } }, opts);
    expect(bad.mismatches[0]).toMatch(/text: expected to contain/);
  });

  it('records the ack prompt ids of the final decision', async () => {
    const steps = [{ say: 'cancel my appointment with dr patel' }];
    const silent = await runScenario({ id: 'acks-none', steps, expect: { decision: 'prompt' } }, opts);
    expect(silent.outcome.acks).toEqual([]);

    // an intent in the implicit band is acknowledged before the next prompt
    const implicitClient = new FixtureStubClient(
      [{ ...entries[0]!, answers: { intent: { probabilities: { cancel: 0.7, reschedule: 0.2 } } } }],
      { sharpness: 0.9, fallback: new HeuristicStubClient() },
    );
    const acked = await runScenario({ id: 'acks-implicit', steps, expect: { decision: 'prompt' } }, { ...opts, client: implicitClient });
    expect(acked.outcome.acks).toEqual(['ack_intent']);
  });

  it('reports mismatches', async () => {
    const r = await runScenario({ ...scenario, expect: { decision: 'handoff' } }, opts);
    expect(r.pass).toBe(false);
    expect(r.mismatches[0]).toMatch(/decision/);
  });

  it('stops a scenario after the session ends', async () => {
    const r = await runScenario({
      id: 'cancel-happy-trailing',
      steps: [
        { say: 'cancel my appointment with dr patel' },
        { say: 'four four seven one eight two nine three' },
        { say: 'cancel my appointment with dr patel' },
      ],
      expect: { decision: 'complete' },
    }, opts);
    expect(r.pass).toBe(true);
    expect(r.outcome.decision).toBe('complete');
    expect(r.runs).toHaveLength(3);
  });
});

describe('loadScenarios', () => {
  it('rejects a non-array file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scenarios-'));
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'not-an-array' }));
    expect(() => loadScenarios(dir)).toThrow(/expected an array/);
  });
});

describe('summarize', () => {
  it('computes completion turns against the baseline and slots per utterance', async () => {
    const r = await runScenario({
      id: 'cancel-happy',
      steps: [{ say: 'cancel my appointment with dr patel' }, { say: 'four four seven one eight two nine three' }],
      expect: { decision: 'complete' },
    }, opts);
    const records = r.runs.map((x) => x.record);
    const m = summarize(records);
    expect(m.completions).toEqual([{ sessionId: 'cancel-happy', form: 'cancel', turns: 2, baseline: 5 }]);
    expect(m.slotsFilledPerUtterance).toBeCloseTo(1, 5);
    expect(m.bySource['stub:fixture']).toBe(2);
    // turn 1 routed at the intent gate; turn 2 proceeded to slot filling with no gate deciding
    expect(m.byDecidingGate).toEqual({ intent: 1, none: 1 });

    const promptRecord = records.find((rec) => rec.event.type === 'prompt')!;
    const ignored = { ...promptRecord, decision: { kind: 'ignore' } as const, frames: [] };
    const withIgnore = summarize([...records, ignored]);
    expect(withIgnore.promptTurns).toBe(m.promptTurns);
    expect(withIgnore.completions).toEqual(m.completions);
  });
});
