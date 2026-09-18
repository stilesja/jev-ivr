import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { InboundFrame } from '../channel/frames';
import { promptFrame, setupFrame, dtmfFrames } from '../channel/frames';
import { plan, resolve, type TurnContext, type TurnError, type TurnResult } from '../core/turn';
import { missingSlots, newSession, setForm, type Session } from '../core/session';
import type { Thresholds } from '../core/thresholds';
import type { CorpusEntry } from '../jev/corpus';
import { JevClientError, type JevClient, type JevResponse, type JsonValue, type QuestionMap } from '../jev/types';
import { buildTraceRecord, type TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { promptText } from '../prompts/render';
import { ALL_SLOTS, type SlotId } from '../domain/forms';

export interface RunOptions {
  client: JevClient;
  thresholds: Thresholds;
  todayIso: string;
  trace?: TraceWriter | null;
  now?: () => number;
}

function nowOf(opts: RunOptions): () => number {
  return opts.now ?? (() => Date.now());
}

export interface TurnRun {
  result: TurnResult;
  questions: QuestionMap | null;
  response: JevResponse | null;
  error: TurnError | null;
  record: TraceRecord;
}

export async function runTurn(session: Session, event: InboundFrame, opts: RunOptions): Promise<TurnRun> {
  const now = nowOf(opts);
  const tc: TurnContext = { nowMs: now(), todayIso: opts.todayIso, thresholds: opts.thresholds };
  const t0 = performance.now();
  const p = plan(session, event, tc);
  const t1 = performance.now();
  let response: JevResponse | null = null;
  let error: TurnError | null = null;
  if (p.needsModel) {
    try {
      response = await opts.client.ask({
        state: p.turnState as unknown as JsonValue,
        questions: p.questions!,
        timeoutMs: opts.thresholds.JEV_TIMEOUT_MS,
      });
    } catch (e) {
      // A JevClientError is a client-level failure (timeout, transport) the harness models
      // as part of the run. Anything else is a bug in the corpus/fixture authoring (e.g. a
      // bad label) and should stop the run rather than being scored as a client failure.
      if (!(e instanceof JevClientError)) throw e;
      error = { name: e.name, message: e.message };
    }
  }
  const t2 = performance.now();
  const result = resolve(session, event, response?.answers ?? null, tc, error);
  const t3 = performance.now();
  const record = buildTraceRecord({
    result, event, questions: p.questions, response, error,
    timing: { planMs: t1 - t0, askMs: t2 - t1, resolveMs: t3 - t2, totalMs: t3 - t0 },
    ts: new Date(now()).toISOString(),
    pricePerMtok: opts.thresholds.JEV_PRICE_PER_MTOK,
  });
  opts.trace?.write(record);
  return { result, questions: p.questions, response, error, record };
}

export interface Outcome {
  id: string;
  decision: string;
  promptId: string | null;
  reason: string | null;
  decidedGate: string | null;
  verdict: string | null;
  form: string | null;
  slots: Record<SlotId, string | null>;
}

export function outcomeOf(id: string, result: TurnResult): Outcome {
  const d = result.decision;
  return {
    id,
    decision: d.kind,
    promptId: 'promptId' in d ? d.promptId : null,
    reason: d.kind === 'handoff' ? d.reason : null,
    decidedGate: result.rows.find((r) => r.decided)?.gate ?? null,
    verdict: result.verdict?.kind ?? null,
    form: result.session.form,
    slots: Object.fromEntries(ALL_SLOTS.map((id) => [id, result.session.slots[id].value])) as Record<SlotId, string | null>,
  };
}

async function startSession(id: string, opts: RunOptions): Promise<Session> {
  const run = await runTurn(newSession(id, nowOf(opts)()), setupFrame(id), opts);
  return run.result.session;
}

export async function runCorpusEntry(entry: CorpusEntry, opts: RunOptions): Promise<{ outcome: Outcome; run: TurnRun }> {
  const session = await startSession(entry.id, opts);
  if (entry.context !== 'no_form') {
    setForm(session, entry.context);
    const [slot] = missingSlots(session);
    session.promptedFor = slot ?? null;
    session.lastPromptId = slot ? `ask_${slot}` : null;
    session.lastPromptText = slot ? promptText(`ask_${slot}`, {}) : '';
  }
  const run = await runTurn(session, promptFrame(entry.text), opts);
  return { outcome: outcomeOf(entry.id, run.result), run };
}

export type ScenarioStep = { say: string; fail?: boolean } | { dtmf: string };

export interface ScenarioExpectation {
  decision: string;
  promptId?: string;
  reason?: string;
  form?: string | null;
  slots?: Partial<Record<SlotId, string>>;
}

export interface Scenario {
  id: string;
  steps: ScenarioStep[];
  expect: ScenarioExpectation;
}

export interface ScenarioRun {
  outcome: Outcome;
  runs: TurnRun[];
  pass: boolean;
  mismatches: string[];
}

export async function runScenario(scenario: Scenario, opts: RunOptions): Promise<ScenarioRun> {
  let failNext = false;
  const client: JevClient = {
    ask: (req) => (failNext ? Promise.reject(new JevClientError('injected timeout')) : opts.client.ask(req)),
  };
  const o = { ...opts, client };
  const runs: TurnRun[] = [];
  let session = newSession(scenario.id, nowOf(opts)());
  const setup = await runTurn(session, setupFrame(scenario.id), o);
  runs.push(setup);
  session = setup.result.session;
  let last = setup;
  for (const step of scenario.steps) {
    if (session.ended) break;
    const events = 'dtmf' in step ? dtmfFrames(step.dtmf) : [promptFrame(step.say)];
    failNext = 'say' in step && step.fail === true;
    for (const event of events) {
      last = await runTurn(session, event, o);
      runs.push(last);
      session = last.result.session;
      if (session.ended) break;
    }
    failNext = false;
  }
  const outcome = outcomeOf(scenario.id, last.result);
  const mismatches = checkExpectation(outcome, scenario.expect);
  return { outcome, runs, pass: mismatches.length === 0, mismatches };
}

export function checkExpectation(outcome: Outcome, expected: ScenarioExpectation): string[] {
  const out: string[] = [];
  if (outcome.decision !== expected.decision) out.push(`decision: expected ${expected.decision}, got ${outcome.decision}`);
  if (expected.promptId !== undefined && outcome.promptId !== expected.promptId) out.push(`promptId: expected ${expected.promptId}, got ${outcome.promptId}`);
  if (expected.reason !== undefined && outcome.reason !== expected.reason) out.push(`reason: expected ${expected.reason}, got ${outcome.reason}`);
  if (expected.form !== undefined && outcome.form !== expected.form) out.push(`form: expected ${expected.form}, got ${outcome.form}`);
  for (const [slot, value] of Object.entries(expected.slots ?? {})) {
    if (outcome.slots[slot as SlotId] !== value) out.push(`slot ${slot}: expected ${value}, got ${outcome.slots[slot as SlotId]}`);
  }
  return out;
}

function isValidScenario(s: unknown): s is Scenario {
  return (
    typeof s === 'object' && s !== null &&
    typeof (s as Scenario).id === 'string' &&
    Array.isArray((s as Scenario).steps) &&
    typeof (s as Scenario).expect === 'object' && (s as Scenario).expect !== null
  );
}

export function loadScenarios(dir: string): Scenario[] {
  const seen = new Set<string>();
  const out: Scenario[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`scenarios ${file}: expected an array`);
    for (const [index, s] of parsed.entries()) {
      if (!isValidScenario(s)) throw new Error(`scenarios ${file}: entry ${index} is missing id, steps, or expect`);
      if (seen.has(s.id)) throw new Error(`scenario ${s.id}: duplicate id`);
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}
