import type { AnswerMap, QuestionMap } from '../jev/types';
import type { InboundFrame, OutboundFrame } from '../channel/frames';
import type { SlotId } from '../domain/forms';
import { FORMS } from '../domain/forms';
import { INTENT_LABELS, INTENT_MENU, isFormIntent, type FormId } from '../domain/intents';
import { allSlots, slotsFor, type SlotContext } from '../domain/slots';
import { describeWindow, type DateWindow } from './extract/date';
import { candidateSpans } from './spans';
import { cloneSession, emptySlot, missingSlots, setForm, type Session } from './session';
import { buildTurnState, type TurnState } from './state';
import { buildQuestions } from './questions';
import { evaluateGates, type GateRow, type Verdict } from './gates';
import { applyDtmf, fillSlots, nextPrompt, pendingSlotConfirmation, retryStep, type Ack, type FillEvent } from './fia';
import type { Decision, PromptDecision } from './decision';
import type { Thresholds } from './thresholds';
import { decisionToFrames, handoffPromptId, spokenText } from '../prompts/render';

export interface TurnContext {
  nowMs: number;
  todayIso: string;
  thresholds: Thresholds;
}

export interface Plan {
  needsModel: boolean;
  turnState: TurnState | null;
  questions: QuestionMap | null;
}

export interface TurnError {
  name: string;
  message: string;
}

export interface TurnResult {
  session: Session;
  turnState: TurnState | null;
  rows: GateRow[];
  verdict: Verdict | null;
  fillEvents: FillEvent[];
  decision: Decision;
  frames: OutboundFrame[];
}

function slotContext(session: Session, text: string, tc: TurnContext): SlotContext {
  return {
    text,
    candidateSpans: candidateSpans(text),
    todayIso: tc.todayIso,
    thresholds: tc.thresholds,
    // A pending window constrains what a bare weekday can mean on the next turn.
    window: session.slots.date.window,
  };
}

/** Gate 8's threshold per slot kind: memberId is detected, the choice slots are picked. */
function slotThreshold(slot: SlotId, t: Thresholds): number {
  return slot === 'memberId' ? t.SLOT_DETECT : t.SLOT_CHOICE_CONFIRM;
}

/** Spec §6 gate 8: one row per slot the turn tried to fill, so the debug table is complete. */
function slotRows(events: FillEvent[], t: Thresholds): GateRow[] {
  return events.map(({ slot, outcome }) => ({
    gate: `slot:${slot}`,
    value: outcome.kind === 'filled' || outcome.kind === 'window' ? outcome.confidence : null,
    threshold: slotThreshold(slot, t),
    passed: outcome.kind === 'filled' || outcome.kind === 'window' || outcome.kind === 'disambiguate',
    outcome: outcome.kind === 'invalid' ? `${outcome.kind}:${outcome.reason}` : outcome.kind,
    decided: false,
  }));
}

/** A keypad fill answers no question, so it carries neither a confidence nor a threshold. */
function dtmfRow(slot: SlotId): GateRow {
  return { gate: `slot:${slot}`, value: null, threshold: null, passed: true, outcome: 'dtmf', decided: false };
}

export function plan(session: Session, event: InboundFrame, tc: TurnContext): Plan {
  if (event.type !== 'prompt' || session.ended) return { needsModel: false, turnState: null, questions: null };
  const turnState = buildTurnState(session, { text: event.voicePrompt, isFinal: event.last, dtmf: session.dtmfBuffer || null }, tc.nowMs);
  const questions = buildQuestions(session, slotContext(session, event.voicePrompt, tc));
  return { needsModel: true, turnState, questions };
}

function prompt(promptId: string, target: PromptDecision['target'], vars: Record<string, string> = {}, acks: Ack[] = [], options: string[] = []): PromptDecision {
  return { kind: 'prompt', promptId, vars, acks, target, options };
}

function handoff(reason: string): Decision {
  return { kind: 'handoff', reason, promptId: handoffPromptId(reason) };
}

function askSlot(slot: SlotId, window: DateWindow | null, acks: Ack[]): PromptDecision {
  if (window) return prompt('date_narrow_window', slot, { window: describeWindow(window) }, acks);
  return prompt(`ask_${slot}`, slot, {}, acks);
}

