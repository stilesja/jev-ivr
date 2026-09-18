import type { AnswerMap } from '../jev/types';
import type { SlotId } from '../domain/forms';
import { SLOTS, type SlotCandidate, type SlotContext, type SlotOutcome, type SlotSpec } from '../domain/slots';
import type { DateWindow } from './extract/date';
import { missingSlots, requiredSlots, type Session } from './session';
import type { Thresholds } from './thresholds';

export type RetryStep = 'open' | 'dtmf' | 'agent';

/** attempts = failures so far including the one just counted. */
export function retryStep(attempts: number, t: Thresholds): RetryStep {
  if (attempts >= t.MAX_ATTEMPTS) return 'agent';
  if (attempts >= t.MAX_ATTEMPTS - 1) return 'dtmf';
  return 'open';
}

export interface Ack {
  promptId: string;
  vars: Record<string, string>;
}

export interface FillEvent {
  slot: SlotId;
  outcome: SlotOutcome;
}

export interface FillResult {
  session: Session;
  events: FillEvent[];
  acks: Ack[];
  disambiguate: { slot: SlotId; a: SlotCandidate; b: SlotCandidate } | null;
  /** true if any slot was filled, narrowed to a window, or needs disambiguation */
  progress: boolean;
}

export function fillSlots(session: Session, answers: AnswerMap, ctx: SlotContext, specs: SlotSpec[]): FillResult {
  const events: FillEvent[] = [];
  const acks: Ack[] = [];
  let disambiguate: FillResult['disambiguate'] = null;
  let progress = false;

  for (const spec of specs) {
    const outcome = spec.fill(answers, ctx);
    if (outcome.kind === 'absent') continue;
    events.push({ slot: spec.id, outcome });
    const slot = session.slots[spec.id];
    switch (outcome.kind) {
      case 'filled': {
        const keepConfirmed = slot.confirmed && slot.value === outcome.value;
        slot.value = outcome.value;
        slot.display = outcome.display;
        slot.confirmed = outcome.confirm === 'none' || keepConfirmed;
        slot.window = null;
        if (outcome.confirm === 'implicit') acks.push({ promptId: `ack_${spec.id}`, vars: { [spec.id]: outcome.display } });
        progress = true;
        break;
      }
      case 'window':
        if (slot.value === null) {
          slot.window = outcome.window;
          progress = true;
        }
        break;
      case 'disambiguate':
        if (!disambiguate) disambiguate = { slot: spec.id, a: outcome.a, b: outcome.b };
        progress = true;
        break;
      case 'invalid':
        break;
    }
  }
  return { session, events, acks, disambiguate, progress };
}

export type NextPrompt =
  | { kind: 'ask'; slot: SlotId; window: DateWindow | null }
  | { kind: 'complete' };

export function nextPrompt(session: Session): NextPrompt {
  const [slot] = missingSlots(session);
  if (!slot) return { kind: 'complete' };
  return { kind: 'ask', slot, window: session.slots[slot].window };
}

export type DtmfResult =
  | { kind: 'collecting' }
  | { kind: 'filled'; slot: SlotId; display: string }
  | { kind: 'invalid'; slot: SlotId }
  | { kind: 'no_target' };

/** Apply a DTMF digit buffer to the slot that was last prompted. */
export function applyDtmf(session: Session, buffer: string, ctx: SlotContext): DtmfResult {
  const target = session.promptedFor;
  if (target === null || target === 'intent') return { kind: 'no_target' };
  if (!requiredSlots(session).includes(target)) return { kind: 'no_target' };
  const spec = SLOTS[target];
  if (buffer.length < spec.dtmf.length) return { kind: 'collecting' };
  const parsed = spec.dtmf.parse(buffer.slice(0, spec.dtmf.length), ctx);
  if (!parsed) return { kind: 'invalid', slot: target };
  const slot = session.slots[target];
  slot.value = parsed.value;
  slot.display = parsed.display;
  slot.confirmed = true;
  slot.window = null;
  return { kind: 'filled', slot: target, display: parsed.display };
}
