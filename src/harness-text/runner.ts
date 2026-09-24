import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settleBookings, summaryVars, type TurnResult } from '../core/turn';
import { emptySlot, missingSlots, newSession, setForm, type Session } from '../core/session';
import { confirmForm, contextForm, offerTransfer, type CorpusEntry } from '../jev/corpus';
import { JevClientError, type JevClient } from '../jev/types';
import { promptText } from '../prompts/render';
import { ALL_SLOTS, FORMS, type SlotId } from '../domain/forms';
import { DemoDirectory, type AppointmentDirectory } from '../domain/directory';
import type { SlotCandidate } from '../domain/slots';
import { promptFrame, setupFrame, dtmfFrames, silenceFrame } from '../channel/frames';
export { runTurn, nowOf, type RunOptions, type TurnRun } from '../run/turn';
import { runTurn, nowOf, type RunOptions, type TurnRun } from '../run/turn';

export interface Outcome {
  id: string;
  decision: string;
  promptId: string | null;
  /** implicit-confirm prompts spoken before this decision's prompt */
  acks: string[];
  reason: string | null;
  decidedGate: string | null;
  verdict: string | null;
  form: string | null;
  slots: Record<SlotId, string | null>;
  /** intents added mid-form and not yet started */
  queued: string[];
}

export function outcomeOf(id: string, result: TurnResult): Outcome {
  const d = result.decision;
  return {
    id,
    decision: d.kind,
    promptId: 'promptId' in d ? d.promptId : null,
    acks: 'acks' in d ? d.acks.map((a) => a.promptId) : [],
    reason: d.kind === 'handoff' ? d.reason : null,
    decidedGate: result.rows.find((r) => r.decided)?.gate ?? null,
    verdict: result.verdict?.kind ?? null,
    form: result.session.form,
    slots: Object.fromEntries(ALL_SLOTS.map((id) => [id, result.session.slots[id].value])) as Record<SlotId, string | null>,
    queued: [...result.session.queued],
  };
}

/** Stand-ins for the slots a corpus entry's form has already collected. */
const PLACEHOLDER_SLOTS: Record<SlotId, SlotCandidate> = {
  name: { value: 'jason stiles', display: 'Jason Stiles' },
  dob: { value: '1980-03-05', display: 'March 5th, 1980' },
  memberId: { value: '00000000', display: '0000 0000' },
  provider: { value: 'patel', display: 'Dr. Patel' },
  date: { value: '2026-09-22', display: 'Tuesday, September 22' },
};

/** The mid-call state a corpus entry's context implies: its form, the slots already collected, and the prompt being answered. */
export function seedCorpusSession(session: Session, entry: CorpusEntry, directory: AppointmentDirectory): Session {
  if (entry.context === 'no_form') return session;
  const form = contextForm(entry.context)!;
  setForm(session, form);
  const confirming = confirmForm(entry.context) !== null;
  const offering = offerTransfer(entry.context);
  // An entry that targets a later slot starts from a form that already has the earlier ones; a confirm_
  // entry starts from a form that has every slot, since the summary is only asked once the form is full.
  // Computed once, before any slot is filled: recomputing missingSlots(session) per iteration would chase
  // a moving target as the loop fills earlier slots.
  const stopAt = entry.prompted ?? missingSlots(session)[0];
  for (const id of FORMS[form].slots) {
    if (!confirming && id === stopAt) break;
    const placeholder = PLACEHOLDER_SLOTS[id];
    // In a confirm_ context every slot is seeded unconfirmed: the summary is what confirms them, not this
    // placeholder fill. No slot on a summary form uses the `always` policy, so none of them raises a
    // readback of its own on the way.
    session.slots[id] = { ...emptySlot(), value: placeholder.value, display: placeholder.display, confirmed: !confirming };
  }
  if (confirming) {
    const promptId = FORMS[form].summaryPromptId;
    if (!promptId) throw new Error(`corpus ${entry.id}: form ${form} has no summary prompt`);
    session.pendingConfirmation = { target: 'form', form, attempts: 0 };
    session.promptedFor = 'confirm';
    session.lastPromptId = promptId;
    // The summary the caller is answering named the found booking and the offered opening, so they
    // are looked up before its text is rendered. A decision that is not a prompt only fills the session.
    settleBookings(session, { kind: 'ignore' }, directory);
    session.lastPromptText = promptText(promptId, summaryVars(session));
    session.lastPromptOptions = ['yes', 'no'];
    return session;
  }
  if (offering) {
    // The frustrated caller has been offered a transfer and has not answered it yet: two frustrated
    // turns behind them, the question `prompted` names still to come back to (spec 2026-09-22 §5).
    session.pendingConfirmation = { target: 'transfer', attempts: 0 };
    session.promptedFor = 'confirm';
    session.lastPromptId = 'offer_transfer';
    session.lastPromptText = promptText('offer_transfer', {});
    session.lastPromptOptions = ['yes', 'no'];
    session.frustratedTurns = 2;
    return session;
  }
  const slot = stopAt ?? null;
  session.promptedFor = slot;
  session.lastPromptId = slot ? `ask_${slot}` : null;
  session.lastPromptText = slot ? promptText(`ask_${slot}`, {}) : '';
  return session;
}

