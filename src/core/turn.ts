import type { AnswerMap, QuestionMap } from '../jev/types';
import type { InboundFrame, OutboundFrame } from '../channel/frames';
import type { SlotId } from '../domain/forms';
import { ALL_SLOTS, FORMS } from '../domain/forms';
import { INTENT_LABELS, INTENT_MENU, isFormIntent, type FormId } from '../domain/intents';
import { allSlots, slotsFor, EXCLUDED_NAME_TOKENS, SLOTS, type SlotContext, type SlotPartial } from '../domain/slots';
import { describeWindow } from './extract/date';
import { candidateSpans, candidateWordSpans } from './spans';
import { cloneSession, emptySlot, missingSlots, setForm, type PendingConfirmation, type Session } from './session';
import { buildTurnState, type TurnState } from './state';
import { buildQuestions } from './questions';
import { evaluateGates, frustrationOf, type FrustrationRung, type GateRow, type Verdict } from './gates';
import { applyDtmf, fillSlots, nextPrompt, pendingSlotConfirmation, retryStep, type Ack, type FillEvent, type FillResult } from './fia';
import type { Decision, HandoffDecision, PromptDecision } from './decision';
import type { Thresholds } from './thresholds';
import { decisionToFrames, handoffPromptId, spokenText, type RenderContext } from '../prompts/render';

export interface TurnContext {
  nowMs: number;
  todayIso: string;
  thresholds: Thresholds;
  render?: RenderContext | null;
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
    candidateWordSpans: candidateWordSpans(text),
    todayIso: tc.todayIso,
    thresholds: tc.thresholds,
    excludedNameTokens: EXCLUDED_NAME_TOKENS,
    // Never a real slot's window: fillSlots and buildQuestions each substitute a spec's own
    // slot's pending partial in via slotCtx (fia.ts) before calling fill/questions, so no
    // slot's fill or questions ever sees another slot's window. applyDtmf shares this base
    // context unchanged; no spec's dtmf.parse reads window.
    window: null,
  };
}

/** Gate 8's threshold per slot kind: memberId, name and dob are detected, the choice slots are picked. */
function slotThreshold(slot: SlotId, t: Thresholds): number {
  return slot === 'memberId' || slot === 'name' || slot === 'dob' ? t.SLOT_DETECT : t.SLOT_CHOICE_CONFIRM;
}

/** Spec §6 gate 8: one row per slot the turn tried to fill, so the debug table is complete. */
function slotRows(events: FillEvent[], t: Thresholds): GateRow[] {
  return events.map(({ slot, outcome }) => ({
    gate: `slot:${slot}`,
    value: outcome.kind === 'filled' || outcome.kind === 'window' ? outcome.confidence : null,
    threshold: slotThreshold(slot, t),
    passed: outcome.kind === 'filled' || outcome.kind === 'window' || outcome.kind === 'disambiguate' || outcome.kind === 'help',
    outcome: outcome.kind === 'invalid' ? `${outcome.kind}:${outcome.reason}` : outcome.kind,
    decided: false,
  }));
}

/** A keypad fill answers no question, so it carries neither a confidence nor a threshold. */
function dtmfRow(slot: SlotId): GateRow {
  return { gate: `slot:${slot}`, value: null, threshold: null, passed: true, outcome: 'dtmf', decided: false };
}

// Only a 'prompt' event ever needs the model: 'setup', 'dtmf', 'interrupt', 'error', and the
// server-generated 'silence' event are all resolved from the session alone.
export function plan(session: Session, event: InboundFrame, tc: TurnContext): Plan {
  if (event.type !== 'prompt' || session.ended) return { needsModel: false, turnState: null, questions: null };
  const turnState = buildTurnState(session, { text: event.voicePrompt, isFinal: event.last, dtmf: session.dtmfBuffer || null }, tc.nowMs);
  const questions = buildQuestions(session, slotContext(session, event.voicePrompt, tc));
  return { needsModel: true, turnState, questions };
}

function prompt(promptId: string, target: PromptDecision['target'], vars: Record<string, string> = {}, acks: Ack[] = [], options: string[] = []): PromptDecision {
  return { kind: 'prompt', promptId, vars, acks, target, options };
}

