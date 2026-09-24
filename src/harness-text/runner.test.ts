import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runTurn, runCorpusEntry, runScenario, loadScenarios, checkExpectation, outcomeOf, spokenText, seedCorpusSession,
  type Outcome, type Scenario,
} from './runner';
import { summarize } from './metrics';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { parseCorpus, type CorpusEntry } from '../jev/corpus';
import { newSession } from '../core/session';
import type { TurnResult } from '../core/turn';
import { promptFrame, setupFrame } from '../channel/frames';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import type { JevClient } from '../jev/types';
import type { TraceRecord } from '../trace/types';
import { TraceWriter } from '../trace/writer';
import { FORM_INTENTS } from '../domain/intents';
import { FORMS } from '../domain/forms';
import { PROMPTS } from '../prompts/render';

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
  { id: 'm1', text: 'Jason Stiles, born March fifth nineteen eighty', intent: 'none', context: 'cancel',
    slots: { name: 'Jason Stiles', dob: { month: 'march', day: '5', year: 'nineteen eighty' } } },
];

const opts = {
  client: new FixtureStubClient(entries, { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) }),
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
const promptedClient = new FixtureStubClient([prompted], { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) });

/** The second entry is a trailing-off utterance the complete gate should hold on. */
const partialClient = new FixtureStubClient([
  entries[0]!,
  { id: 'p1', text: 'four four seven one', intent: 'none', context: 'cancel', answers: { utteranceComplete: { noul: 0.25 } } },
], { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) });

describe('runCorpusEntry', () => {
  it('runs a first-utterance entry from the greeting', async () => {
    const { outcome } = await runCorpusEntry(entries[0]!, opts);
    expect(outcome).toMatchObject({ id: 'c1', decision: 'prompt', promptId: 'ask_name', form: 'cancel', decidedGate: 'intent' });
    expect(outcome.slots.provider).toBe('patel');
  });

  it('runs an in-form entry with the form active and the first slot prompted', async () => {
    const { outcome } = await runCorpusEntry(entries[1]!, opts);
    // The name and birthday fill silently, so the turn goes straight on to the next slot.
    expect(outcome).toMatchObject({ decision: 'prompt', promptId: 'ask_provider', form: 'cancel' });
    expect(outcome.slots.name).toBe('jason stiles');
    expect(outcome.slots.dob).toBe('1980-03-05');
  });

  it('prompts the requested slot for an in-form entry', async () => {
    const { outcome } = await runCorpusEntry(prompted, { ...opts, client: promptedClient });
    // The last slot no longer completes the form: it asks the summary.
    expect(outcome).toMatchObject({ decision: 'prompt', promptId: 'confirm_reschedule' });
    expect(outcome.slots.date).toBe('2026-09-19');
    expect(outcome.slots.name).toBe('jason stiles');
    expect(outcome.slots.dob).toBe('1980-03-05');
    expect(outcome.slots.provider).toBe('patel');
  });

  it('credits a seeded entry only with what its own utterance fills', async () => {
    const sink = traceSink();
    const { run } = await runCorpusEntry(prompted, { ...opts, client: promptedClient, trace: sink.trace });
    const m = summarize(sink.records());
    expect(run.record.slots.name.value).toBe('jason stiles');
    // the greeting already showed the name, birthday and provider filled, so only the date counts
    expect(m.promptTurns).toBe(1);
    expect(m.slotsFilledPerUtterance).toBeCloseTo(1, 5);
    // a session that started mid-form is not a whole call to compare against the baseline
    expect(m.completions).toEqual([]);
  });
});

describe('summaryPromptId', () => {
  it('has a summary prompt exactly for forms that complete with a prompt, each id present in the manifest', () => {
    for (const f of FORM_INTENTS) {
      expect(FORMS[f].summaryPromptId !== null, f).toBe(FORMS[f].completion.kind === 'prompt');
      const id = FORMS[f].summaryPromptId;
      if (id !== null) expect(PROMPTS, `${f}: ${id}`).toHaveProperty(id);
    }
  });
});

