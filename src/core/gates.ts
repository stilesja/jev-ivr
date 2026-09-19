import { isChoice, isScore, noulValue, rankProbabilities, type AnswerMap } from '../jev/types';
import { INTENT_MENU, isFormIntent, type FormId, type Intent } from '../domain/intents';
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

export type Verdict =
  | { kind: 'ignore' }
  | { kind: 'hold' }
  | { kind: 'nomatch' }
  | { kind: 'handoff'; reason: string }
  | { kind: 'confirmed' }
  | { kind: 'rejected' }
  | { kind: 'confirm_unanswered'; queue?: FormId }
  | { kind: 'replay' }
  | { kind: 'route'; intent: FormId; confirm: 'none' | 'implicit' | 'explicit' }
  | { kind: 'queue'; intent: FormId }
  | { kind: 'disambiguate_intent'; a: Intent; b: Intent }
  | { kind: 'intent_failed' }
  | { kind: 'proceed' };

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

  // 4. wants human
  {
    const v = noulValue(answers, 'wantsHuman');
    const passed = v < t.GATE_WANTS_HUMAN;
    const row = { gate: 'wantsHuman', value: v, threshold: t.GATE_WANTS_HUMAN, passed, outcome: passed ? 'pass' : 'handoff', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'handoff', reason: 'live-agent' });
  }

  // 5. frustration escalation (before intent; see Deviation note)
  {
    const f = answers.frustration;
    const high = isScore(f) ? (f.probabilities.high ?? 0) : 0;
    const repeat = ts.turn.attempt !== 'first';
    const passed = !(high >= t.GATE_FRUSTRATION_HIGH && repeat);
    const row = { gate: 'frustration', value: high, threshold: t.GATE_FRUSTRATION_HIGH, passed, outcome: passed ? (high >= t.GATE_FRUSTRATION_HIGH ? 'first_attempt' : 'pass') : 'handoff', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'handoff', reason: 'frustrated' });
  }

  // 6. pending explicit confirmation
  let confirmationUnanswered = false;
  if (session.pendingConfirmation) {
    const yes = noulValue(answers, 'confirmsYes');
    const no = noulValue(answers, 'confirmsNo');
    if (yes >= t.CONFIRM_YES && yes >= no) {
      decide({ gate: 'confirmation', value: yes, threshold: t.CONFIRM_YES, passed: true, outcome: 'confirmed', decided: false }, { kind: 'confirmed' });
    } else if (no >= t.CONFIRM_NO) {
      decide({ gate: 'confirmation', value: no, threshold: t.CONFIRM_NO, passed: true, outcome: 'rejected', decided: false }, { kind: 'rejected' });
    } else {
      rows.push({ gate: 'confirmation', value: Math.max(yes, no), threshold: t.CONFIRM_YES, passed: false, outcome: 'unanswered', decided: false });
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
  if (confirmationUnanswered && (routeVerdict.kind === 'intent_failed' || routeVerdict.kind === 'proceed' || routeVerdict.kind === 'queue')) {
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

  if (routeVerdict.kind === 'proceed') rows.push(intentRow);
  else decide(intentRow, routeVerdict);
  if (marginRow) {
    if (!marginRow.passed && intentRow.decided) { intentRow.decided = false; marginRow.decided = true; }
    rows.push(marginRow);
  }

  // `verdict` is only ever assigned inside the `decide` closure, so TypeScript narrows it to null here; the `??` is load-bearing at runtime.
  return { rows, verdict: verdict ?? routeVerdict };
}
