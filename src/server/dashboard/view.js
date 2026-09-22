// Pure functions from dashboard events to a view model. Plain JavaScript on purpose: the browser
// loads this file as a module with no build step, and vitest imports the same file. It therefore
// imports nothing -- what it needs from the domain (the form slot lists) is mirrored below and
// pinned by a test. Types are in view.d.ts.
//
// Nothing here reads a record's `event.from`/`event.to`, or any field of a setup frame: the route
// and the observer mask those server-side, and the page shows only `call_started.from`.

/** @typedef {import('./events').DashboardEvent} DashboardEvent */

/**
 * The threshold each question id is decided against, by name. The gate ladder's own ids come from
 * src/core/gates.ts; ids missing here are the rows the ladder only reports (`info()`), which have
 * no tick to draw.
 */
const GATE_THRESHOLD = {
  addressedToSystem: 'GATE_ADDRESSED',
  intelligible: 'GATE_INTELLIGIBLE',
  utteranceComplete: 'GATE_COMPLETE',
  wantsHuman: 'GATE_WANTS_HUMAN',
  frustration: 'GATE_FRUSTRATION_HIGH',
  intentTentative: 'INTENT_TENTATIVE',
  intentChange: 'INTENT_CHANGE',
  secondIntent: 'INTENT_SECOND',
  confirmsYes: 'CONFIRM_YES',
  confirmsNo: 'CONFIRM_NO',
  changeSlot: 'SLOT_CHANGE',
  menuNumberSaid: 'MENU_NUMBER',
  providerUnsure: 'PROVIDER_UNSURE',
};

/** The ids that belong in the `gates` group: everything the ladder asks except `intent` itself. */
const GATE_IDS = new Set([
  'addressedToSystem', 'intelligible', 'utteranceComplete', 'wantsHuman', 'frustration',
  'rephrasingLastTurn', 'confusedByPrompt', 'spokeAMenuNumber', 'urgency', 'triedSelfService',
  'languageSwitch', 'intentTentative', 'intentChange', 'secondIntent', 'menuNumberSaid',
  // Only asked while a confirmation is pending, and then they get their own group; listed here
  // so a stale answer still lands somewhere sensible.
  'confirmsYes', 'confirmsNo', 'changeSlot',
]);

/** Moved into the `confirmation` group while one is pending. */
const CONFIRM_IDS = new Set(['confirmsYes', 'confirmsNo', 'changeSlot']);

/**
 * Gate rows whose name is not the question id they were decided from, so a decided row still
 * marks the right row decisive (src/core/gates.ts pushes these names).
 */
const DECIDED_ALIAS = {
  menuNumber: ['menuNumberSaid'],
  intentMargin: ['intent'],
};

/**
 * The confirmation gate reads one of the two answers, never both, so only the one its outcome
 * came from is the decisive row (src/core/gates.ts step 6).
 */
const CONFIRM_DECIDED_ALIAS = {
  confirmed: ['confirmsYes'],
  rejected: ['confirmsNo'],
};

/** Question id prefixes per slot; `containsMemberId` is the one id that does not start with its slot. */
const SLOT_PREFIX = {
  name: ['name'],
  dob: ['dob'],
  memberId: ['memberId', 'containsMemberId'],
  provider: ['provider'],
  date: ['date'],
};

/** Mirrors ALL_SLOTS in src/domain/forms.ts. Pinned by view.test.ts. */
export const ALL_SLOTS = ['name', 'dob', 'memberId', 'provider', 'date'];

/** Mirrors FORMS[form].slots in src/domain/forms.ts. Pinned by view.test.ts. */
export const FORM_SLOTS = {
  schedule_new: ['name', 'dob', 'provider', 'date'],
  reschedule: ['name', 'dob', 'provider', 'date'],
  cancel: ['name', 'dob', 'provider'],
  confirm_appointment: ['name', 'dob', 'provider'],
  billing: ['memberId'],
};

/** The chip and group order for a form, or every slot outside one. */
function slotsOf(form) {
  return form && Object.hasOwn(FORM_SLOTS, form) ? FORM_SLOTS[form] : ALL_SLOTS;
}

