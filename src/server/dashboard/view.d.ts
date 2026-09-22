/**
 * Types for `view.js`. The module itself is plain JavaScript so the browser can load it with no
 * build step; this file is what TypeScript resolves for `import … from './view.js'`.
 */
import type { DashboardEvent } from './events';
import type { TraceRecord } from '../../trace/types';
import type { FrameLogLine } from '../frameLog';
import type { Thresholds } from '../../core/thresholds';
import type { GateRow } from '../../core/gates';
import type { AnswerMap, QuestionMap } from '../../jev/types';
import type { PendingConfirmation } from '../../core/session';

export interface Row {
  id: string;
  kind: string;
  p: number | null;
  value: string | null;
  threshold: number | null;
  decisive: boolean;
  top: Array<{ label: string; p: number }> | null;
}

export interface Group {
  name: string;
  rows: Row[];
  decisive: boolean;
  quiet: number;
}

export interface Chip {
  id: string;
  state: 'empty' | 'partial' | 'filled';
  label: string;
  changed: boolean;
  attempts: number;
}

export interface Line {
  kind: 'system' | 'caller' | 'marker';
  text: string;
  promptId?: string;
  turn?: number;
}

export interface View {
  status: string;
  callSid: string | null;
  turnCount: number;
  totals: { askMs: number; tokens: number; usd: number };
  lines: Line[];
  form: string | null;
  chips: Chip[];
  pending: string | null;
  queued: string[];
  asking: string | null;
  jev: { header: string; pending: boolean; groups: Group[]; decision: string };
  thresholds: Partial<Thresholds>;
}

/** One trace record as the replay route returns it: the line the caller heard is precomputed. */
export type ReplayRecord = TraceRecord & { spokenText?: string };

export interface ReplayOptions {
  from?: string;
  thresholds?: Partial<Thresholds>;
  /** Legacy escape hatch: only consulted when the record carries no `spokenText`. */
  spoken?: (record: ReplayRecord) => string;
}

/** Mirrors `ALL_SLOTS` in src/domain/forms.ts; view.js cannot import it. */
export const ALL_SLOTS: string[];
/** Mirrors `FORMS[form].slots` in src/domain/forms.ts; view.js cannot import it. */
export const FORM_SLOTS: Record<string, string[]>;

export function reduce(events: DashboardEvent[]): View;
export function replayEvents(records: ReplayRecord[], frames: FrameLogLine[], opts?: ReplayOptions): DashboardEvent[];
export function decisiveRows(
  answers: AnswerMap | Record<string, unknown> | null,
  thresholds: Partial<Thresholds>,
  gateRows: readonly GateRow[] | readonly unknown[],
  questions?: QuestionMap | Record<string, unknown> | null,
): Row[];
export function groupRows(rows: Row[], formSlots: readonly string[], pending: PendingConfirmation | { target: string } | null): Group[];
export function thresholdFor(id: string, thresholds: Partial<Thresholds>): number | null;