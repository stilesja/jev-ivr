/**
 * Scripted calls for the dashboard: a real run through the real observer and the real bus, so the
 * events are the ones the page receives -- the observer's `asked`/`turn` (with the redacted record
 * and the spoken line) plus the moments the adapter publishes itself.
 *
 * Not a test file: view.test.ts builds its fixtures from here, and a by-hand check of the page can
 * import the same function to produce an event list without placing a call.
 */
import { runTurn, type RunOptions } from '../../run/turn';
import { newSession, type Session } from '../../core/session';
import { dtmfFrames, promptFrame, setupFrame, silenceFrame } from '../../channel/frames';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { FixtureStubClient } from '../../jev/fixtureStub';
import { HeuristicStubClient } from '../../jev/heuristicStub';
import { loadCorpus } from '../../jev/corpus';
import { DEFAULT_CORPUS_FILE } from '../../run/client';
import { spokenText } from '../../prompts/render';
import type { TraceRecord } from '../../trace/types';
import type { SessionStore } from '../sessions';
import { DashboardBus, type PublishedEvent } from './bus';
import { makeObserver } from './observer';

export const TODAY = '2026-09-18';
export const CALL = 'CA1';
/** What the page shows instead of a caller number; the bus is handed the masked form. */
export const FROM = '…2926';
/** Three slots and a narrowing in one breath: the opener the dashboard demo is built around. */
export const OPENER = "I need to reschedule my appointment, it's with Dr. Chen sometime next week";

export type Step = string | { dtmf: string } | { silence: true };

export interface ScriptedOptions {
  /** Defaults to the fixture corpus with the heuristic stub behind it. */
  client?: RunOptions['client'];
  callSid?: string;
}

/** The corpus is read from disk, so one client is shared by every scripted call in a process. */
let shared: RunOptions['client'] | null = null;
function defaultClient(): RunOptions['client'] {
  shared ??= new FixtureStubClient(loadCorpus(DEFAULT_CORPUS_FILE), { sharpness: 0.9, fallback: new HeuristicStubClient() });
  return shared;
}

export interface Scripted {
  events: PublishedEvent[];
  records: TraceRecord[];
}

/** Runs `steps` as one call, five seconds apart, and returns everything both consumers saw. */
export async function scripted(steps: Step[], options: ScriptedOptions = {}): Promise<Scripted> {
  const callSid = options.callSid ?? CALL;
  const events: PublishedEvent[] = [];
  const records: TraceRecord[] = [];
  const bus = new DashboardBus();
  bus.subscribe((e) => events.push(e));
  let session: Session = newSession(callSid, 0);
  // makeObserver reads the live turn counter through the store, exactly as the server wires it.
  const store = { get: () => ({ session }) } as unknown as SessionStore;
  let t = 1_000;
  const opts: RunOptions = {
    client: options.client ?? defaultClient(),
    thresholds: { ...DEFAULT_THRESHOLDS },
    todayIso: TODAY,
    now: () => t,
    observe: makeObserver(bus, store, callSid),
  };
  const step = async (frame: Parameters<typeof runTurn>[1]): Promise<void> => {
    const run = await runTurn(session, frame, opts);
    records.push(run.record);
    session = run.result.session;
  };
  bus.publish({ type: 'call_started', callSid, at: t, from: FROM, todayIso: TODAY, thresholds: DEFAULT_THRESHOLDS });
  await step(setupFrame(callSid));
  for (const s of steps) {
    t += 5_000;
    if (typeof s === 'string') await step(promptFrame(s));
    else if ('dtmf' in s) {
      for (const f of dtmfFrames(s.dtmf)) {
        bus.publish({ type: 'dtmf', callSid, at: t, digit: f.digit });
        await step(f);
      }
    } else {
      bus.publish({ type: 'silence', callSid, at: t, promptId: session.lastPromptId });
      await step(silenceFrame());
    }
  }
  return { events, records };
}

/** What `/dashboard/traces/<sid>` hands the page: the record plus the line the caller heard. */
export function replayRecords(records: TraceRecord[]): Array<TraceRecord & { spokenText: string }> {
  return records.map((r) => ({ ...r, spokenText: spokenText(r.decision) }));
}