function handoff(s: Session, reason: string, acks: Ack[] = []): HandoffDecision {
  // Whatever the caller added and the call never got to is the agent's problem now,
  // so it rides along in the handoff data -- together with what the call did collect,
  // which is the only record of it for a form that hands off without a summary.
  const slots: Record<string, string> = {};
  for (const id of ALL_SLOTS) {
    const slot = s.slots[id];
    if (slot.value !== null) slots[id] = slot.display ?? slot.value;
  }
  return { kind: 'handoff', reason, promptId: handoffPromptId(reason), acks, completed: [...s.completed], queued: [...s.queued], slots };
}

function askSlot(slot: SlotId, window: SlotPartial | null, acks: Ack[]): PromptDecision {
  if (window && 'kind' in window && window.kind === 'dob') return prompt('ask_dob_year', slot, {}, acks);
  if (window && !('kind' in window)) return prompt('date_narrow_window', slot, { window: describeWindow(window) }, acks);
  return prompt(`ask_${slot}`, slot, {}, acks);
}

/** The summary's variables: every slot's display, empty when unfilled. */
export function summaryVars(s: Session): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const id of ALL_SLOTS) vars[id] = s.slots[id].display ?? '';
  return vars;
}

/** Everything the summary just read back, as one comparable value: every slot's window too, so a
 * narrowing (a dob month/day pending its year, a date window pending its day) counts as progress. */
function summaryState(s: Session): string {
  const windows = ALL_SLOTS.map((id) => [id, s.slots[id].window] as const);
  return JSON.stringify({ vars: summaryVars(s), windows });
}

/**
 * A correction to a form the caller has already been read back. It only counts as progress when
 * it changes something: repeating the value the summary just said is a turn the caller spent not
 * answering the question, and it must walk the ladder rather than reset it (spec final-confirm §2.4).
 */
function correctingFill(s: Session, answers: AnswerMap, ctx: SlotContext, form: FormId): FillResult {
  const before = summaryState(s);
  const fill = fillSlots(s, answers, ctx, slotsFor(form), { correcting: true });
  // A disambiguation changes no slot yet and still has to be asked, so it is progress either way.
  if (!fill.progress || fill.disambiguate || summaryState(s) !== before) return fill;
  return { ...fill, progress: false };
}

/** The summary question. Only a form that has one ever sets a form confirmation (askSummary). */
function summaryPrompt(s: Session, form: FormId, acks: Ack[]): PromptDecision {
  const promptId = FORMS[form].summaryPromptId;
  if (promptId === null) throw new Error(`form ${form} has no summary prompt`);
  return prompt(promptId, 'confirm', summaryVars(s), acks, ['yes', 'no']);
}

/** The form is full: ask the summary question (spec final-confirm §2.2) instead of completing. */
function askSummary(s: Session, form: FormId, acks: Ack[]): Decision {
  // Forms that end in a handoff have nothing to confirm; they hand off as before.
  if (FORMS[form].summaryPromptId === null) return completeForm(s, form, acks);
  s.pendingConfirmation = { target: 'form', form, attempts: 0 };
  return summaryPrompt(s, form, acks);
}

/**
 * "What should I change?", which takes the place of one re-ask: it occupies the ladder's first
 * rung so that three answers with nothing usable in them still reach an agent.
 */
function askChange(pc: Extract<PendingConfirmation, { target: 'form' }>, acks: Ack[]): PromptDecision {
  pc.askedChange = true;
  pc.attempts = Math.max(pc.attempts, 1);
  return prompt('ask_change', 'confirm', {}, acks);
}

/** Add an intent the caller asked for on the side; returns the ack to speak, if it was new. */
function enqueue(s: Session, intent: FormId | undefined): Ack[] {
  if (intent === undefined || intent === s.form || s.queued.includes(intent)) return [];
  s.queued.push(intent);
  return [{ promptId: 'ack_queued', vars: { intentLabel: INTENT_LABELS[intent] } }];
}