function slotOf(id) {
  for (const slot of ALL_SLOTS) {
    const prefixes = SLOT_PREFIX[slot] ?? [];
    if (prefixes.some((p) => id === p || id.startsWith(p))) return slot;
  }
  return null;
}

/**
 * Which threshold a row's bar draws its tick at, or null when the row is only reported.
 * `activeForm` is the form the batch was asked under, which is what the intent rung depends on.
 */
export function thresholdFor(id, thresholds, activeForm) {
  const t = thresholds ?? {};
  if (Object.hasOwn(GATE_THRESHOLD, id)) return t[GATE_THRESHOLD[id]] ?? null;
  if (/Given$/.test(id) || id === 'containsMemberId' || id === 'memberIdComplete') return t.SLOT_DETECT ?? null;
  // INTENT_ROUTE is never applied: outside a form the ladder routes from INTENT_EXPLICIT up (the
  // lowest rung that still routes, with a confirmation), and inside one only a switch at
  // INTENT_SWITCH takes the turn away from the form (src/core/gates.ts step 8).
  if (id === 'intent') return (activeForm ? t.INTENT_SWITCH : t.INTENT_EXPLICIT) ?? null;
  if (slotOf(id)) return t.SLOT_CHOICE_CONFIRM ?? null;
  return null;
}

/**
 * One row per question, with the answer folded in when present. `questions` gives the row order
 * and, before the answers arrive, the pending rows; without it the answers decide.
 */
export function decisiveRows(answers, thresholds, gateRows, questions, activeForm) {
  const ids = questions ? Object.keys(questions) : Object.keys(answers ?? {});
  const named = new Set();
  /** The row the ladder actually built for a question id, when it built one; see the score branch. */
  const byGate = new Map();
  for (const g of gateRows ?? []) {
    if (!g) continue;
    if (!byGate.has(g.gate)) byGate.set(g.gate, g);
    if (!g.decided) continue;
    named.add(g.gate);
    const alias = g.gate === 'confirmation' ? CONFIRM_DECIDED_ALIAS[g.outcome] : DECIDED_ALIAS[g.gate];
    for (const id of alias ?? []) named.add(id);
  }
  return ids.map((id) => {
    const a = answers ? answers[id] : null;
    const threshold = thresholdFor(id, thresholds, activeForm);
    if (!a) return { id, kind: 'pending', p: null, value: null, threshold, decisive: false, top: null };
    if (a.type === 'noul') {
      const p = a.noul;
      return { id, kind: 'noul', p, value: p.toFixed(2), threshold, decisive: named.has(id) || (threshold !== null && p >= threshold), top: null };
    }
    const entries = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]);
    const top = entries.slice(0, 4).map(([label, p]) => ({ label, p }));
    if (a.type === 'choice') {
      const p = a.probabilities?.[a.choice] ?? null;
      const decisive = named.has(id) || (a.choice !== 'none' && threshold !== null && p !== null && p >= threshold);
      return { id, kind: 'choice', p, value: a.choice, threshold, decisive, top };
    }
    // A score's threshold is a rule about one level (`frustration.high`), not about the winning
    // level, so a bar of the winning level's probability with that tick would compare two
    // different numbers. The bar takes the pair the ladder itself compared -- the gate row's
    // `value` and `threshold` -- and the value stays the winning level. A score no gate reads
    // (`urgency`) has no such pair, and no bar; only a gate row can call a score row decisive.
    const winner = entries[0];
    const row = byGate.get(id);
    const level = winner ? winner[0] : String(a.score ?? '');
    return {
      id, kind: a.type,
      p: typeof row?.value === 'number' ? row.value : null,
      value: level,
      threshold: typeof row?.threshold === 'number' ? row.threshold : null,
      decisive: named.has(id), top,
    };
  });
}

