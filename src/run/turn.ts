import { performance } from 'node:perf_hooks';
import type { InboundFrame } from '../channel/frames';
import { plan, resolve, type TurnContext, type TurnError, type TurnResult } from '../core/turn';
import type { Session } from '../core/session';
import type { Thresholds } from '../core/thresholds';
import { JevClientError, type JevClient, type JevResponse, type JsonValue, type QuestionMap } from '../jev/types';
import { buildTraceRecord, type TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';

export interface RunOptions {
  client: JevClient;
  thresholds: Thresholds;
  todayIso: string;
  trace?: TraceWriter | null;
  now?: () => number;
}

export function nowOf(opts: RunOptions): () => number {
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