/** Close the form: end the call, or bridge into the next queued intent with the member id carried over. */
function completeForm(s: Session, form: FormId, acks: Ack[]): Decision {
  const completion = FORMS[form].completion;
  if (completion.kind === 'handoff') return handoff(s, completion.reason, acks);
  const vars = summaryVars(s);
  // The caller has just confirmed the summary, which read this form's filled slots back to
  // them. A slot left over from an abandoned form was not in it and stays unconfirmed.
  for (const id of FORMS[form].slots) if (s.slots[id].value !== null) s.slots[id].confirmed = true;
  s.completed.push(form);
  // A form that ends in a handoff ends the call, so anything this line can finish itself
  // goes first; only when nothing else is left does the queue hand the caller over.
  const idx = s.queued.findIndex((q) => FORMS[q].completion.kind === 'prompt');
  const next = idx >= 0 ? s.queued.splice(idx, 1)[0] : s.queued.shift();
  if (!next) return { kind: 'complete', form, promptId: completion.promptId, vars, acks, completed: [...s.completed] };
  s.slots.provider = emptySlot();
  s.slots.date = emptySlot();
  setForm(s, next);
  // The request was added on this very turn, so the caller already hears it bridged into;
  // promising it "after this" as well would say the same thing twice.
  const label = INTENT_LABELS[next];
  const kept = acks.filter((a) => !(a.promptId === 'ack_queued' && a.vars.intentLabel === label));
  return continueForm(s, [...kept, { promptId: completion.promptId, vars }, { promptId: 'bridge_next', vars: { intentLabel: label } }], null);
}

/** `promptedFor` as an attempt/prompt target; before the first prompt the turn is an intent turn. */
function promptedTarget(s: Session): 'intent' | 'confirm' | SlotId {
  return s.promptedFor ?? 'intent';
}

/**
 * `plain` is true only for a silence turn's first rung: the caller never heard anything to be
 * unintelligible about, so the re-ask is the plain question, not the "Sorry, ..." retry text
 * (`nomatch_open`/`ask_<slot>_retry`), which stays reserved for an answer that missed.
 */
function failAttempt(s: Session, target: 'intent' | 'confirm' | SlotId, t: Thresholds, acks: Ack[] = [], plain = false): Decision {
  // A guard, not a path anything takes today: `nomatch` re-asks a pending confirmation before it
  // gets here and `proceed` maps a confirm target to a slot. Should a confirm turn reach it, the
  // summary's own ladder owns the attempt rather than the intent's.
  if (target === 'confirm') {
    if (s.pendingConfirmation?.target === 'form') return reaskConfirmation(s, t, acks);
    target = 'intent';
  }
  const attempts = target === 'intent' ? ++s.intentAttempts : ++s.slots[target].attempts;
  const step = retryStep(attempts, t);
  if (step === 'agent') return handoff(s, 'max-attempts', acks);
  if (target === 'intent') {
    if (step === 'dtmf') return { ...prompt('nomatch_dtmf_menu', 'intent', {}, acks, INTENT_MENU.map((m) => m.digit)), menu: true };
    if (plain) return prompt('ask_intent', 'intent', {}, acks);
    return prompt('nomatch_open', 'intent', {}, acks);
  }
  // A slot narrowed to a window re-asks the window question, not the generic retry:
  // "next week. Which day works for you?" is what the caller failed to answer.
  const window = s.slots[target].window;
  if (step === 'open' && window) return askSlot(target, window, acks);
  if (step === 'open' && plain) return askSlot(target, null, acks);
  // A slot with no keypad rung (spec §2.1) stays on the retry text through the dtmf rung too.
  const toDtmf = step === 'dtmf' && SLOTS[target].dtmf !== undefined;
  return prompt(toDtmf ? `ask_${target}_dtmf` : `ask_${target}_retry`, target, {}, acks);
}

const ACK_FRUSTRATION: Ack = { promptId: 'ack_frustration', vars: {} };

/** "Would you like me to connect you to a person, or keep going?" (spec 2026-09-22 §3). */
function offerTransfer(acks: Ack[] = []): PromptDecision {
  return prompt('offer_transfer', 'confirm', {}, acks, ['yes', 'no']);
}

type TransferConfirmation = Extract<PendingConfirmation, { target: 'transfer' }>;

/**
 * Back to wherever the call was, without counting a turn against the caller: a pending
 * confirmation asked again, an open form's next question, the plain intent question, or the
 * keypad menu. The declined transfer offer and an informational intent (spec 2026-09-24 §2.3)
 * both come back through here, because neither is a turn the caller spent failing the question
 * beneath. A transfer target never reaches here: gate 6 settles every spoken answer at the offer, and
 * `escalate` never nests an offer inside one, so `reaskConfirmation`'s transfer branch is not
 * relied on by this function. A choice named in the same breath as an informational question at
 * a confirmation is dropped, not carried into the reask: `disambiguate` only reaches
 * `continueForm`, and a pending confirmation is re-asked as it was.
 */