function completeForm(s: Session, form: FormId): Decision {
  const completion = FORMS[form].completion;
  if (completion.kind === 'handoff') return handoff(completion.reason);
  const vars: Record<string, string> = {};
  for (const id of Object.keys(s.slots) as SlotId[]) vars[id] = s.slots[id].display ?? '';
  return { kind: 'complete', form, promptId: completion.promptId, vars };
}

function failAttempt(s: Session, target: 'intent' | SlotId, t: Thresholds): Decision {
  const attempts = target === 'intent' ? ++s.intentAttempts : ++s.slots[target].attempts;
  const step = retryStep(attempts, t);
  if (step === 'agent') return handoff('max-attempts');
  if (target === 'intent') {
    if (step === 'dtmf') return { ...prompt('nomatch_dtmf_menu', 'intent', {}, [], INTENT_MENU.map((m) => m.digit)), menu: true };
    return prompt('nomatch_open', 'intent');
  }
  // A slot narrowed to a window re-asks the window question, not the generic retry:
  // "which day next week?" is what the caller failed to answer.
  const window = s.slots[target].window;
  if (step === 'open' && window) return askSlot(target, window, []);
  return prompt(step === 'dtmf' ? `ask_${target}_dtmf` : `ask_${target}_retry`, target);
}

/** A confirmation the caller did not answer stands; re-ask it until the retry policy runs out. */
function reaskConfirmation(s: Session, t: Thresholds): Decision {
  const pc = s.pendingConfirmation!;
  if (pc.target === 'slot') {
    const st = s.slots[pc.slot];
    const attempts = ++st.attempts;
    const step = retryStep(attempts, t);
    if (step === 'agent') { s.pendingConfirmation = null; return handoff('max-attempts'); }
    // A readback the caller never answers burns the same attempts as a wrong value, so it
    // lands on the keypad rather than looping on a value we still cannot vouch for.
    if (step === 'dtmf') {
      s.pendingConfirmation = null;
      Object.assign(st, emptySlot(), { attempts });
      return prompt(`ask_${pc.slot}_dtmf`, pc.slot);
    }
    return prompt(`confirm_${pc.slot}`, pc.slot, { [pc.slot]: pc.display }, [], ['yes', 'no']);
  }
  s.intentAttempts += 1;
  if (retryStep(s.intentAttempts, t) === 'agent') {
    s.pendingConfirmation = null;
    return handoff('max-attempts');
  }
  return prompt('confirm_intent_explicit', 'intent', { intentLabel: INTENT_LABELS[pc.intent] }, [], ['yes', 'no']);
}

/** After slots changed: disambiguate, ask the next slot, or complete. */
function continueForm(s: Session, acks: Ack[], disambiguate: { slot: SlotId; a: { display: string }; b: { display: string } } | null): Decision {
  if (disambiguate) {
    return prompt(`disambiguate_${disambiguate.slot}`, disambiguate.slot, { a: disambiguate.a.display, b: disambiguate.b.display }, acks, [disambiguate.a.display, disambiguate.b.display]);
  }
  const readback = pendingSlotConfirmation(s);
  if (readback) {
    s.pendingConfirmation = readback;
    return prompt(`confirm_${readback.slot}`, readback.slot, { [readback.slot]: readback.display }, acks, ['yes', 'no']);
  }
  const next = nextPrompt(s);
  if (next.kind === 'complete') return completeForm(s, s.form!);
  return askSlot(next.slot, next.window, acks);
}

function enterForm(s: Session, form: FormId, confirm: 'none' | 'implicit', answers: AnswerMap, ctx: SlotContext): { decision: Decision; events: FillEvent[] } {
  // Leaving a form the caller was already in is always said out loud, however sure the
  // intent was: silently swapping the task underneath them is the confusing case.
  const switching = s.form !== null && s.form !== form;
  setForm(s, form);
  const acks: Ack[] = confirm === 'implicit' || switching ? [{ promptId: 'ack_intent', vars: { intentLabel: INTENT_LABELS[form] } }] : [];
  const fill = fillSlots(s, answers, ctx, slotsFor(form));
  return { decision: continueForm(s, [...acks, ...fill.acks], fill.disambiguate), events: fill.events };
}