describe('seedCorpusSession', () => {
  it('seeds a confirm context with every slot filled and the summary pending', () => {
    const entry = parseCorpus('{"id":"fc-1","text":"yes","intent":"none","context":"confirm_reschedule","confirm":"yes"}')[0]!;
    const s = seedCorpusSession(newSession('fc-1', 0), entry);
    expect(s.form).toBe('reschedule');
    expect(s.slots.name.value).not.toBeNull();
    expect(s.slots.dob.value).not.toBeNull();
    expect(s.slots.provider.value).not.toBeNull();
    expect(s.slots.date.value).not.toBeNull();
    expect(s.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 0 });
    expect(s.promptedFor).toBe('confirm');
    expect(s.lastPromptId).toBe('confirm_reschedule');
    expect(s.lastPromptOptions).toEqual(['yes', 'no']);
    expect(s.lastPromptText).toContain('Dr. Patel');
    expect(s.lastPromptText).toContain('Tuesday, September 22');
  });

  it('seeds a non-confirm context exactly as before: placeholders only up to the prompted slot', () => {
    const entry = prompted;
    const s = seedCorpusSession(newSession('d1', 0), entry);
    expect(s.slots.name.value).toBe('jason stiles');
    expect(s.slots.dob.value).toBe('1980-03-05');
    expect(s.slots.provider.value).toBe('patel');
    expect(s.slots.date.value).toBeNull();
    expect(s.promptedFor).toBe('date');
    expect(s.lastPromptId).toBe('ask_date');
    expect(s.pendingConfirmation).toBeNull();
  });

  it('seeds the transfer offer pending, mid-form, with two frustrated turns behind it', () => {
    const entry = parseCorpus('{"id":"ft-1","text":"keep going","intent":"none","context":"offer_transfer","prompted":"provider","confirm":"no"}')[0]!;
    const s = seedCorpusSession(newSession('ft-1', 0), entry);
    expect(s.form).toBe('reschedule');
    // The question the caller was on is still open, so a declined offer has somewhere to go back to.
    expect(s.slots.name.value).toBe('jason stiles');
    expect(s.slots.dob.value).toBe('1980-03-05');
    expect(s.slots.provider.value).toBeNull();
    expect(s.pendingConfirmation).toEqual({ target: 'transfer', attempts: 0 });
    expect(s.promptedFor).toBe('confirm');
    expect(s.lastPromptId).toBe('offer_transfer');
    expect(s.lastPromptOptions).toEqual(['yes', 'no']);
    expect(s.lastPromptText).toContain('connect you to a person');
    expect(s.frustratedTurns).toBe(2);
  });

  it('leaves a no_form session untouched', () => {
    const untouched = newSession('c1', 0);
    expect(seedCorpusSession(untouched, entries[0]!)).toBe(untouched);
  });

  it('seeds a form context with no prompted at the first missing slot, leaving every slot null', () => {
    const entry: CorpusEntry = { id: 'sn1', text: 'i need a new appointment', intent: 'schedule_new', context: 'schedule_new' };
    const s = seedCorpusSession(newSession('sn1', 0), entry);
    expect(s.slots.name.value).toBeNull();
    expect(s.slots.provider.value).toBeNull();
    expect(s.slots.date.value).toBeNull();
    expect(s.promptedFor).toBe('name');
  });

  it('yields the same state when the seed is applied twice to the same session, as runCorpusEntry does', () => {
    const once = seedCorpusSession(newSession('d1', 0), prompted);
    const applied = seedCorpusSession(newSession('d1', 0), prompted);
    const twice = seedCorpusSession(applied, prompted);
    expect(twice).toEqual(once);
  });
});

