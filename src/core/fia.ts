import type { AnswerMap } from '../jev/types';
import type { SlotId } from '../domain/forms';
import { SLOTS, type SlotCandidate, type SlotContext, type SlotOutcome, type SlotPartial, type SlotSpec } from '../domain/slots';
import { missingSlots, requiredSlots, type PendingConfirmation, type Session } from './session';
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

export interface FillOptions {
  /**
   * A correction to a form the caller has already been read back (spec final-confirm §2.2 case 2):
   * a window over an already-filled slot reopens it for narrowing, the way a new value replaces it.
   * Mid-form a window never overwrites a filled slot, so that a value mentioned again in passing
   * ("next week" alongside an answer already given) cannot unfill it.
   */
  correcting?: boolean;
}

/**
 * The context handed to one spec's `questions`/`fill`: that spec's own slot's pending partial
 * substituted in, never another slot's -- a dob partial must never reach the date slot's `fill`
 * (or `questions`), nor a date window reach dob's. A pending window constrains what a bare
 * weekday can mean, or what year is still owed, on the next turn.
 */
export function slotCtx(session: Session, ctx: SlotContext, id: SlotId): SlotContext {
  return { ...ctx, window: session.slots[id].window };
}

/**
 * A pending narrowing as one comparable value, field by field rather than by object identity or
 * key order: `dob:3-5` for a month/day partial, `date:<start>:<end>:<label>` for a date window.
 */
function windowKey(w: SlotPartial | null): string {
  if (w === null) return 'none';
  if ('kind' in w) return `dob:${w.month}-${w.day}`;
  return `date:${w.start}:${w.end}:${w.label}`;
}

export function fillSlots(session: Session, answers: AnswerMap, ctx: SlotContext, specs: SlotSpec[], opts: FillOptions = {}): FillResult {
  const events: FillEvent[] = [];
  const acks: Ack[] = [];
  let disambiguate: FillResult['disambiguate'] = null;
  let progress = false;

  for (const spec of specs) {
    const outcome = spec.fill(answers, slotCtx(session, ctx, spec.id));
    if (outcome.kind === 'absent') continue;
    events.push({ slot: spec.id, outcome });
    const slot = session.slots[spec.id];
    switch (outcome.kind) {
      case 'filled': {
        // The slot's own policy, not the fill outcome, decides whether a spoken value is
        // read back: an always-confirm slot lands unconfirmed and silent, and the caller
        // hears it in a confirm_<slot> prompt. A summary-policy slot also lands unconfirmed
        // and silent, but its readback is the form's final confirm rather than a confirm_<slot>
        // prompt of its own. A value already confirmed and spoken again unchanged stays
        // confirmed, so repeating it does not re-open the readback.
        const policy = spec.spokenConfirm;
        const keepConfirmed = slot.confirmed && slot.value === outcome.value;
        slot.value = outcome.value;
        slot.display = outcome.display;
        slot.confirmed = keepConfirmed || (policy === 'by-confidence' && outcome.confirm === 'none');
        slot.window = null;
        if (policy === 'by-confidence' && outcome.confirm === 'implicit') acks.push({ promptId: `ack_${spec.id}`, vars: { [spec.id]: outcome.display } });
        progress = true;
        break;
      }
      case 'window': {
        if (slot.value === null || opts.correcting === true) {
          // Only a window that differs from the one already pending is progress: a partial that
          // gained a component, or a different partial altogether. Re-speaking the partial the
          // caller was just asked to complete ("march fifth" again at ask_dob_year, "next week"
          // again at date_narrow_window) answers nothing, and counting it as progress would hold
          // `attempts` at zero and re-ask the same question forever. turn.ts' `case 'proceed'`
          // turns a turn without progress into failAttempt, so the ladder walks to the keypad
          // rung and then to an agent -- the same reading correctingFill/summaryState give an
          // unchanged fill on the summary's own ladder.
          const changed = windowKey(slot.window) !== windowKey(outcome.window);
          slot.value = null;
          slot.display = null;
          slot.confirmed = false;
          slot.window = outcome.window;
          if (changed) progress = true;
        }
        break;
      }
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
  | { kind: 'ask'; slot: SlotId; window: SlotPartial | null }
  | { kind: 'complete' };

export function nextPrompt(session: Session): NextPrompt {
  const [slot] = missingSlots(session);
  if (!slot) return { kind: 'complete' };
  return { kind: 'ask', slot, window: session.slots[slot].window };
}

/** The readback owed for the first filled, unconfirmed always-confirm slot, or null. */
export function pendingSlotConfirmation(session: Session): Extract<PendingConfirmation, { target: 'slot' }> | null {
  for (const id of requiredSlots(session)) {
    const s = session.slots[id];
    if (s.value !== null && !s.confirmed && SLOTS[id].spokenConfirm === 'always') {
      return { target: 'slot', slot: id, value: s.value, display: s.display ?? s.value };
    }
  }
  return null;
}

export type DtmfResult =
  | { kind: 'collecting' }
  | { kind: 'filled'; slot: SlotId; display: string }
  | { kind: 'invalid'; slot: SlotId }
  | { kind: 'no_target' };

/** Apply a DTMF digit buffer to the slot that was last prompted. */
export function applyDtmf(session: Session, buffer: string, ctx: SlotContext): DtmfResult {
  const target = session.promptedFor;
  if (target === null || target === 'intent' || target === 'confirm') return { kind: 'no_target' };
  if (!requiredSlots(session).includes(target)) return { kind: 'no_target' };
  const spec = SLOTS[target];
  if (!spec.dtmf) return { kind: 'no_target' };
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
