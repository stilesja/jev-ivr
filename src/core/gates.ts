import { isChoice, isScore, noulValue, rankProbabilities, type AnswerMap } from '../jev/types';
import { INTENT_MENU, isFormIntent, type FormId, type Intent } from '../domain/intents';
import { FORMS, type SlotId } from '../domain/forms';
import type { Session } from './session';
import type { TurnState } from './state';
import type { Thresholds } from './thresholds';

export interface GateRow {
  gate: string;
  value: number | null;
  threshold: number | null;
  passed: boolean;
  outcome: string;
  decided: boolean;
}

/**
 * The rung the frustration gate reached (spec 2026-09-22 §2): `ack` for the first frustrated turn,
 * `offer` for the second. A handoff is a verdict of its own, and a turn that is not frustrated --
 * or one that is answering the offer -- carries nothing.
 *
 * Only the verdicts that let the call go on carry it: the turn prepends the acknowledgment to the
 * prompt it was going to play, or replaces that prompt with the offer, and neither makes sense for
 * a turn that says nothing (`ignore`, `hold`), one that is already leaving (`handoff`), or a replay
 * of the last prompt.
 */
export type FrustrationRung = 'ack' | 'offer';
interface Frustrated {
  frustration?: FrustrationRung;
}

export type Verdict =
  | { kind: 'ignore' }
  | { kind: 'hold' }
  | ({ kind: 'nomatch' } & Frustrated)
  | { kind: 'handoff'; reason: string }
  | ({ kind: 'confirmed'; queue?: FormId } & Frustrated)
  | ({ kind: 'rejected'; queue?: FormId } & Frustrated)
  | ({ kind: 'confirm_unanswered'; queue?: FormId } & Frustrated)
  | ({ kind: 'change_slot'; slot: SlotId; queue?: FormId } & Frustrated)
  | { kind: 'replay' }
  | ({ kind: 'route'; intent: FormId; confirm: 'none' | 'implicit' | 'explicit'; queue?: FormId } & Frustrated)
  | ({ kind: 'queue'; intent: FormId } & Frustrated)
  | ({ kind: 'disambiguate_intent'; a: Intent; b: Intent } & Frustrated)
  | ({ kind: 'intent_failed' } & Frustrated)
  | ({ kind: 'proceed' } & Frustrated);

/** The rung a verdict carries, if it is one of the kinds that can carry one. */
export function frustrationOf(verdict: Verdict): FrustrationRung | undefined {
  return 'frustration' in verdict ? verdict.frustration : undefined;
}

/** Stamp the rung onto the verdict the gates settled on, where that verdict can carry it. */
function withFrustration(verdict: Verdict, rung: FrustrationRung | null): Verdict {
  if (rung === null) return verdict;
  switch (verdict.kind) {
    case 'ignore':
    case 'hold':
    case 'handoff':
    case 'replay':
      return verdict;
    default:
      return { ...verdict, frustration: rung };
  }
}

export interface GateResult {
  rows: GateRow[];
  verdict: Verdict;
}

