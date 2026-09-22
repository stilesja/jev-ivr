import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TraceRecord, TraceTiming } from './types';
import type { InboundFrame } from '../channel/frames';
import type { JevResponse, QuestionMap } from '../jev/types';
import type { TurnError, TurnResult } from '../core/turn';

export class TraceWriter {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(record: TraceRecord): void {
    appendFileSync(this.path, JSON.stringify(record) + '\n');
  }
}

export interface TraceInput {
  result: TurnResult;
  event: InboundFrame;
  questions: QuestionMap | null;
  response: JevResponse | null;
  error: TurnError | null;
  timing: TraceTiming;
  ts: string;
  pricePerMtok: number;
}

export function buildTraceRecord(input: TraceInput): TraceRecord {
  const { result, event, questions, response, error, timing, ts, pricePerMtok } = input;
  const source = error ? 'error' : response ? response.source : event.type === 'dtmf' ? 'dtmf' : event.type === 'silence' ? 'silence' : 'none';
  const inputTokens = response?.usage.inputTokens ?? 0;
  return {
    v: 1,
    sessionId: result.session.sessionId,
    turnIndex: result.session.turnIndex,
    ts,
    event,
    turnState: result.turnState,
    questions,
    answers: response?.answers ?? null,
    source,
    error,
    gates: result.rows,
    decision: result.decision,
    frames: result.frames,
    form: result.session.form,
    slots: result.session.slots,
    queued: [...result.session.queued],
    // Copied, not aliased: `attempts` on the session's pendingConfirmation is mutated in place by
    // later turns, and the dashboard holds records like this one in memory.
    pendingConfirmation: result.session.pendingConfirmation ? { ...result.session.pendingConfirmation } : null,
    promptedFor: result.session.promptedFor,
    timing,
    usage: {
      inputTokens,
      outputTokens: response?.usage.outputTokens ?? 0,
      estimated: response?.usage.estimated ?? true,
      costUsd: (inputTokens * pricePerMtok) / 1_000_000,
    },
  };
}