function resume(s: Session, t: Thresholds, acks: Ack[], disambiguate: FillResult['disambiguate'] = null, help: FillResult['help'] = null): Decision {
  if (s.pendingConfirmation) return reaskConfirmation(s, t, acks, false);
  if (s.form) return continueForm(s, acks, disambiguate, help);
  // The caller was on the keypad menu before this turn: it comes back with the rung intact.
  if (s.menuActive) return { ...prompt('nomatch_dtmf_menu', 'intent', {}, acks, INTENT_MENU.map((m) => m.digit)), menu: true };
  // Before any task is started the form loop has nothing to ask: the plain intent question comes
  // back, not the "Sorry, I didn't catch that" retry.
  return prompt('ask_intent', 'intent', {}, acks);
}

/**
 * The offer turned down: by a no, by an answer that is neither a yes nor a no, or by a second
 * silence. It is not offered again on this call, and the caller goes back to the question they
 * were on -- declining costs them no attempt, since they did answer the question we asked.
 */
function declineTransfer(s: Session, t: Thresholds, pc: TransferConfirmation, acks: Ack[]): Decision {
  s.transferDeclined = true;
  // A confirmation the offer displaced comes back rather than being dropped: an explicit intent
  // confirm still holds the caller's request, and a summary still holds its attempt count.
  s.pendingConfirmation = pc.resume ?? null;
  return resume(s, t, acks);
}

/**
 * A confirmation the caller did not answer stands; re-ask it until the retry policy runs out.
 * `count` is false when the turn spent itself adding a request rather than dodging the
 * question, which is not a failed answer and must not walk the caller toward the keypad.
 */
function reaskConfirmation(s: Session, t: Thresholds, acks: Ack[] = [], count = true): Decision {
  const pc = s.pendingConfirmation!;
  if (pc.target === 'slot') {
    const st = s.slots[pc.slot];
    if (!count) return prompt(`confirm_${pc.slot}`, pc.slot, { [pc.slot]: pc.display }, acks, ['yes', 'no']);
    const attempts = ++st.attempts;
    const step = retryStep(attempts, t);
    if (step === 'agent') { s.pendingConfirmation = null; return handoff(s, 'max-attempts', acks); }
    // A readback the caller never answers burns the same attempts as a wrong value, so it
    // lands on the keypad rather than looping on a value we still cannot vouch for.
    if (step === 'dtmf') {
      s.pendingConfirmation = null;
      Object.assign(st, emptySlot(), { attempts });
      return prompt(`ask_${pc.slot}_dtmf`, pc.slot, {}, acks);
    }
    return prompt(`confirm_${pc.slot}`, pc.slot, { [pc.slot]: pc.display }, acks, ['yes', 'no']);
  }
  if (pc.target === 'transfer') {
    // Only silence gets here: the gate settles every spoken answer to the offer, as a transfer or
    // as a decline, so `count` never has anything to say about it. The offer never walks to the
    // keypad or to an agent -- a second silence declines it and the call carries on (spec §3).
    pc.attempts += 1;
    if (pc.attempts >= 2) return declineTransfer(s, t, pc, acks);
    return offerTransfer(acks);
  }
  if (pc.target === 'form') {
    if (!count) return summaryPrompt(s, pc.form, acks);
    pc.attempts += 1;
    const step = retryStep(pc.attempts, t);
    if (step === 'agent') { s.pendingConfirmation = null; return handoff(s, 'max-attempts', acks); }
    // A summary the caller keeps talking past is offered on the keypad rather than read again.
    if (step === 'dtmf') return prompt('confirm_dtmf', 'confirm', {}, acks, ['1', '2']);
    return summaryPrompt(s, pc.form, acks);
  }
  if (!count) return prompt('confirm_intent_explicit', 'intent', { intentLabel: INTENT_LABELS[pc.intent] }, acks, ['yes', 'no']);
  s.intentAttempts += 1;
  if (retryStep(s.intentAttempts, t) === 'agent') {
    s.pendingConfirmation = null;
    return handoff(s, 'max-attempts', acks);
  }
  return prompt('confirm_intent_explicit', 'intent', { intentLabel: INTENT_LABELS[pc.intent] }, acks, ['yes', 'no']);
}

