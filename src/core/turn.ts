import type { AnswerMap, QuestionMap } from '../jev/types';
import type { InboundFrame, OutboundFrame } from '../channel/frames';
import type { SlotId } from '../domain/forms';
import { FORMS } from '../domain/forms';
import { INTENT_LABELS, INTENT_MENU, isFormIntent, type FormId } from '../domain/intents';
import { allSlots, slotsFor, type SlotContext } from '../domain/slots';
import { describeWindow, type DateWindow } from './extract/date';
import { candidateSpans } from './spans';
import { cloneSession, missingSlots, setForm, type Session } from './session';
import { buildTurnState, type TurnState } from './state';
import { buildQuestions } from './questions';
import { evaluateGates, type GateRow, type Verdict } from './gates';
import { applyDtmf, fillSlots, nextPrompt, retryStep, type Ack, type FillEvent } from './fia';
import type { Decision, PromptDecision } from './decision';
import type { Thresholds } from './thresholds';
import { decisionText, decisionToFrames, handoffPromptId } from '../prompts/render';

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

function slotContext(text: string, tc: TurnContext): SlotContext {
  return { text, candidateSpans: candidateSpans(text), todayIso: tc.todayIso, thresholds: tc.thresholds };
}

export function plan(session: Session, event: InboundFrame, tc: TurnContext): Plan {
  if (event.type !== 'prompt' || session.ended) return { needsModel: false, turnState: null, questions: null };
  const turnState = buildTurnState(session, { text: event.voicePrompt, isFinal: event.last, dtmf: null }, tc.nowMs);
  const questions = buildQuestions(session, slotContext(event.voicePrompt, tc));
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
    if (step === 'dtmf') return prompt('nomatch_dtmf_menu', 'intent', {}, [], INTENT_MENU.map((m) => m.digit));
    return prompt('nomatch_open', 'intent');
  }
  return prompt(step === 'dtmf' ? `ask_${target}_dtmf` : `ask_${target}_retry`, target);
}

/** After slots changed: disambiguate, ask the next slot, or complete. */
function continueForm(s: Session, acks: Ack[], disambiguate: { slot: SlotId; a: { display: string }; b: { display: string } } | null): Decision {
  if (disambiguate) {
    return prompt(`disambiguate_${disambiguate.slot}`, disambiguate.slot, { a: disambiguate.a.display, b: disambiguate.b.display }, acks, [disambiguate.a.display, disambiguate.b.display]);
  }
  const next = nextPrompt(s);
  if (next.kind === 'complete') return completeForm(s, s.form!);
  return askSlot(next.slot, next.window, acks);
}