describe('runScenario', () => {
  const scenario: Scenario = {
    id: 'cancel-happy',
    steps: [
      { say: 'cancel my appointment with dr patel' },
      { say: 'Jason Stiles, born March fifth nineteen eighty' },
      { say: 'yes' },
    ],
    expect: { decision: 'complete', promptId: 'cancel_confirmed', form: 'cancel', slots: { name: 'jason stiles', dob: '1980-03-05', provider: 'patel' } },
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
    const ok = await runScenario({ id: 'text-ok', steps, expect: { decision: 'prompt', text: 'first and last name' } }, opts);
    expect(ok.mismatches).toEqual([]);
    const bad = await runScenario({ id: 'text-bad', steps, expect: { decision: 'prompt', text: 'not spoken' } }, opts);
    expect(bad.mismatches[0]).toMatch(/text: expected to contain/);
  });

  it('records the ack prompt ids of the final decision', async () => {
    const steps = [{ say: 'cancel my appointment with dr patel' }];
    // Every form entry is acknowledged, a confident route included (spec 2026-09-24 §4).
    const confident = await runScenario({ id: 'acks-confident', steps, expect: { decision: 'prompt' } }, opts);
    expect(confident.outcome.acks).toEqual(['ack_intent']);

    // an intent in the implicit band is acknowledged before the next prompt too
    const implicitClient = new FixtureStubClient(
      [{ ...entries[0]!, answers: { intent: { probabilities: { cancel: 0.65, reschedule: 0.2 } } } }],
      { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) },
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
        { say: 'Jason Stiles, born March fifth nineteen eighty' },
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
  slots: { name: null, dob: null, memberId: null, provider: 'patel', date: null }, queued: [],
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
      steps: [{ say: 'cancel my appointment with dr patel' }, { say: 'Jason Stiles, born March fifth nineteen eighty' }, { say: 'yes' }],
      expect: { decision: 'complete' },
    }, opts);
    const o = outcomeOf('done', r.runs.at(-1)!.result);
    expect(o).toMatchObject({ id: 'done', decision: 'complete', promptId: 'cancel_confirmed', reason: null, form: 'cancel' });
    expect(o.slots).toEqual({ name: 'jason stiles', dob: '1980-03-05', memberId: null, provider: 'patel', date: null });
  });

  it('reads an ignored turn as having no prompt, gate or verdict', () => {
    const ignored = {
      decision: { kind: 'ignore' } as const,
      rows: [], verdict: null, session: newSession('i', 0), turnState: null, fillEvents: [], frames: [],
    } satisfies TurnResult;
    expect(outcomeOf('i', ignored)).toEqual({
      id: 'i', decision: 'ignore', promptId: null, acks: [], reason: null, decidedGate: null, verdict: null,
      form: null, slots: { name: null, dob: null, memberId: null, provider: null, date: null }, queued: [],
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
    expect(spokenText(result)).toContain('first and last name');
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
      steps: [{ say: 'cancel my appointment with dr patel' }, { say: 'Jason Stiles, born March fifth nineteen eighty' }, { say: 'yes' }],
      expect: { decision: 'complete' },
    }, opts);
    const records = r.runs.map((x) => x.record);
    const m = summarize(records);
    expect(m.completions).toEqual([{ sessionId: 'cancel-happy', form: 'cancel', turns: 3, baseline: 5 }]);
    // three slots over three utterances: the name and birthday land together, and the
    // confirming "yes" fills nothing
    expect(m.slotsFilledPerUtterance).toBeCloseTo(1, 5);
    expect(m.bySource['stub:fixture']).toBe(2);
    // turn 1 routed at the intent gate; turn 2 proceeded to slot filling with no gate
    // deciding; turn 3 answered the summary at the confirmation gate
    expect(m.byDecidingGate).toEqual({ intent: 1, none: 1, confirmation: 1 });

    const promptRecord = records.find((rec) => rec.event.type === 'prompt')!;
    const ignored = { ...promptRecord, decision: { kind: 'ignore' } as const, frames: [] };
    const withIgnore = summarize([...records, ignored]);
    expect(withIgnore.promptTurns).toBe(m.promptTurns);
    expect(withIgnore.completions).toEqual(m.completions);
  });
});
