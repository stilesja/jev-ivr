/**
 * Types for `view.js`. The module itself is plain JavaScript so the browser can load it with no
 * build step; this file is what TypeScript resolves for `import … from './view.js'`.
 */
import type { DashboardEvent } from './events';
import type { ReplayRecord } from './routes';
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

export interface ReplayOptions {
  from?: string;
  thresholds?: Partial<Thresholds>;
  /** Masked, for the `transfer to …4567` marker; the trace does not record the number dialled. */
  handoffNumber?: string;
}

/** Mirrors `ALL_SLOTS` in src/domain/forms.ts; view.js cannot import it. */
export const ALL_SLOTS: readonly string[];
/** Mirrors `FORMS[form].slots` in src/domain/forms.ts; view.js cannot import it. */
export const FORM_SLOTS: Readonly<Record<string, readonly string[]>>;

export function reduce(events: DashboardEvent[]): View;
export function replayEvents(records: ReplayRecord[], frames: FrameLogLine[], opts?: ReplayOptions): DashboardEvent[];
export function decisiveRows(
  answers: AnswerMap | Record<string, unknown> | null,
  thresholds: Partial<Thresholds>,
  gateRows: readonly GateRow[] | readonly unknown[],
  questions?: QuestionMap | Record<string, unknown> | null,
  /** The form the batch was asked under: which rung the `intent` row's tick is drawn at. */
  activeForm?: string | null,
): Row[];
export function groupRows(rows: Row[], formSlots: readonly string[], pending: PendingConfirmation | { target: string } | null): Group[];
export function thresholdFor(id: string, thresholds: Partial<Thresholds>, activeForm?: string | null): number | null;