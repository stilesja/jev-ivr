import type { QuestionMap } from '../../jev/types';
import type { TurnState } from '../../core/state';
import type { TraceRecord } from '../../trace/types';
import type { Thresholds } from '../../core/thresholds';
import type { FrameLogLine } from '../frameLog';

interface Base { callSid: string; at: number; seq?: number }

export type DashboardEvent =
  | (Base & { type: 'call_started'; from: string; todayIso: string; thresholds: Partial<Thresholds> })
  | (Base & { type: 'asked'; turnIndex: number; questions: QuestionMap; turnState: TurnState })
  | (Base & { type: 'turn'; record: TraceRecord; spoken: string })
  | (Base & { type: 'silence'; promptId: string | null })
  | (Base & { type: 'dtmf'; digit: string })
  | (Base & { type: 'interrupt'; utteranceUntilInterrupt: string | null })
  | (Base & { type: 'reconnect'; attempt: number })
  | (Base & { type: 'handoff'; reason: string; number: string })
  | (Base & { type: 'ended'; reason: 'completed' | 'hangup' | 'handoff' | 'error' });

export type DashboardEventType = DashboardEvent['type'];

/** The last four digits only; the page never shows a whole caller number. */
export function maskNumber(n: string | undefined | null): string {
  if (!n) return 'unknown';
  const digits = n.replace(/\D/g, '');
  return `…${digits.slice(-4)}`;
}

/**
 * The dashboard route is unauthenticated, and a first turn's event is the raw setup frame with
 * the caller's full number. Shallow-copies the record and, only for a setup event, masks `from`
 * and `to`; every other record (and every other field of a setup record) is untouched.
 */
export function redactRecord(record: TraceRecord): TraceRecord {
  if (record.event.type !== 'setup') return record;
  return { ...record, event: { ...record.event, from: maskNumber(record.event.from), to: maskNumber(record.event.to) } };
}

/** The frame-log counterpart of {@link redactRecord}, for `/dashboard/traces/<sid>`'s raw frame lines. */
export function redactFrameLine(line: FrameLogLine): FrameLogLine {
  const msg = line.msg as { type?: unknown; from?: string; to?: string } | null | undefined;
  if (typeof msg !== 'object' || msg === null || msg.type !== 'setup') return line;
  return { ...line, msg: { ...msg, from: maskNumber(msg.from), to: maskNumber(msg.to) } };
}