export function evaluateGates(session: Session, ts: TurnState, answers: AnswerMap, t: Thresholds): GateResult {
  const rows: GateRow[] = [];
  let verdict: Verdict | null = null;

  const decide = (row: GateRow, v: Verdict): void => {
    if (verdict === null) {
      verdict = v;
      row.decided = true;
    }
    rows.push(row);
  };
  /**
   * The verdict an earlier gate has already settled on, if any. Read through a function so that
   * TypeScript uses `verdict`'s declared type: it is only ever assigned inside these closures, so
   * straight-line narrowing would have it as `null` everywhere below.
   */
  const settled = (): Verdict | null => verdict;
  /** Take the verdict away from the gate that settled it: this row decided the turn instead. */
  const resettle = (row: GateRow, v: Verdict): void => {
    for (const r of rows) r.decided = false;
    verdict = v;
    row.decided = true;
    rows.push(row);
  };
  const info = (gate: string, value: number | null, outcome = 'info'): void => {
    rows.push({ gate, value, threshold: null, passed: true, outcome, decided: false });
  };

  // 1. addressed to system
  {
    const v = noulValue(answers, 'addressedToSystem');
    const passed = v >= t.GATE_ADDRESSED;
    const row = { gate: 'addressedToSystem', value: v, threshold: t.GATE_ADDRESSED, passed, outcome: passed ? 'pass' : 'ignore', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'ignore' });
  }

  // 2. intelligible
  {
    const v = noulValue(answers, 'intelligible');
    const passed = v >= t.GATE_INTELLIGIBLE;
    const row = { gate: 'intelligible', value: v, threshold: t.GATE_INTELLIGIBLE, passed, outcome: passed ? 'pass' : 'nomatch', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'nomatch' });
  }

  // 3. utterance complete
  {
    const v = noulValue(answers, 'utteranceComplete');
    const passed = v >= t.GATE_COMPLETE;
    if (passed) rows.push({ gate: 'utteranceComplete', value: v, threshold: t.GATE_COMPLETE, passed, outcome: 'pass', decided: false });
    else if (!ts.asr.isFinal) decide({ gate: 'utteranceComplete', value: v, threshold: t.GATE_COMPLETE, passed, outcome: 'hold', decided: false }, { kind: 'hold' });
    else rows.push({ gate: 'utteranceComplete', value: v, threshold: t.GATE_COMPLETE, passed, outcome: 'noted', decided: false });
  }

  // 4. wants human. At the transfer offer this gate sees the yes before the confirmation gate
  // does -- "yes, connect me" is an explicit request for a person -- so the reason has to say
  // which transfer it is: the caller is accepting the one we offered a frustrated caller, not
  // asking out of the blue, and `frustrated` is what plays the line the offer promised.
  {
    const v = noulValue(answers, 'wantsHuman');
    const passed = v < t.GATE_WANTS_HUMAN;
    const reason = session.pendingConfirmation?.target === 'transfer' ? 'frustrated' : 'live-agent';
    const row = { gate: 'wantsHuman', value: v, threshold: t.GATE_WANTS_HUMAN, passed, outcome: passed ? 'pass' : 'handoff', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'handoff', reason });
  }

  // 5. frustration escalation (before intent; see Deviation note). The gate reads the rung off the
  // count the session carries; only the handoff is a verdict of its own, and the turn does the
  // bookkeeping (spec 2026-09-22 §2). A repeated attempt no longer matters.
  let frustrationRung: FrustrationRung | null = null;
  {
    const f = answers.frustration;
    const high = isScore(f) ? (f.probabilities.high ?? 0) : 0;
    const frustrated = high >= t.GATE_FRUSTRATION_HIGH;
    // The caller answering the offer is not counted again, however crossly they answer it.
    const atOffer = session.pendingConfirmation?.target === 'transfer';
    const count = frustrated && !atOffer ? session.frustratedTurns + 1 : session.frustratedTurns;
    const rung = !frustrated || atOffer ? 'pass'
      : count === 1 ? 'ack'
        : count === 2 && !session.transferDeclined ? 'offer'
          : 'handoff';
    const row = { gate: 'frustration', value: high, threshold: t.GATE_FRUSTRATION_HIGH, passed: rung !== 'handoff', outcome: rung, decided: false };
    if (rung !== 'handoff') rows.push(row);
    // The third rung is a verdict of its own, and `decide` is first-wins, so a verdict an earlier
    // gate already settled has to be answered for rather than quietly swallowing the transfer.
    else if (settled()?.kind === 'ignore') {
      // Gate 1 heard side speech: the outburst was not aimed at us, so there is nothing to
      // transfer out of and the row says so. The turn is not counted either -- `withFrustration`
      // never stamps an `ignore`, so the rung comes round again when the caller is talking to us.
      rows.push({ ...row, passed: true, outcome: 'not_addressed' });
    } else if (settled()?.kind === 'nomatch') {
      // Gate 2 could not make out the words, but a caller this upset for the third time gets a
      // person anyway: the rung takes the verdict off the re-ask. The `intelligible` row keeps
      // its failure and loses only the credit for deciding the turn.
      resettle(row, { kind: 'handoff', reason: 'frustrated' });
    } else decide(row, { kind: 'handoff', reason: 'frustrated' });
    frustrationRung = rung === 'ack' || rung === 'offer' ? rung : null;
  }

  // 6. pending confirmation. Intent and slot readbacks decide here. The summary (target form)
  // defers: an added intent or a correction in the same breath must not be lost to an early yes/no.
  const pending = session.pendingConfirmation;
  let confirmationUnanswered = false;
  let formConfirm: 'confirmed' | 'rejected' | null = null;
  // Kept so the summary resolution below can mark this row (rather than the intent row) as the
  // one that actually decided the verdict; `decidedGate` feeds the regress baseline and metrics.
  let confirmationRow: GateRow | null = null;
  if (pending) {
    const isForm = pending.target === 'form';
    const yes = noulValue(answers, 'confirmsYes');
    const no = noulValue(answers, 'confirmsNo');
    // The transfer offer takes anything that is not a yes as a no (spec 2026-09-22 §3): the caller
    // who answers it with a doctor's name, or with nothing much, is not asked it a second time.
    if (yes >= t.CONFIRM_YES && yes >= no) {
      confirmationRow = { gate: 'confirmation', value: yes, threshold: t.CONFIRM_YES, passed: true, outcome: 'confirmed', decided: false };
      if (isForm) { formConfirm = 'confirmed'; rows.push(confirmationRow); } else decide(confirmationRow, { kind: 'confirmed' });
    } else if (no >= t.CONFIRM_NO || pending.target === 'transfer') {
      confirmationRow = { gate: 'confirmation', value: no, threshold: t.CONFIRM_NO, passed: true, outcome: 'rejected', decided: false };
      if (isForm) { formConfirm = 'rejected'; rows.push(confirmationRow); } else decide(confirmationRow, { kind: 'rejected' });
    } else {
      confirmationRow = { gate: 'confirmation', value: Math.max(yes, no), threshold: t.CONFIRM_YES, passed: false, outcome: 'unanswered', decided: false };
      rows.push(confirmationRow);
      confirmationUnanswered = true;
    }
  }

  // 7. spoken menu number
  if (session.menuActive) {
    const m = answers.menuNumberSaid;
    const [top] = isChoice(m) ? rankProbabilities(m.probabilities) : [];
    const mapped = top && top.label !== 'none' ? INTENT_MENU.find((o) => o.digit === top.label) : undefined;
    if (top && mapped && top.p >= t.MENU_NUMBER) {
      const row = { gate: 'menuNumber', value: top.p, threshold: t.MENU_NUMBER, passed: true, outcome: `menu:${mapped.intent}`, decided: false };
      if (mapped.intent === 'agent') decide(row, { kind: 'handoff', reason: 'live-agent' });
      else if (isFormIntent(mapped.intent)) decide(row, { kind: 'route', intent: mapped.intent, confirm: 'none' });
      else rows.push(row);
    } else {
      rows.push({ gate: 'menuNumber', value: top?.p ?? null, threshold: t.MENU_NUMBER, passed: false, outcome: 'no_menu_number', decided: false });
    }
  }

  // informational rows for the debug table
  info('rephrasingLastTurn', noulValue(answers, 'rephrasingLastTurn'));
  info('confusedByPrompt', noulValue(answers, 'confusedByPrompt'));
  info('spokeAMenuNumber', noulValue(answers, 'spokeAMenuNumber'));

  // 8. intent
  const intentAnswer = answers.intent;
  const ranked = isChoice(intentAnswer) ? rankProbabilities(intentAnswer.probabilities) : [];
  const top = ranked[0] ?? { label: 'none', p: 0 };
  const second = ranked[1];
  const label = top.label as Intent;
  const activeForm = session.form;

  let routeVerdict: Verdict | null = null;
  let outcome: string;
  const tentative = noulValue(answers, 'intentTentative') >= t.INTENT_TENTATIVE;

  if (activeForm === null) {
    if (label === 'agent' && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'handoff', reason: 'live-agent' }; outcome = 'agent'; }
    else if (label === 'repeat_prompt' && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'replay' }; outcome = 'replay'; }
    else if (isFormIntent(label) && top.p >= t.INTENT_ROUTE) { routeVerdict = { kind: 'route', intent: label, confirm: 'none' }; outcome = 'route'; }
    else if (isFormIntent(label) && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'route', intent: label, confirm: 'implicit' }; outcome = 'route_implicit'; }
    else if (isFormIntent(label) && top.p >= t.INTENT_EXPLICIT) { routeVerdict = { kind: 'route', intent: label, confirm: 'explicit' }; outcome = 'route_explicit'; }
    else { routeVerdict = { kind: 'intent_failed' }; outcome = 'failed'; }
    // A hedged request is confirmed however sure the model is which request it is (spec 2026-09-19 §3.1).
    if (tentative && routeVerdict.kind === 'route' && routeVerdict.confirm !== 'explicit') {
      routeVerdict = { kind: 'route', intent: routeVerdict.intent, confirm: 'explicit' };
      outcome = 'route_tentative';
    }
  } else {
    // Spec 2026-09-19 §3.2: what the utterance does to the current task decides how the intent is used.
    const change = answers.intentChange;
    const [changeTop] = isChoice(change) ? rankProbabilities(change.probabilities) : [];
    const changePassed = changeTop !== undefined && changeTop.p >= t.INTENT_CHANGE;
    // Too unsure to act on a change is the same as answering the question we asked.
    const mode = changePassed ? changeTop.label : 'answering';
    rows.push({ gate: 'intentChange', value: changeTop?.p ?? null, threshold: t.INTENT_CHANGE, passed: changePassed, outcome: changePassed ? mode : `${mode}:below`, decided: false });

    // Only an intent that is a form other than the one in hand can add or replace.
    const other = isFormIntent(label) && label !== activeForm ? label : null;

    if (label === 'agent' && top.p >= t.INTENT_SWITCH) { routeVerdict = { kind: 'handoff', reason: 'live-agent' }; outcome = 'agent'; }
    else if (label === 'repeat_prompt' && top.p >= t.INTENT_SWITCH) { routeVerdict = { kind: 'replay' }; outcome = 'replay'; }
    else if (mode === 'answering') { routeVerdict = { kind: 'proceed' }; outcome = 'answering'; }
    else if (mode === 'adding') {
      if (other && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'queue', intent: other }; outcome = 'queue'; }
      else { routeVerdict = { kind: 'proceed' }; outcome = 'add_unused'; }
    }
    else if (mode === 'replacing') {
      if (other && top.p >= t.INTENT_SWITCH) { routeVerdict = { kind: 'route', intent: other, confirm: tentative ? 'explicit' : 'none' }; outcome = tentative ? 'switch_tentative' : 'switch'; }
      else if (other && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'route', intent: other, confirm: 'explicit' }; outcome = 'switch_explicit'; }
      else { routeVerdict = { kind: 'proceed' }; outcome = 'replace_unresolved'; }
    }
    // An unrecognized change label decides nothing; carry on with the form.
    else { routeVerdict = { kind: 'proceed' }; outcome = 'proceed'; }
  }

  // Second task on the opening utterance (spec final-confirm §4): only a plain route carries it;
  // a tentative or explicit route still gets a row, so the table shows it was named and dropped.
  if (activeForm === null && routeVerdict.kind === 'route') {
    const [secondTop] = isChoice(answers.secondIntent) ? rankProbabilities(answers.secondIntent.probabilities) : [];
    const secondTask = secondTop && secondTop.label !== 'none' && isFormIntent(secondTop.label) && secondTop.label !== routeVerdict.intent && secondTop.p >= t.INTENT_SECOND ? secondTop.label : null;
    if (secondTask && routeVerdict.confirm !== 'none') {
      rows.push({ gate: 'secondIntent', value: secondTop!.p, threshold: t.INTENT_SECOND, passed: false, outcome: 'ignored:not_plain_route', decided: false });
    } else {
      rows.push({ gate: 'secondIntent', value: secondTop?.p ?? null, threshold: t.INTENT_SECOND, passed: secondTask !== null, outcome: secondTask ? `queue:${secondTask}` : 'none', decided: false });
      if (secondTask) routeVerdict = { ...routeVerdict, queue: secondTask };
    }
  }

  // The summary's answer, combined with what the intent gate found (spec final-confirm §2.2):
  // a handoff, replay, or replacing route wins; otherwise yes/no/change/unanswered, carrying an added intent.
  let changeSlotRow: GateRow | null = null;
  // The row that actually decided a summary verdict, for the debug table and `decidedGate`:
  // the confirmation row for yes/no/unanswered, the changeSlot row for a named detail.
  let summaryDecidedRow: GateRow | null = null;
  if (pending?.target === 'form' && (routeVerdict.kind === 'proceed' || routeVerdict.kind === 'queue' || routeVerdict.kind === 'intent_failed')) {
    const queue = routeVerdict.kind === 'queue' ? routeVerdict.intent : undefined;
    const withQueue = (v: Extract<Verdict, { kind: 'confirmed' | 'rejected' | 'confirm_unanswered' | 'change_slot' }>): Verdict => (queue ? { ...v, queue } : v);
    if (formConfirm === 'confirmed') routeVerdict = withQueue({ kind: 'confirmed' });
    else {
      // A no that names the detail ("no, the doctor is wrong") says which slot to reopen, so the
      // name is read before the no is settled for. A no that carries a value instead answers the
      // question's `none`, and turn.ts fills it on the rejected path.
      const [changeTop] = isChoice(answers.changeSlot) ? rankProbabilities(answers.changeSlot.probabilities) : [];
      const named = changeTop && changeTop.label !== 'none' && changeTop.p >= t.SLOT_CHANGE && FORMS[pending.form].slots.includes(changeTop.label as SlotId) ? (changeTop.label as SlotId) : null;
      changeSlotRow = { gate: 'changeSlot', value: changeTop?.p ?? null, threshold: t.SLOT_CHANGE, passed: named !== null, outcome: named ? `change:${named}` : 'none', decided: false };
      rows.push(changeSlotRow);
      if (named) routeVerdict = withQueue({ kind: 'change_slot', slot: named });
      else if (formConfirm === 'rejected') routeVerdict = withQueue({ kind: 'rejected' });
      else routeVerdict = withQueue({ kind: 'confirm_unanswered' });
    }
    outcome = `summary_${routeVerdict.kind}`;
    summaryDecidedRow = routeVerdict.kind === 'change_slot' ? changeSlotRow : confirmationRow;
  }

  rows.push({ gate: 'intentTentative', value: noulValue(answers, 'intentTentative'), threshold: t.INTENT_TENTATIVE, passed: true, outcome: tentative ? 'tentative' : 'plain', decided: false });

  const intentRow: GateRow = {
    gate: 'intent', value: top.p, threshold: activeForm === null ? t.INTENT_EXPLICIT : t.INTENT_SWITCH,
    passed: routeVerdict.kind !== 'intent_failed', outcome: `${outcome}:${label}`, decided: false,
  };

  // A pending confirmation the caller neither answered nor talked past is a
  // confirmation retry, not an intent failure or a slot turn. Mid-form the
  // intent gate returns 'proceed', so that case has to be rescued too or the
  // confirmation goes stale and captures a later yes. A clear new route still
  // wins; enterForm/setForm clears the pending state.
  // `pending?.target !== 'form'` defends against future reordering: the summary resolution above
  // already consumes every routeVerdict.kind this rescue would otherwise map, for a form target.
  if (confirmationUnanswered && pending?.target !== 'form' && (routeVerdict.kind === 'intent_failed' || routeVerdict.kind === 'proceed' || routeVerdict.kind === 'queue')) {
    // An added intent still counts: the rescue carries it so the form can queue it
    // while the confirmation is re-asked.
    routeVerdict = routeVerdict.kind === 'queue' ? { kind: 'confirm_unanswered', queue: routeVerdict.intent } : { kind: 'confirm_unanswered' };
    intentRow.outcome = `confirm_unanswered:${label}`;
  }

  // 9. margin, whenever routing on a form intent. With normalized probabilities a
  // top-1 >= 0.60 always has margin >= 0.20, so in practice this fires inside the
  // explicit-confirm band and turns "confirm the top one" into "ask which of two".
  let marginRow: GateRow | null = null;
  if (routeVerdict.kind === 'route' && second && isFormIntent(second.label)) {
    const margin = top.p - second.p;
    const passed = margin >= t.GATE_INTENT_MARGIN;
    marginRow = { gate: 'intentMargin', value: margin, threshold: t.GATE_INTENT_MARGIN, passed, outcome: passed ? 'pass' : 'disambiguate', decided: false };
    if (!passed) routeVerdict = { kind: 'disambiguate_intent', a: label, b: second.label as Intent };
  }

  if (routeVerdict.kind === 'proceed') {
    rows.push(intentRow);
  } else if (summaryDecidedRow) {
    // The summary resolved this turn, not the intent Choice: push the intent row for the debug
    // table (with its `summary_*` outcome) but leave it undecided, and credit the row that
    // actually drove the verdict instead — same "only if nothing decided yet" rule as `decide`.
    rows.push(intentRow);
    if (verdict === null) {
      verdict = routeVerdict;
      summaryDecidedRow.decided = true;
    }
  } else {
    decide(intentRow, routeVerdict);
  }
  if (marginRow) {
    if (!marginRow.passed && intentRow.decided) { intentRow.decided = false; marginRow.decided = true; }
    rows.push(marginRow);
  }

  // `verdict` is only ever assigned inside the `decide` closure, so TypeScript narrows it to null here; the `??` is load-bearing at runtime.
  return { rows, verdict: withFrustration(verdict ?? routeVerdict, frustrationRung) };
}
