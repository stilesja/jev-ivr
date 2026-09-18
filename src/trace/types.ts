import type { InboundFrame, OutboundFrame } from '../channel/frames';
import type { AnswerMap, AnswerSource, QuestionMap } from '../jev/types';
import type { TurnState } from '../core/state';
import type { GateRow } from '../core/gates';
import type { Decision } from '../core/decision';
import type { SlotState } from '../core/session';
import type { SlotId } from '../domain/forms';

export type TraceSource = AnswerSource | 'dtmf' | 'error' | 'none';

export interface TraceTiming {
  planMs: number;
  askMs: number;
  resolveMs: number;
  totalMs: number;
}

export interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  costUsd: number;
}

/** Frozen at v:1. All three layers write this shape. */
export interface TraceRecord {
  v: 1;
  sessionId: string;
  turnIndex: number;
  ts: string;
  event: InboundFrame;
  turnState: TurnState | null;
  questions: QuestionMap | null;
  answers: AnswerMap | null;
  source: TraceSource;
  error: { name: string; message: string } | null;
  gates: GateRow[];
  decision: Decision;
  frames: OutboundFrame[];
  slots: Record<SlotId, SlotState>;
  timing: TraceTiming;
  usage: TraceUsage;
}