function handleVerdict(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, tc: TurnContext): { decision: Decision; events: FillEvent[] } {
  const t = tc.thresholds;
  switch (verdict.kind) {
    case 'ignore':
      return { decision: { kind: 'ignore' }, events: [] };
    case 'hold':
      return { decision: { kind: 'hold' }, events: [] };
    case 'nomatch':
      // An unintelligible answer to a confirmation is an unanswered confirmation,
      // not a slot nomatch; leaving the confirmation pending would let it go stale.
      if (s.pendingConfirmation) return { decision: reaskConfirmation(s, t), events: [] };
      return { decision: failAttempt(s, s.promptedFor ?? 'intent', t), events: [] };
    case 'handoff':
      return { decision: handoff(verdict.reason), events: [] };
    case 'replay':
      return { decision: { kind: 'replay', text: s.lastPromptText }, events: [] };
    case 'confirmed': {
      const pc = s.pendingConfirmation!;
      s.pendingConfirmation = null;
      if (pc.target === 'slot') {
        // The stashed value and display go unread: the gate decided on this turn's yes
        // before any fill could run, so the slot still holds exactly what we read back.
        s.slots[pc.slot].confirmed = true;
        return { decision: continueForm(s, [], null), events: [] };
      }
      if (pc.intent === 'agent') return { decision: handoff('live-agent'), events: [] };
      if (!isFormIntent(pc.intent)) return { decision: failAttempt(s, 'intent', t), events: [] };
      // Fill from what the caller originally said, not from the "yes".
      return enterForm(s, pc.intent, 'none', pc.answers, slotContext(s, pc.text, tc));
    }
    case 'rejected': {
      const pc = s.pendingConfirmation!;
      s.pendingConfirmation = null;
      if (pc.target === 'slot') {
        // A declined readback means the spoken path failed; go straight to the keypad,
        // and let a second decline hand off rather than read a third value back.
        const st = s.slots[pc.slot];
        st.attempts = Math.max(st.attempts + 1, t.MAX_ATTEMPTS - 1);
        if (retryStep(st.attempts, t) === 'agent') return { decision: handoff('max-attempts'), events: [] };
        Object.assign(st, emptySlot(), { attempts: st.attempts });
        return { decision: prompt(`ask_${pc.slot}_dtmf`, pc.slot, {}, [{ promptId: 'ack_declined', vars: {} }]), events: [] };
      }
      // Declining a mid-form switch means "stay where we were", so resume the form
      // rather than counting an intent failure against the caller.
      if (s.form) return { decision: continueForm(s, [], null), events: [] };
      return { decision: failAttempt(s, 'intent', t), events: [] };
    }
    case 'confirm_unanswered':
      return { decision: reaskConfirmation(s, t), events: [] };
    case 'route':
      if (verdict.confirm === 'explicit') {
        s.pendingConfirmation = { target: 'intent', intent: verdict.intent, answers, text: ctx.text };
        return { decision: prompt('confirm_intent_explicit', 'intent', { intentLabel: INTENT_LABELS[verdict.intent] }, [], ['yes', 'no']), events: [] };
      }
      return enterForm(s, verdict.intent, verdict.confirm, answers, ctx);
    case 'disambiguate_intent':
      return { decision: prompt('disambiguate_intent', 'intent', { a: INTENT_LABELS[verdict.a], b: INTENT_LABELS[verdict.b] }, [], [INTENT_LABELS[verdict.a], INTENT_LABELS[verdict.b]]), events: [] };
    case 'intent_failed':
      return { decision: failAttempt(s, 'intent', t), events: [] };
    case 'queue':
      // Task 8 wires the queue; until then an added intent is treated as answering.
      return handleVerdict(s, { kind: 'proceed' }, answers, ctx, tc);
    case 'proceed': {
      const specs = s.form ? slotsFor(s.form) : allSlots();
      const fill = fillSlots(s, answers, ctx, specs);
      if (!fill.progress) {
        const target = s.promptedFor && s.promptedFor !== 'intent' ? s.promptedFor : (missingSlots(s)[0] ?? 'intent');
        return { decision: failAttempt(s, target, t), events: fill.events };
      }
      return { decision: continueForm(s, fill.acks, fill.disambiguate), events: fill.events };
    }
  }
}