const NO_INPUT_ACK: Ack = { promptId: 'no_input', vars: {} };

/** Spec no-input §3: silence is an unanswered turn on whatever was prompted; no model is asked. */
function handleSilence(s: Session, t: Thresholds): Decision {
  if (s.promptedFor === null) return { kind: 'ignore' };
  s.dtmfBuffer = '';
  if (s.pendingConfirmation) return reaskConfirmation(s, t, [NO_INPUT_ACK]);
  // `promptedFor === 'confirm'` without a pending confirmation cannot happen; the fallback is defensive.
  return failAttempt(s, s.promptedFor === 'confirm' ? 'intent' : s.promptedFor, t, [NO_INPUT_ACK], true);
}

/** After slots changed: disambiguate, ask the next slot, or complete. */
function continueForm(s: Session, acks: Ack[], disambiguate: FillResult['disambiguate'], help: FillResult['help'] = null): Decision {
  // Gates never proceed outside a form, but the defensive queue path can; re-ask for an intent rather than crash.
  if (!s.form) return prompt('nomatch_open', 'intent', {}, acks);
  if (disambiguate) {
    return prompt(`disambiguate_${disambiguate.slot}`, disambiguate.slot, { a: disambiguate.a.display, b: disambiguate.b.display }, acks, [disambiguate.a.display, disambiguate.b.display]);
  }
  const readback = pendingSlotConfirmation(s);
  if (readback) {
    s.pendingConfirmation = readback;
    return prompt(`confirm_${readback.slot}`, readback.slot, { [readback.slot]: readback.display }, acks, ['yes', 'no']);
  }
  const next = nextPrompt(s);
  // The caller said whether they know the answer rather than answering: the slot's help prompt
  // takes the question's place this once, and the attempt count does not move (spec 2026-09-24
  // §3.3) -- but only when the form would still ask that slot next; otherwise the question the
  // form actually owes wins, and the help decision is dropped along with it.
  if (help && next.kind === 'ask' && next.slot === help.slot) return { ...prompt(help.promptId, help.slot, {}, acks), help };
  if (next.kind === 'complete') return askSummary(s, s.form, acks);
  return askSlot(next.slot, next.window, acks);
}

