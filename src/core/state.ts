import type { SlotId } from '../domain/forms';
import { INTENT_LABELS } from '../domain/intents';
import { candidateSpans } from './spans';
import {
  bucketAttempt, bucketElapsed, bucketPriorCalls, currentAttempts,
  type AttemptBucket, type ElapsedBucket, type PriorCallsBucket, type Session,
} from './session';

export const HISTORY_WINDOW = 3;

export interface TurnInput {
  text: string;
  isFinal: boolean;
  dtmf: string | null;
}

/** What the model sees. Numbers are bucketed; see spec §5 and jev-1.13 jaggedness notes. */
export interface TurnState {
  node: { id: string; promptJustPlayed: string; options: string[] };
  turn: { attempt: AttemptBucket; elapsed: ElapsedBucket };
  activeForm: string | null;
  activeFormLabel: string | null;
  slots: Record<SlotId, { value: string | null; confirmed: boolean }>;
  history: Array<{ node: string; intent: string; outcome: string }>;
  caller: { verified: boolean; openAppointment: boolean; priorCalls: PriorCallsBucket };
  asr: { text: string; isFinal: boolean; bargeIn: boolean; dtmf: string | null };
  candidateSpans: string[];
  /** the model sees 'intent', 'form', 'transfer', or the slot id */
  pendingConfirmation: { target: 'intent' | 'form' | 'transfer' | SlotId; value: string } | null;
}

/**
 * The pending confirmation as the model sees it: what is being confirmed, and the thing itself in
 * words. The transfer offer names what a yes buys rather than a form or a slot (spec 2026-09-22 §3).
 */
function pendingState(pc: Session['pendingConfirmation']): TurnState['pendingConfirmation'] {
  if (pc === null) return null;
  if (pc.target === 'intent') return { target: 'intent', value: INTENT_LABELS[pc.intent] };
  if (pc.target === 'form') return { target: 'form', value: INTENT_LABELS[pc.form] };
  if (pc.target === 'transfer') return { target: 'transfer', value: 'connect you to a person' };
  return { target: pc.slot, value: pc.display };
}

export function buildTurnState(session: Session, input: TurnInput, nowMs: number): TurnState {
  const slots = {} as TurnState['slots'];
  for (const id of Object.keys(session.slots) as SlotId[]) {
    slots[id] = { value: session.slots[id].display, confirmed: session.slots[id].confirmed };
  }
  return {
    node: {
      id: session.lastPromptId ?? 'start',
      promptJustPlayed: session.lastPromptText,
      options: [...session.lastPromptOptions],
    },
    turn: {
      attempt: bucketAttempt(currentAttempts(session)),
      elapsed: bucketElapsed(nowMs - session.startedAtMs),
    },
    activeForm: session.form,
    activeFormLabel: session.form ? INTENT_LABELS[session.form] : null,
    slots,
    history: session.history.slice(-HISTORY_WINDOW).map((h) => ({ ...h })),
    caller: {
      verified: session.caller.verified,
      openAppointment: session.caller.openAppointment,
      priorCalls: bucketPriorCalls(session.caller.priorCalls7d),
    },
    asr: { text: input.text, isFinal: input.isFinal, bargeIn: session.lastInterrupt !== null, dtmf: input.dtmf },
    candidateSpans: candidateSpans(input.text),
    pendingConfirmation: pendingState(session.pendingConfirmation),
  };
}
