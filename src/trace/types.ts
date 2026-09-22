import type { InboundFrame, OutboundFrame } from '../channel/frames';
import type { AnswerMap, AnswerSource, QuestionMap } from '../jev/types';
import type { TurnState } from '../core/state';
import type { GateRow } from '../core/gates';
import type { Decision } from '../core/decision';
import type { PendingConfirmation, SlotState } from '../core/session';
import type { SlotId } from '../domain/forms';
import type { FormId } from '../domain/intents';

export type TraceSource = AnswerSource | 'dtmf' | 'silence' | 'error' | 'none';

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
  /** the form active after this turn, null when none is */
  form: string | null;
  slots: Record<SlotId, SlotState>;
  timing: TraceTiming;
  usage: TraceUsage;
  /** Added 2026-09-21 for the dashboard; optional so records written before then still load. */
  queued?: FormId[];
  pendingConfirmation?: PendingConfirmation | null;
  promptedFor?: 'intent' | 'confirm' | SlotId | null;
}