function enterForm(s: Session, form: FormId, confirm: 'none' | 'implicit', answers: AnswerMap, ctx: SlotContext, queue?: FormId): { decision: Decision; events: FillEvent[] } {
  // Leaving a form the caller was already in is always said out loud, however sure the
  // intent was: silently swapping the task underneath them is the confusing case.
  const switching = s.form !== null && s.form !== form;
  setForm(s, form);
  // Queued after setForm, so the queue is read against the form actually being entered.
  // A task added on this same utterance is promised before the one being started is named.
  const acks: Ack[] = [...enqueue(s, queue), ...(confirm === 'implicit' || switching ? [{ promptId: 'ack_intent', vars: { intentLabel: INTENT_LABELS[form] } }] : [])];
  const fill = fillSlots(s, answers, ctx, slotsFor(form));
  return { decision: continueForm(s, [...acks, ...fill.acks], fill.disambiguate, fill.help), events: fill.events };
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
      return { decision: failAttempt(s, promptedTarget(s), t), events: [] };
    case 'handoff':
      return { decision: handoff(s, verdict.reason), events: [] };
    case 'replay':
      return { decision: { kind: 'replay', text: s.lastPromptText }, events: [] };
    case 'inform': {
      // The answer plays as an ack in front of the question the caller was on. What else the
      // breath carried still fills, as on the queue verdict; no attempt counter moves.
      const fill = fillSlots(s, answers, ctx, s.form ? slotsFor(s.form) : allSlots());
      return { decision: resume(s, t, [{ promptId: verdict.promptId, vars: {} }, ...fill.acks], fill.disambiguate, fill.help), events: fill.events };
    }
    case 'confirmed': {
      const pc = s.pendingConfirmation!;
      s.pendingConfirmation = null;
      if (pc.target === 'slot') {
        // The stashed value and display go unread: the gate decided on this turn's yes
        // before any fill could run, so the slot still holds exactly what we read back.
        s.slots[pc.slot].confirmed = true;
        return { decision: continueForm(s, [], null), events: [] };
      }
      if (pc.target === 'form') {
        const acks = enqueue(s, verdict.queue);
        return { decision: completeForm(s, pc.form, acks), events: [] };
      }
      // The offer was accepted: the transfer the caller was offered is the one they get.
      if (pc.target === 'transfer') return { decision: handoff(s, 'frustrated'), events: [] };
      if (pc.intent === 'agent') return { decision: handoff(s, 'live-agent'), events: [] };
      if (!isFormIntent(pc.intent)) return { decision: failAttempt(s, 'intent', t), events: [] };
      // Fill from what the caller originally said, not from the "yes".
      return enterForm(s, pc.intent, 'none', pc.answers, slotContext(s, pc.text, tc));
    }
    case 'rejected': {
      const pc = s.pendingConfirmation!;
      s.pendingConfirmation = null;
      if (pc.target === 'form') {
        const acks = enqueue(s, verdict.queue);
        // "No, Thursday" corrects and re-asks in one turn; continueForm re-arms the summary with a
        // fresh attempt count once the corrected slot -- or the narrowing it needs -- is settled.
        const fill = correctingFill(s, answers, ctx, pc.form);
        if (fill.progress) return { decision: continueForm(s, [...acks, ...fill.acks], fill.disambiguate), events: fill.events };
        // Nothing usable came with the no: ask what to change and keep the summary pending. That
        // question is asked once per summary; a caller who answers it with another bare no has
        // spent a turn on the confirmation, so the ladder counts it (keypad, then an agent).
        s.pendingConfirmation = pc;
        if (pc.askedChange === true) return { decision: reaskConfirmation(s, t, acks), events: fill.events };
        return { decision: askChange(pc, acks), events: fill.events };
      }
      if (pc.target === 'transfer') {
        // Spec 2026-09-22 §3: the answer is an ordinary utterance as well, so whatever it filled
        // stands and the form loop asks whatever is next -- "no, keep going" re-asks the question
        // the caller was on, and "keep going, it's Dr. Chen" answers it on the way past.
        const fill = fillSlots(s, answers, ctx, s.form ? slotsFor(s.form) : allSlots());
        return { decision: declineTransfer(s, t, pc, fill.acks), events: fill.events };
      }
      if (pc.target === 'slot') {
        // A declined readback means the spoken path failed; go straight to the keypad,
        // and let a second decline hand off rather than read a third value back.
        const st = s.slots[pc.slot];
        st.attempts = Math.max(st.attempts + 1, t.MAX_ATTEMPTS - 1);
        if (retryStep(st.attempts, t) === 'agent') return { decision: handoff(s, 'max-attempts'), events: [] };
        Object.assign(st, emptySlot(), { attempts: st.attempts });
        return { decision: prompt(`ask_${pc.slot}_dtmf`, pc.slot, {}, [{ promptId: 'ack_declined', vars: {} }]), events: [] };
      }
      // Declining a mid-form switch means "stay where we were", so resume the form
      // rather than counting an intent failure against the caller.
      if (s.form) return { decision: continueForm(s, [], null), events: [] };
      return { decision: failAttempt(s, 'intent', t), events: [] };
    }
    case 'confirm_unanswered': {
      // The confirmation still owns the turn, but an added request is not lost on the way:
      // it joins the queue and is acked in front of the re-asked confirmation.
      const acks = enqueue(s, verdict.queue);
      const pc = s.pendingConfirmation;
      if (pc?.target === 'form') {
        // A correction is a correction whether or not the caller prefixed it with "no", and an
        // answer to ask_change is read for a value before it is read for a slot name (spec
        // final-confirm §2.2 cases 2 and 3).
        const fill = correctingFill(s, answers, ctx, pc.form);
        if (fill.progress) {
          s.pendingConfirmation = null;
          return { decision: continueForm(s, [...acks, ...fill.acks], fill.disambiguate), events: fill.events };
        }
        return { decision: reaskConfirmation(s, t, acks, acks.length === 0), events: fill.events };
      }
      // Only a request that actually joined the queue buys the turn: asking for the same thing
      // twice is a turn spent, and must not hold the ladder at zero forever.
      return { decision: reaskConfirmation(s, t, acks, acks.length === 0), events: [] };
    }
    case 'change_slot': {
      const acks = enqueue(s, verdict.queue);
      const form = s.pendingConfirmation?.target === 'form' ? s.pendingConfirmation.form : s.form;
      s.pendingConfirmation = null;
      // "Not that doctor, make it Alvarez" names a detail and replaces it in one breath: the value
      // it carries is worth more than the question we would otherwise ask (spec §2.2 case 2). Only
      // a new value for the slot they named answers it, though: "not that doctor, Thursday" moves
      // the date and still leaves the doctor to ask for.
      const fill = form ? correctingFill(s, answers, ctx, form) : null;
      // `fill.progress` is what keeps a re-speak of the value the summary just read back off this
      // path: naming a detail and repeating it unchanged answers nothing, so it reopens the slot
      // rather than re-arming the summary with a fresh attempt count.
      const named = fill?.progress === true
        && fill.events.some((e) => e.slot === verdict.slot && (e.outcome.kind === 'filled' || e.outcome.kind === 'window' || e.outcome.kind === 'disambiguate'));
      if (named) return { decision: continueForm(s, [...acks, ...fill!.acks], fill!.disambiguate), events: fill!.events };
      // The named slot is asked from scratch, but the attempts it already cost stand: a caller
      // who could not say it the first time should not start the ladder over. Whatever else the
      // same breath filled is kept, and acked on the way into the question.
      const st = s.slots[verdict.slot];
      Object.assign(st, emptySlot(), { attempts: st.attempts });
      return { decision: askSlot(verdict.slot, null, [...acks, ...(fill?.acks ?? [])]), events: fill?.events ?? [] };
    }
    case 'route':
      if (verdict.confirm === 'explicit') {
        s.pendingConfirmation = { target: 'intent', intent: verdict.intent, answers, text: ctx.text };
        return { decision: prompt('confirm_intent_explicit', 'intent', { intentLabel: INTENT_LABELS[verdict.intent] }, [], ['yes', 'no']), events: [] };
      }
      // A second task named on the same breath as the first is queued as the form opens;
      // on an explicit-confirm route it is dropped (spec final-confirm §4) and the caller can re-add it.
      return enterForm(s, verdict.intent, verdict.confirm, answers, ctx, verdict.queue);
    case 'disambiguate_intent':
      return { decision: prompt('disambiguate_intent', 'intent', { a: INTENT_LABELS[verdict.a], b: INTENT_LABELS[verdict.b] }, [], [INTENT_LABELS[verdict.a], INTENT_LABELS[verdict.b]]), events: [] };
    case 'intent_failed':
      return { decision: failAttempt(s, 'intent', t), events: [] };
    case 'queue': {
      // The gates only emit queue inside a form; without one there is nothing to add to.
      if (!s.form) return handleVerdict(s, { kind: 'proceed' }, answers, ctx, tc);
      const acks = enqueue(s, verdict.intent);
      const fill = fillSlots(s, answers, ctx, slotsFor(s.form));
      // Adding a request is not a failed answer: re-ask the open slot without counting an attempt.
      return { decision: continueForm(s, [...acks, ...fill.acks], fill.disambiguate, fill.help), events: fill.events };
    }
    case 'proceed': {
      const specs = s.form ? slotsFor(s.form) : allSlots();
      const fill = fillSlots(s, answers, ctx, specs);
      if (!fill.progress) {
        // Nothing to blame the failure on when the prompt was not a slot's: the slot the form
        // needs next takes the attempt, so the retry ladder still walks somewhere.
        const asked = promptedTarget(s);
        const target = asked === 'intent' || asked === 'confirm' ? (missingSlots(s)[0] ?? 'intent') : asked;
        return { decision: failAttempt(s, target, t), events: fill.events };
      }
      return { decision: continueForm(s, fill.acks, fill.disambiguate, fill.help), events: fill.events };
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
    if (option.intent === 'agent') return { decision: handoff(s, 'live-agent'), rows: [] };
    if (!isFormIntent(option.intent)) return { decision: { kind: 'ignore' }, rows: [] };
    setForm(s, option.intent);
    return { decision: continueForm(s, [], null), rows: [] };
  }
  // The summary's keypad fallback: 1 confirms, 2 opens the change question, anything else is a miss.
  if (s.promptedFor === 'confirm' && s.pendingConfirmation?.target === 'form') {
    const pc = s.pendingConfirmation;
    s.dtmfBuffer = '';
    // Only where the keys mean something: the summary itself ("yes or no"), the keypad prompt that
    // names them, and the slow-turn hint, which offers the keypad in so many words. At ask_change a
    // digit answers nothing, so it is not a missed turn either.
    const summaryId = FORMS[pc.form].summaryPromptId;
    const advertised = s.lastPromptId === 'confirm_dtmf' || s.lastPromptId === 'system_slow_dtmf_hint'
      || (summaryId !== null && s.lastPromptId === summaryId);
    if (!advertised) return { decision: { kind: 'ignore' }, rows: [] };
    if (digit === '1') {
      s.pendingConfirmation = null;
      return { decision: completeForm(s, pc.form, []), rows: [] };
    }
    if (digit === '2') return { decision: askChange(pc, []), rows: [] };
    return { decision: reaskConfirmation(s, tc.thresholds), rows: [] };
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

/**
 * The frustration rungs the gate reached, applied to what the turn was going to say anyway
 * (spec 2026-09-22 §2). Only a prompt can carry them: a decision that ends the call says its own
 * line, and an ignored or held turn says nothing at all, so neither is a place to react.
 */
function escalate(s: Session, decision: Decision, rung: FrustrationRung | undefined): Decision {
  if (rung === undefined || decision.kind !== 'prompt') return decision;
  if (rung === 'ack') return { ...decision, acks: [ACK_FRUSTRATION, ...decision.acks] };
  // The offer takes the place of the question this turn would have asked. What the turn filled or
  // routed stands, and the question comes back once the offer is answered -- from the form loop,
  // or, where this turn had armed a confirmation of its own, from `resume` (spec §3).
  const displaced = s.pendingConfirmation;
  s.pendingConfirmation = displaced !== null && displaced.target !== 'transfer'
    ? { target: 'transfer', attempts: 0, resume: displaced }
    : { target: 'transfer', attempts: 0 };
  s.promptedFor = 'confirm';
  return offerTransfer(decision.acks);
}

function handleFailure(s: Session): Decision {
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= 2) return handoff(s, 'system-failure');
  return prompt('system_slow_dtmf_hint', promptedTarget(s));
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
    // A help prompt is recorded only once it is the decision actually spoken: `escalate` can
    // still replace it with the transfer offer, whose own decision carries no `help` of its own.
    if (decision.help) s.slots[decision.help.slot].helped.push(decision.help.promptId);
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
      return { ...base, decision, frames: decisionToFrames(decision, tc.render) };
    }
    case 'dtmf': {
      const { decision, rows } = handleDtmf(s, event.digit, tc);
      bookkeep(s, decision, `dtmf:${event.digit}`);
      return { ...base, rows, decision, frames: decisionToFrames(decision, tc.render) };
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
    case 'silence': {
      const decision = handleSilence(s, tc.thresholds);
      bookkeep(s, decision, 'silence');
      // Silence resolves whatever was prompted; a stale barge-in marker does not carry into
      // the next turn, same as a real one.
      s.lastInterrupt = null;
      return { ...base, decision, frames: decisionToFrames(decision, tc.render) };
    }
    case 'prompt': {
      const turnState = buildTurnState(s, { text: event.voicePrompt, isFinal: event.last, dtmf: s.dtmfBuffer || null }, tc.nowMs);
      if (error || answers === null) {
        const decision = handleFailure(s);
        bookkeep(s, decision, 'error');
        // The turn state above already reported the barge-in, failed ask or not.
        s.lastInterrupt = null;
        return { ...base, turnState, decision, frames: decisionToFrames(decision, tc.render) };
      }
      s.consecutiveFailures = 0;
      const ctx = slotContext(s, event.voicePrompt, tc);
      const { rows, verdict } = evaluateGates(s, turnState, answers, tc.thresholds);
      // The gate worked the rung out from the count but left the count alone; the turn owns the
      // bookkeeping, and only a verdict that carries a rung is a frustrated turn to count.
      const rung = frustrationOf(verdict);
      if (rung !== undefined) s.frustratedTurns += 1;
      const { decision: resolved, events } = handleVerdict(s, verdict, answers, ctx, tc);
      const decision = escalate(s, resolved, rung);
      rows.push(...slotRows(events, tc.thresholds));
      bookkeep(s, decision, verdict.kind);
      // The barge-in has now been reported to the model; it does not carry into the next turn.
      s.lastInterrupt = null;
      return { session: s, turnState, rows, verdict, fillEvents: events, decision, frames: decisionToFrames(decision, tc.render) };
    }
  }
}
