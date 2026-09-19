import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runTurn, runCorpusEntry, runScenario, loadScenarios, checkExpectation, outcomeOf, spokenText,
  type Outcome, type Scenario,
} from './runner';
import { summarize } from './metrics';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { CorpusEntry } from '../jev/corpus';
import { newSession } from '../core/session';
import type { TurnResult } from '../core/turn';
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
    expect(outcome).toMatchObject({ decision: 'prompt', promptId: 'confirm_memberId', form: 'cancel' });
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
      { say: 'yes' },
    ],
    expect: { decision: 'complete', promptId: 'cancel_confirmed', form: 'cancel', slots: { memberId: '44718293', provider: 'patel' } },
  };

  it('runs steps and checks the expectation', async () => {
    const r = await runScenario(scenario, opts);
    expect(r.pass).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.runs).toHaveLength(4);
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
        { say: 'yes' },
        { say: 'cancel my appointment with dr patel' },
      ],
      expect: { decision: 'complete' },
    }, opts);
    expect(r.pass).toBe(true);
    expect(r.outcome.decision).toBe('complete');
    expect(r.runs).toHaveLength(4);
  });
});

const outcome: Outcome = {
  id: 'x', decision: 'prompt', promptId: 'ask_memberId', acks: [], reason: null,
  decidedGate: 'intent', verdict: 'route', form: 'cancel',
  slots: { memberId: null, provider: 'patel', date: null }, queued: [],
};

describe('checkExpectation', () => {
  it('passes a fully matching expectation', () => {
    expect(checkExpectation(outcome, {
      decision: 'prompt', promptId: 'ask_memberId', form: 'cancel', slots: { provider: 'patel' }, text: 'member',
    }, 'What is your member ID?')).toEqual([]);
  });

  it('names the field for each kind of mismatch', () => {
    expect(checkExpectation(outcome, { decision: 'complete' }, '')[0]).toMatch(/^decision: expected complete, got prompt/);
    expect(checkExpectation(outcome, { decision: 'prompt', promptId: 'ask_date' }, '')[0]).toMatch(/^promptId: expected ask_date, got ask_memberId/);
    expect(checkExpectation({ ...outcome, decision: 'handoff' }, { decision: 'handoff', reason: 'billing' }, '')[0])
      .toMatch(/^reason: expected billing, got null/);
    expect(checkExpectation(outcome, { decision: 'prompt', form: 'reschedule' }, '')[0]).toMatch(/^form: expected reschedule, got cancel/);
    expect(checkExpectation(outcome, { decision: 'prompt', slots: { memberId: '44718293' } }, '')[0])
      .toMatch(/^slot memberId: expected 44718293, got null/);
  });

  it('quotes both sides when the spoken text does not contain the expectation', () => {
    expect(checkExpectation(outcome, { decision: 'prompt', text: 'member ID' }, 'Which provider?'))
      .toEqual(['text: expected to contain "member ID", got "Which provider?"']);
  });

  it('collects every mismatch, not just the first', () => {
    expect(checkExpectation(outcome, { decision: 'complete', promptId: 'ask_date', form: null }, '')).toHaveLength(3);
  });
});

describe('outcomeOf', () => {
  it('reads a completed turn', async () => {
    const r = await runScenario({
      id: 'done',
      steps: [{ say: 'cancel my appointment with dr patel' }, { say: 'four four seven one eight two nine three' }, { say: 'yes' }],
      expect: { decision: 'complete' },
    }, opts);
    const o = outcomeOf('done', r.runs.at(-1)!.result);
    expect(o).toMatchObject({ id: 'done', decision: 'complete', promptId: 'cancel_confirmed', reason: null, form: 'cancel' });
    expect(o.slots).toEqual({ memberId: '44718293', provider: 'patel', date: null });
  });

  it('reads an ignored turn as having no prompt, gate or verdict', () => {
    const ignored = {
      decision: { kind: 'ignore' } as const,
      rows: [], verdict: null, session: newSession('i', 0), turnState: null, fillEvents: [], frames: [],
    } satisfies TurnResult;
    expect(outcomeOf('i', ignored)).toEqual({
      id: 'i', decision: 'ignore', promptId: null, acks: [], reason: null, decidedGate: null, verdict: null,
      form: null, slots: { memberId: null, provider: null, date: null }, queued: [],
    });
  });
});

describe('spokenText', () => {
  it('joins the text frames of a turn and ignores the end frame', async () => {
    const r = await runScenario({
      id: 'spoken',
      steps: [{ say: 'cancel my appointment with dr patel' }],
      expect: { decision: 'prompt' },
    }, opts);
    const result = r.runs.at(-1)!.result;
    expect(spokenText(result)).toBe(result.frames.filter((f) => f.type === 'text').map((f) => f.token).join(' '));
    expect(spokenText(result)).toContain('member ID');
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
      steps: [{ say: 'cancel my appointment with dr patel' }, { say: 'four four seven one eight two nine three' }, { say: 'yes' }],
      expect: { decision: 'complete' },
    }, opts);
    const records = r.runs.map((x) => x.record);
    const m = summarize(records);
    expect(m.completions).toEqual([{ sessionId: 'cancel-happy', form: 'cancel', turns: 3, baseline: 5 }]);
    // two slots over three utterances: the confirming "yes" fills nothing
    expect(m.slotsFilledPerUtterance).toBeCloseTo(2 / 3, 5);
    expect(m.bySource['stub:fixture']).toBe(2);
    // turn 1 routed at the intent gate; turn 2 proceeded to slot filling with no gate
    // deciding; turn 3 answered the member ID readback at the confirmation gate
    expect(m.byDecidingGate).toEqual({ intent: 1, none: 1, confirmation: 1 });

    const promptRecord = records.find((rec) => rec.event.type === 'prompt')!;
    const ignored = { ...promptRecord, decision: { kind: 'ignore' } as const, frames: [] };
    const withIgnore = summarize([...records, ignored]);
    expect(withIgnore.promptTurns).toBe(m.promptTurns);
    expect(withIgnore.completions).toEqual(m.completions);
  });
});