export async function runCorpusEntry(entry: CorpusEntry, opts: RunOptions): Promise<{ outcome: Outcome; run: TurnRun; setup: TurnRun }> {
  // Seed before the greeting so the setup trace record already reports the placeholder slots
  // as filled; otherwise summarize() credits the entry's one utterance with filling them.
  const directory = opts.directory ?? new DemoDirectory(opts.todayIso);
  const start = seedCorpusSession(newSession(entry.id, nowOf(opts)()), entry, directory);
  const setup = await runTurn(start, setupFrame(entry.id), opts);
  // The greeting's own bookkeeping resets what the last prompt asked for, so re-apply it.
  const session = seedCorpusSession(setup.result.session, entry, directory);
  const run = await runTurn(session, promptFrame(entry.text), opts);
  // The setup run is returned as well as traced: a summary that leaves it out would read
  // the seeded placeholders as slots this one utterance filled.
  return { outcome: outcomeOf(entry.id, run.result), run, setup };
}

export type ScenarioStep = { say: string; fail?: boolean; partial?: boolean } | { dtmf: string } | { silence: true };

export interface ScenarioExpectation {
  decision: string;
  promptId?: string;
  reason?: string;
  form?: string | null;
  slots?: Partial<Record<SlotId, string>>;
  /** substring the last turn's spoken text must contain */
  text?: string;
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
    // A partial step is a non-final ASR result, which the complete gate may hold on.
    const events = 'dtmf' in step ? dtmfFrames(step.dtmf) : 'silence' in step ? [silenceFrame()] : [promptFrame(step.say, step.partial !== true)];
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
  const mismatches = checkExpectation(outcome, scenario.expect, spokenText(last.result));
  return { outcome, runs, pass: mismatches.length === 0, mismatches };
}

/** Everything the caller hears this turn, ack phrases included. */
export function spokenText(result: TurnResult): string {
  return result.frames.filter((f) => f.type === 'text').map((f) => f.token).join(' ');
}

export function checkExpectation(outcome: Outcome, expected: ScenarioExpectation, spoken: string): string[] {
  const out: string[] = [];
  if (outcome.decision !== expected.decision) out.push(`decision: expected ${expected.decision}, got ${outcome.decision}`);
  if (expected.promptId !== undefined && outcome.promptId !== expected.promptId) out.push(`promptId: expected ${expected.promptId}, got ${outcome.promptId}`);
  if (expected.reason !== undefined && outcome.reason !== expected.reason) out.push(`reason: expected ${expected.reason}, got ${outcome.reason}`);
  if (expected.form !== undefined && outcome.form !== expected.form) out.push(`form: expected ${expected.form}, got ${outcome.form}`);
  for (const [slot, value] of Object.entries(expected.slots ?? {})) {
    if (outcome.slots[slot as SlotId] !== value) out.push(`slot ${slot}: expected ${value}, got ${outcome.slots[slot as SlotId]}`);
  }
  if (expected.text !== undefined && !spoken.includes(expected.text)) {
    out.push(`text: expected to contain ${JSON.stringify(expected.text)}, got ${JSON.stringify(spoken)}`);
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
