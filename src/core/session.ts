import type { FormId, Intent } from '../domain/intents';
import { FORMS, type SlotId } from '../domain/forms';
import type { DateWindow } from './extract/date';

export interface SlotState {
  value: string | null;
  display: string | null;
  confirmed: boolean;
  attempts: number;
  window: DateWindow | null;
}

export interface HistoryEntry {
  node: string;
  intent: string;
  outcome: string;
}

export interface CallerRecord {
  verified: boolean;
  openAppointment: boolean;
  priorCalls7d: number;
}

export interface PendingConfirmation {
  target: 'intent';
  intent: Intent;
}

export interface Interrupt {
  utteranceUntilInterrupt: string;
  durationUntilInterruptMs: number;
}

export interface Session {
  sessionId: string;
  turnIndex: number;
  startedAtMs: number;
  form: FormId | null;
  slots: Record<SlotId, SlotState>;
  intentAttempts: number;
  /** what the last prompt asked for */
  promptedFor: 'intent' | SlotId | null;
  lastPromptId: string | null;
  lastPromptText: string;
  lastPromptOptions: string[];
  /** the intent DTMF menu was just played */
  menuActive: boolean;
  pendingConfirmation: PendingConfirmation | null;
  history: HistoryEntry[];
  caller: CallerRecord;
  dtmfBuffer: string;
  /** the barge-in that cut off the last prompt, until the next prompt turn consumes it */
  lastInterrupt: Interrupt | null;
  consecutiveFailures: number;
  ended: boolean;
}

export const DEFAULT_CALLER: CallerRecord = { verified: false, openAppointment: true, priorCalls7d: 0 };

export function emptySlot(): SlotState {
  return { value: null, display: null, confirmed: false, attempts: 0, window: null };
}

function cloneSlot(s: SlotState): SlotState {
  return { ...s, window: s.window ? { ...s.window } : null };
}

export function emptySlots(): Record<SlotId, SlotState> {
  return { memberId: emptySlot(), provider: emptySlot(), date: emptySlot() };
}

export function newSession(sessionId: string, nowMs: number, caller: CallerRecord = DEFAULT_CALLER): Session {
  return {
    sessionId,
    turnIndex: 0,
    startedAtMs: nowMs,
    form: null,
    slots: emptySlots(),
    intentAttempts: 0,
    promptedFor: null,
    lastPromptId: null,
    lastPromptText: '',
    lastPromptOptions: [],
    menuActive: false,
    pendingConfirmation: null,
    history: [],
    caller: { ...caller },
    dtmfBuffer: '',
    lastInterrupt: null,
    consecutiveFailures: 0,
    ended: false,
  };
}

/** Deep enough copy that resolve() can mutate freely without touching the caller's object. */
export function cloneSession(s: Session): Session {
  return {
    ...s,
    slots: {
      memberId: cloneSlot(s.slots.memberId),
      provider: cloneSlot(s.slots.provider),
      date: cloneSlot(s.slots.date),
    },
    lastPromptOptions: [...s.lastPromptOptions],
    history: s.history.map((h) => ({ ...h })),
    caller: { ...s.caller },
    pendingConfirmation: s.pendingConfirmation ? { ...s.pendingConfirmation } : null,
    lastInterrupt: s.lastInterrupt ? { ...s.lastInterrupt } : null,
  };
}

export type AttemptBucket = 'first' | 'second' | 'third_or_more';
export function bucketAttempt(attempts: number): AttemptBucket {
  if (attempts <= 0) return 'first';
  if (attempts === 1) return 'second';
  return 'third_or_more';
}

export type ElapsedBucket = 'under_30s' | 'under_2m' | 'over_2m';
export function bucketElapsed(ms: number): ElapsedBucket {
  if (ms < 30_000) return 'under_30s';
  if (ms < 120_000) return 'under_2m';
  return 'over_2m';
}

export type PriorCallsBucket = 'none' | 'one' | 'several';
export function bucketPriorCalls(n: number): PriorCallsBucket {
  if (n <= 0) return 'none';
  if (n === 1) return 'one';
  return 'several';
}

export function setForm(session: Session, form: FormId): Session {
  session.form = form;
  session.intentAttempts = 0;
  session.pendingConfirmation = null;
  session.menuActive = false;
  return session;
}

export function requiredSlots(session: Session): SlotId[] {
  return session.form ? FORMS[session.form].slots : [];
}

export function missingSlots(session: Session): SlotId[] {
  return requiredSlots(session).filter((id) => session.slots[id].value === null);
}

export function currentAttempts(session: Session): number {
  if (session.promptedFor === 'intent' || session.promptedFor === null) return session.intentAttempts;
  return session.slots[session.promptedFor].attempts;
}