/** Groups rows: gates, intent, confirmation (when pending), then one group per form slot in form order. */
export function groupRows(rows, formSlots, pending) {
  const gates = { name: 'gates', rows: [] };
  const intent = { name: 'intent', rows: [] };
  const confirmation = { name: 'confirmation', rows: [] };
  const fixed = pending ? [gates, intent, confirmation] : [gates, intent];
  const slotGroups = new Map((formSlots ?? ALL_SLOTS).map((s) => [s, { name: `slot · ${s}`, rows: [] }]));
  // A slot the current form does not have is still a slot: `other` is for ids no slot claims.
  const offForm = new Map();
  const other = { name: 'other', rows: [] };
  for (const r of rows) {
    if (pending && CONFIRM_IDS.has(r.id)) confirmation.rows.push(r);
    else if (GATE_IDS.has(r.id)) gates.rows.push(r);
    else if (r.id === 'intent') intent.rows.push(r);
    else {
      const s = slotOf(r.id);
      if (s && slotGroups.has(s)) slotGroups.get(s).rows.push(r);
      else if (s) {
        if (!offForm.has(s)) offForm.set(s, { name: `slot · ${s}`, rows: [] });
        offForm.get(s).rows.push(r);
      } else other.rows.push(r);
    }
  }
  const extra = ALL_SLOTS.filter((s) => offForm.has(s)).map((s) => offForm.get(s));
  const out = fixed.concat([...slotGroups.values()], extra);
  if (other.rows.length) out.push(other);
  return out.map((g) => ({ ...g, decisive: g.rows.some((r) => r.decisive), quiet: g.rows.filter((r) => !r.decisive).length }));
}

/** A slot's pending narrowing, as the chip and the decision line say it. */
function partialLabel(w) {
  if (!w) return '';
  if (w.kind === 'dob') return `${w.month}/${w.day}`;
  return w.label ? String(w.label).replace(/_/g, ' ') : `${w.start}…${w.end}`;
}

