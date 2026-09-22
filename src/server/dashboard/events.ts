import type { QuestionMap } from '../../jev/types';
import type { TurnState } from '../../core/state';
import type { TraceRecord } from '../../trace/types';
import type { Thresholds } from '../../core/thresholds';

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