function handleDtmf(s: Session, digit: string, tc: TurnContext): { decision: Decision; rows: GateRow[] } {
  s.dtmfBuffer += digit;
  if (s.menuActive) {
    const option = INTENT_MENU.find((m) => m.digit === digit);
    s.dtmfBuffer = '';
    // A wrong key is a failed menu attempt, not dead air.
    if (!option) return { decision: failAttempt(s, 'intent', tc.thresholds), rows: [] };
    if (option.intent === 'agent') return { decision: handoff('live-agent'), rows: [] };
    if (!isFormIntent(option.intent)) return { decision: { kind: 'ignore' }, rows: [] };
    setForm(s, option.intent);
    return { decision: continueForm(s, [], null), rows: [] };
  }
  const result = applyDtmf(s, s.dtmfBuffer, slotContext(s, '', tc));
  switch (result.kind) {
    case 'collecting':
      return { decision: { kind: 'ignore' }, rows: [] };
    case 'no_target':
      s.dtmfBuffer = '';
      return { decision: { kind: 'ignore' }, rows: [] };
    case 'invalid':
      s.dtmfBuffer = '';
      return { decision: failAttempt(s, result.slot, tc.thresholds), rows: [] };
    case 'filled':
      s.dtmfBuffer = '';
      s.pendingConfirmation = null;
      return { decision: continueForm(s, [], null), rows: [dtmfRow(result.slot)] };
  }
}

function handleFailure(s: Session): Decision {
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= 2) return handoff('system-failure');
  return prompt('system_slow_dtmf_hint', s.promptedFor ?? 'intent');
}

function bookkeep(s: Session, decision: Decision, verdictLabel: string): void {
  if (decision.kind === 'ignore' || decision.kind === 'hold') return;
  s.turnIndex += 1;
  s.history.push({ node: s.lastPromptId ?? 'start', intent: verdictLabel, outcome: decision.kind });
  if (decision.kind === 'prompt') {
    s.lastPromptId = decision.promptId;
    s.lastPromptText = spokenText(decision);
    s.lastPromptOptions = [...decision.options];
    s.promptedFor = decision.target;
    s.menuActive = decision.menu === true;
    s.dtmfBuffer = '';
  } else if (decision.kind === 'complete' || decision.kind === 'handoff') {
    s.lastPromptId = decision.promptId;
    s.lastPromptText = spokenText(decision);
    s.ended = true;
  }
}

export function resolve(session: Session, event: InboundFrame, answers: AnswerMap | null, tc: TurnContext, error: TurnError | null = null): TurnResult {
  const s = cloneSession(session);
  const base = { session: s, turnState: null, rows: [], verdict: null, fillEvents: [] };
  if (s.ended) return { ...base, decision: { kind: 'ignore' }, frames: [] };

  switch (event.type) {
    case 'setup': {
      const decision = prompt('greeting', 'intent');
      bookkeep(s, decision, 'setup');
      return { ...base, decision, frames: decisionToFrames(decision) };
    }
    case 'dtmf': {
      const { decision, rows } = handleDtmf(s, event.digit, tc);
      bookkeep(s, decision, `dtmf:${event.digit}`);
      return { ...base, rows, decision, frames: decisionToFrames(decision) };
    }
    case 'interrupt':
      // Barge-in is state, not a turn: the next prompt frame reports it to the model.
      s.lastInterrupt = {
        utteranceUntilInterrupt: event.utteranceUntilInterrupt,
        durationUntilInterruptMs: event.durationUntilInterruptMs,
      };
      return { ...base, decision: { kind: 'ignore' }, frames: [] };
    case 'error':
      return { ...base, decision: { kind: 'ignore' }, frames: [] };
    case 'prompt': {
      const turnState = buildTurnState(s, { text: event.voicePrompt, isFinal: event.last, dtmf: s.dtmfBuffer || null }, tc.nowMs);
      if (error || answers === null) {
        const decision = handleFailure(s);
        bookkeep(s, decision, 'error');
        // The turn state above already reported the barge-in, failed ask or not.
        s.lastInterrupt = null;
        return { ...base, turnState, decision, frames: decisionToFrames(decision) };
      }
      s.consecutiveFailures = 0;
      const ctx = slotContext(s, event.voicePrompt, tc);
      const { rows, verdict } = evaluateGates(s, turnState, answers, tc.thresholds);
      const { decision, events } = handleVerdict(s, verdict, answers, ctx, tc);
      rows.push(...slotRows(events, tc.thresholds));
      bookkeep(s, decision, verdict.kind);
      // The barge-in has now been reported to the model; it does not carry into the next turn.
      s.lastInterrupt = null;
      return { session: s, turnState, rows, verdict, fillEvents: events, decision, frames: decisionToFrames(decision) };
    }
  }
}