function sameWindow(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function chipsOf(slots, prevSlots, form) {
  return slotsOf(form).map((id) => {
    const s = (slots && slots[id]) || { value: null, display: null, window: null, attempts: 0 };
    const prev = prevSlots ? prevSlots[id] : null;
    return {
      id,
      state: s.value ? 'filled' : s.window ? 'partial' : 'empty',
      label: s.value ? (s.display ?? s.value) : s.window ? partialLabel(s.window) : '',
      changed: !!prev && (prev.value !== s.value || !sameWindow(prev.window, s.window)),
      attempts: s.attempts ?? 0,
    };
  });
}

/** What this turn did to the form, in words: only the slots that moved. */
function changedSlots(slots, prevSlots) {
  const out = [];
  if (!slots) return out;
  for (const id of ALL_SLOTS) {
    const s = slots[id];
    if (!s) continue;
    const prev = prevSlots ? prevSlots[id] : null;
    if (s.value) {
      if (!prev || prev.value !== s.value) out.push(`${id} filled ${s.value}`);
    } else if (s.window && (!prev || !sameWindow(prev.window, s.window))) {
      out.push(`${id} → ${partialLabel(s.window)}`);
    } else if (prev && prev.value) {
      out.push(`${id} cleared`);
    }
  }
  return out;
}

/** Which gate decided, which slots moved, and what is asked next (spec §3.4). */
function decisionLine(record, changed) {
  const d = record.decision;
  const parts = [];
  const decided = (record.gates ?? []).find((g) => g.decided);
  if (decided) parts.push(`${decided.gate}: ${decided.outcome}`);
  parts.push(...changed);
  if (d.kind === 'prompt') parts.push(`next: ${d.promptId}`);
  else if (d.kind === 'complete') parts.push(`complete: ${d.promptId}`);
  else if (d.kind === 'handoff') parts.push(`handoff: ${d.reason}`);
  else parts.push(d.kind);
  return parts.join(' · ');
}

/**
 * The pending confirmation, with what is being confirmed: `form`, `slot` and `intent` alone say
 * only which kind of question is out. Reads both shapes of the pending state -- the session's
 * (src/core/session.ts) and the flatter one a TurnState carries.
 */
function pendingLine(pending) {
  if (!pending) return null;
  const subject = pending.target === 'form' ? pending.form : pending.target === 'intent' ? pending.intent : pending.slot ?? pending.target;
  const named = subject ?? pending.value ?? '?';
  if (pending.target === 'form') {
    // Only the form summary counts unanswered turns; an intent or slot readback has no counter.
    const attempts = typeof pending.attempts === 'number' ? ` · attempt ${pending.attempts}` : '';
    return `confirm · summary (${named})${attempts}`;
  }
  if (pending.target === 'intent') return `confirm · ${named}`;
  const value = pending.display ?? pending.value ?? '';
  return `confirm · ${named}${value ? ` → ${value}` : ''}`;
}

function askingLine(record, thresholds) {
  const id = record.promptedFor;
  if (!id || id === 'intent' || id === 'confirm') return null;
  const slot = record.slots ? record.slots[id] : null;
  if (!slot) return null;
  return `asking ${id} · attempt ${(slot.attempts ?? 0) + 1} of ${thresholds.MAX_ATTEMPTS ?? 3}`;
}

function money(usd) {
  return `$${usd.toFixed(4)}`;
}

function tokensOf(usage) {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

/** Everything one call accumulates; a second `call_started` starts from this again. */
function emptyView() {
  return {
    status: 'waiting for a call', callSid: null, turnCount: 0,
    totals: { askMs: 0, tokens: 0, usd: 0 },
    lines: [], form: null, chips: chipsOf(null, null, null), pending: null, queued: [], asking: null,
    jev: { header: 'Jev', pending: false, groups: [], decision: '' },
    thresholds: {},
  };
}

/** Folds an event list into the view the page renders. */
export function reduce(events) {
  const v = emptyView();
  let from = null;
  let ended = false;
  let prevSlots = null;
  /** The last turn whose batch reached the model, for the header of a turn that asked nothing. */
  let lastConsult = null;
  /** The previous event's clock, for how long a silence lasted. */
  let prevAt = null;
  /**
   * The action webhook publishes `ended{hangup}` before a reconnect is known, so anything that
   * only a live call produces takes the status back (spec §2.2, plan Task 4 review).
   */
  const live = () => {
    if (!ended) return;
    ended = false;
    v.status = from === null ? 'live' : `live · ${from}`;
  };
  for (const e of events) {
    const at = typeof e.at === 'number' ? e.at : null;
    switch (e.type) {
      case 'call_started':
        // The page follows one call at a time (spec §2.2): a second `call_started` is a new call,
        // and every total, line and panel starts over rather than continuing the last one's.
        Object.assign(v, emptyView());
        prevSlots = null;
        lastConsult = null;
        from = e.from;
        ended = true; // so `live()` sets the status from one place
        live();
        v.callSid = e.callSid;
        v.thresholds = e.thresholds ?? {};
        break;
      case 'asked': {
        live();
        const rows = decisiveRows(null, v.thresholds, [], e.questions, e.turnState?.activeForm ?? null);
        v.jev = {
          header: `Jev · turn ${e.turnIndex} · ${Object.keys(e.questions ?? {}).length} questions · asking…`,
          pending: true,
          groups: groupRows(rows, slotsOf(e.turnState?.activeForm ?? null), e.turnState?.pendingConfirmation ?? null),
          decision: '',
        };
        break;
      }
      case 'turn': {
        const r = e.record;
        const consulted = r.questions !== null && r.questions !== undefined;
        // An interrupt or a relay error resolves to `ignore`: the record repeats the last turn's
        // index, says nothing, and asks for nothing. It must not be counted as a turn or blank
        // the Jev panel; only its frame shows, as a marker.
        const acted = r.decision.kind !== 'ignore' && r.decision.kind !== 'hold';
        const ev = r.event;
        if (ev && ev.type === 'prompt') v.lines.push({ kind: 'caller', text: ev.voicePrompt, turn: r.turnIndex });
        else if (ev && ev.type === 'error') v.lines.push({ kind: 'marker', text: 'relay error', turn: r.turnIndex });
        // The batch went out and came back empty: say so between the caller and what the system
        // fell back to, or the panel is 32 blank bars with no explanation.
        if (consulted && r.error) v.lines.push({ kind: 'marker', text: `model error · ${r.error.name}`, turn: r.turnIndex });
        if (e.spoken) v.lines.push({ kind: 'system', text: e.spoken, promptId: r.decision.promptId ?? r.decision.kind, turn: r.turnIndex });
        if (!consulted && !acted) break;
        live();
        // `turnIndex` is already 1-based (the greeting is turn 1) and repeats on an ignored turn.
        v.turnCount = Math.max(v.turnCount, r.turnIndex);
        v.form = r.form;
        const changed = changedSlots(r.slots, prevSlots);
        v.chips = chipsOf(r.slots, prevSlots, r.form);
        prevSlots = r.slots;
        v.pending = pendingLine(r.pendingConfirmation);
        v.queued = r.queued ?? [];
        v.asking = askingLine(r, v.thresholds);
        v.totals.askMs += r.timing?.askMs ?? 0;
        v.totals.tokens += tokensOf(r.usage);
        v.totals.usd += r.usage?.costUsd ?? 0;
        const decision = decisionLine(r, changed);
        if (consulted) {
          // Both the tick the intent row draws and the groups belong to the batch, so they read
          // the state it was asked under: `turnState`. The post-turn `pendingConfirmation` is one
          // turn out -- not yet set on the turn that speaks the summary, and already cleared on
          // the turn the caller answers it, which is the turn whose confirmation rows matter.
          const askedUnder = r.turnState ?? null;
          const rows = decisiveRows(r.answers, v.thresholds, r.gates, r.questions, askedUnder?.activeForm ?? null);
          const header = [
            `Jev · turn ${r.turnIndex}`,
            `${Object.keys(r.questions).length} questions`,
            `${Math.round(r.timing?.askMs ?? 0)} ms`,
            `${tokensOf(r.usage).toLocaleString('en-US')} tokens`,
            money(r.usage?.costUsd ?? 0),
          ].join(' · ') + (r.error ? ` · error: ${r.error.name}` : '');
          // A record with a `turnState` answers this outright, including with a null: falling back
          // to the post-turn state when it says "nothing was pending" would put the group back on
          // the very turn that has no answer to group.
          const pending = askedUnder ? askedUnder.pendingConfirmation ?? null : r.pendingConfirmation ?? null;
          v.jev = { header, pending: false, groups: groupRows(rows, slotsOf(r.form), pending), decision };
          lastConsult = r.turnIndex;
        } else {
          // A turn nobody asked the model about (a silence, a keypad digit) must not blank the
          // column: the last consultation stays on screen and the header says which turn it was.
          const last = lastConsult === null ? '' : ` (last: turn ${lastConsult})`;
          v.jev = { header: `Jev · turn ${r.turnIndex} · no questions${last}`, pending: false, groups: v.jev.groups, decision };
        }
        break;
      }
      case 'silence': {
        // How long the caller was quiet, when both clocks are known (spec §3.2: `silence · 7 s`).
        const quiet = at !== null && prevAt !== null && at >= prevAt ? Math.round((at - prevAt) / 1_000) : null;
        v.lines.push({ kind: 'marker', text: quiet === null ? 'silence' : `silence · ${quiet} s` });
        break;
      }
      case 'dtmf':
        v.lines.push({ kind: 'marker', text: `keypad ${e.digit}` });
        break;
      case 'interrupt':
        v.lines.push({ kind: 'marker', text: 'interrupted' });
        break;
      case 'reconnect':
        live();
        v.lines.push({ kind: 'marker', text: `reconnected (${e.attempt})` });
        break;
      case 'handoff':
        v.lines.push({ kind: 'marker', text: `transfer to ${e.number} (${e.reason})` });
        break;
      case 'ended':
        ended = true;
        v.status = `ended · ${e.reason}`;
        break;
    }
    prevAt = at ?? prevAt;
  }
  // Merge consecutive keypad markers into one ("keypad 03051980").
  const merged = [];
  for (const l of v.lines) {
    const last = merged[merged.length - 1];
    if (l.kind === 'marker' && last && last.kind === 'marker' && /^keypad /.test(l.text) && /^keypad /.test(last.text)) {
      last.text += l.text.slice('keypad '.length);
    } else {
      merged.push({ ...l });
    }
  }
  v.lines = merged;
  return v;
}

/** The `reasonCode` an out `end` frame carries, read as the action webhook reads it (src/server/http.ts). */
function reasonCodeOf(handoffData) {
  try {
    const d = JSON.parse(String(handoffData ?? ''));
    return d && typeof d.reasonCode === 'string' ? d.reasonCode : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Live order among events sharing a timestamp: the inbound frame, then the turn it caused (with
 * its own `asked` immediately before it), then the end of the call.
 */
const REPLAY_RANK = {
  silence: 0, dtmf: 0, interrupt: 0, reconnect: 0,
  asked: 1, turn: 1,
  handoff: 2, ended: 2,
};

/**
 * Rebuilds the live event sequence from a trace file and its frame log, so the page has one
 * renderer and two sources. `records` are what `/dashboard/traces/<sid>` returns: redacted, each
 * with the `spokenText` the caller heard (the browser has no prompt manifest to render it from).
 */
export function replayEvents(records, frames, opts) {
  const events = [];
  if (!records || !records.length) return events;
  const first = records[0];
  const callSid = first.sessionId;
  events.push({
    type: 'call_started', callSid, at: Date.parse(first.ts),
    from: opts?.from ?? 'replay', todayIso: String(first.ts).slice(0, 10), thresholds: opts?.thresholds ?? {},
  });
  const lines = frames ?? [];
  // A caller hangup leaves no out `end` frame at all: the socket just closes, and the adapter logs
  // that (`socketClosed` in handleSocketClose). Only then does the close stand for the end.
  const hasEnd = lines.some((f) => f && f.dir === 'out' && (f.msg ?? {}).type === 'end');
  // The frame log records each resumed socket, not a counter; the attempt is its position.
  let resumed = 0;
  // A frame log line's `line` is its line number in the file, for a skip report; not shown here.
  const frameEvents = lines.flatMap((f) => {
    const at = Date.parse(f.ts);
    const m = f.msg ?? {};
    if (f.dir === 'in' && m.type === 'silence') return [{ type: 'silence', callSid, at, promptId: null }];
    if (f.dir === 'in' && m.type === 'dtmf') return [{ type: 'dtmf', callSid, at, digit: m.digit }];
    if (f.dir === 'in' && m.type === 'interrupt') return [{ type: 'interrupt', callSid, at, utteranceUntilInterrupt: m.utteranceUntilInterrupt ?? null }];
    if (f.dir === 'log' && m.resumed) return [{ type: 'reconnect', callSid, at, attempt: ++resumed }];
    if (f.dir === 'log' && m.socketClosed && !hasEnd) return [{ type: 'ended', callSid, at, reason: 'hangup' }];
    if (f.dir === 'out' && m.type === 'end') {
      const code = reasonCodeOf(m.handoffData);
      const out = [];
      // The number dialled is not in the trace (the adapter masks its own), so the page says only
      // that the call was transferred unless the caller passes one in.
      if (code !== 'completed') out.push({ type: 'handoff', callSid, at, reason: code, number: opts?.handoffNumber ?? '…' });
      out.push({ type: 'ended', callSid, at, reason: code === 'completed' ? 'completed' : 'handoff' });
      return out;
    }
    return [];
  });
  const turnEvents = (records ?? []).flatMap((r) => {
    const at = Date.parse(r.ts);
    const out = [];
    // Glued to its turn rather than dated `ts - askMs`: the page holds the asked state for the
    // narration beat anyway (spec §4), so a timestamp of its own buys nothing and can reorder.
    if (r.questions) {
      out.push({ type: 'asked', callSid, at, turnIndex: r.turnIndex, questions: r.questions, turnState: r.turnState });
    }
    out.push({ type: 'turn', callSid, at, record: r, spoken: r.spokenText ?? (opts?.spoken ? opts.spoken(r) : '') });
    return out;
  });
  // A silence or dtmf frame precedes the turn it caused and an end frame follows it, all three
  // sharing a timestamp, so the sort breaks ties by that order (stable, so `asked` keeps its turn).
  const rank = (e) => REPLAY_RANK[e.type] ?? 1;
  const all = frameEvents.concat(turnEvents).sort((a, b) => a.at - b.at || rank(a) - rank(b));
  return events.concat(all);
}