function enterForm(s: Session, form: FormId, confirm: 'none' | 'implicit', answers: AnswerMap, ctx: SlotContext): { decision: Decision; events: FillEvent[] } {
  setForm(s, form);
  const acks: Ack[] = confirm === 'implicit' ? [{ promptId: 'ack_intent', vars: { intentLabel: INTENT_LABELS[form] } }] : [];
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
      return { decision: failAttempt(s, s.promptedFor ?? 'intent', t), events: [] };
    case 'handoff':
      return { decision: handoff(verdict.reason), events: [] };
    case 'replay':
      return { decision: { kind: 'replay', text: s.lastPromptText }, events: [] };
    case 'confirmed': {
      const intent = s.pendingConfirmation!.intent;
      s.pendingConfirmation = null;
      if (intent === 'agent') return { decision: handoff('live-agent'), events: [] };
      if (!isFormIntent(intent)) return { decision: failAttempt(s, 'intent', t), events: [] };
      return enterForm(s, intent, 'none', answers, ctx);
    }
    case 'rejected':
      s.pendingConfirmation = null;
      return { decision: failAttempt(s, 'intent', t), events: [] };
    case 'confirm_unanswered': {
      // The confirmation stands; re-ask it until the retry policy runs out.
      const intent = s.pendingConfirmation!.intent;
      s.intentAttempts += 1;
      if (retryStep(s.intentAttempts, t) === 'agent') {
        s.pendingConfirmation = null;
        return { decision: handoff('max-attempts'), events: [] };
      }
      return { decision: prompt('confirm_intent_explicit', 'intent', { intentLabel: INTENT_LABELS[intent] }, [], ['yes', 'no']), events: [] };
    }
    case 'route':
      if (verdict.confirm === 'explicit') {
        s.pendingConfirmation = { target: 'intent', intent: verdict.intent };
        return { decision: prompt('confirm_intent_explicit', 'intent', { intentLabel: INTENT_LABELS[verdict.intent] }, [], ['yes', 'no']), events: [] };
      }
      return enterForm(s, verdict.intent, verdict.confirm, answers, ctx);
    case 'disambiguate_intent':
      return { decision: prompt('disambiguate_intent', 'intent', { a: INTENT_LABELS[verdict.a], b: INTENT_LABELS[verdict.b] }, [], [INTENT_LABELS[verdict.a], INTENT_LABELS[verdict.b]]), events: [] };
    case 'intent_failed':
      return { decision: failAttempt(s, 'intent', t), events: [] };
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

function handleDtmf(s: Session, digit: string, tc: TurnContext): Decision {
  s.dtmfBuffer += digit;
  if (s.menuActive) {
    const option = INTENT_MENU.find((m) => m.digit === digit);
    s.dtmfBuffer = '';
    if (!option) return { kind: 'ignore' };
    if (option.intent === 'agent') return handoff('live-agent');
    if (!isFormIntent(option.intent)) return { kind: 'ignore' };
    setForm(s, option.intent);
    return continueForm(s, [], null);
  }
  const result = applyDtmf(s, s.dtmfBuffer, slotContext('', tc));
  switch (result.kind) {
    case 'collecting':
    case 'no_target':
      return { kind: 'ignore' };
    case 'invalid':
      s.dtmfBuffer = '';
      return failAttempt(s, result.slot, tc.thresholds);
    case 'filled':
      s.dtmfBuffer = '';
      return continueForm(s, [], null);
  }
}

function handleFailure(s: Session): Decision {
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= 2) return handoff('system-failure');
  return prompt('system_slow_dtmf_hint', s.promptedFor);
}

function bookkeep(s: Session, decision: Decision, verdictLabel: string): void {
  if (decision.kind === 'ignore' || decision.kind === 'hold') return;
  s.turnIndex += 1;
  s.history.push({ node: s.lastPromptId ?? 'start', intent: verdictLabel, outcome: decision.kind });
  if (decision.kind === 'prompt') {
    s.lastPromptId = decision.promptId;
    s.lastPromptText = decisionText(decision);
    s.lastPromptOptions = decision.options;
    s.promptedFor = decision.target;
    s.menuActive = decision.promptId === 'nomatch_dtmf_menu';
    s.dtmfBuffer = '';
  } else if (decision.kind === 'complete' || decision.kind === 'handoff') {
    s.lastPromptId = decision.promptId;
    s.lastPromptText = decisionText(decision);
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
      const decision = handleDtmf(s, event.digit, tc);
      bookkeep(s, decision, `dtmf:${event.digit}`);
      return { ...base, decision, frames: decisionToFrames(decision) };
    }
    case 'interrupt':
    case 'error':
      return { ...base, decision: { kind: 'ignore' }, frames: [] };
    case 'prompt': {
      const turnState = buildTurnState(s, { text: event.voicePrompt, isFinal: event.last, dtmf: null }, tc.nowMs);
      if (error || answers === null) {
        const decision = handleFailure(s);
        bookkeep(s, decision, 'error');
        return { ...base, turnState, decision, frames: decisionToFrames(decision) };
      }
      s.consecutiveFailures = 0;
      const ctx = slotContext(event.voicePrompt, tc);
      const { rows, verdict } = evaluateGates(s, turnState, answers, tc.thresholds);
      const { decision, events } = handleVerdict(s, verdict, answers, ctx, tc);
      bookkeep(s, decision, verdict.kind);
      return { session: s, turnState, rows, verdict, fillEvents: events, decision, frames: decisionToFrames(decision) };
    }
  }
}
