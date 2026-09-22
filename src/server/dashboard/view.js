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
  confirmation: ['confirmsYes', 'confirmsNo'],
  menuNumber: ['menuNumberSaid'],
  intentMargin: ['intent'],
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

/** Which threshold a row's bar draws its tick at, or null when the row is only reported. */
export function thresholdFor(id, thresholds) {
  const t = thresholds ?? {};
  if (Object.hasOwn(GATE_THRESHOLD, id)) return t[GATE_THRESHOLD[id]] ?? null;
  if (/Given$/.test(id) || id === 'containsMemberId' || id === 'memberIdComplete') return t.SLOT_DETECT ?? null;
  if (id === 'intent') return t.INTENT_ROUTE ?? null;
  if (slotOf(id)) return t.SLOT_CHOICE_CONFIRM ?? null;
  return null;
}

/**
 * One row per question, with the answer folded in when present. `questions` gives the row order
 * and, before the answers arrive, the pending rows; without it the answers decide.
 */
export function decisiveRows(answers, thresholds, gateRows, questions) {
  const ids = questions ? Object.keys(questions) : Object.keys(answers ?? {});
  const named = new Set();
  for (const g of gateRows ?? []) {
    if (!g || !g.decided) continue;
    named.add(g.gate);
    for (const alias of DECIDED_ALIAS[g.gate] ?? []) named.add(alias);
  }
  return ids.map((id) => {
    const a = answers ? answers[id] : null;
    const threshold = thresholdFor(id, thresholds);
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
    // A score's own threshold is a rule about one level (`frustration.high`), not about the
    // winning level, so only the record's gate rows can call a score row decisive.
    const winner = entries[0];
    return {
      id, kind: a.type, p: winner ? winner[1] : null, value: winner ? winner[0] : String(a.score ?? ''),
      threshold, decisive: named.has(id), top,
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
  const other = { name: 'other', rows: [] };
  for (const r of rows) {
    if (pending && CONFIRM_IDS.has(r.id)) confirmation.rows.push(r);
    else if (GATE_IDS.has(r.id)) gates.rows.push(r);
    else if (r.id === 'intent') intent.rows.push(r);
    else {
      const s = slotOf(r.id);
      if (s && slotGroups.has(s)) slotGroups.get(s).rows.push(r);
      else other.rows.push(r);
    }
  }
  const out = fixed.concat([...slotGroups.values()]);
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

function pendingLine(pending) {
  if (!pending) return null;
  // Only the form summary counts unanswered turns; an intent or slot readback has no counter.
  const attempts = typeof pending.attempts === 'number' ? ` · attempt ${pending.attempts}` : '';
  return `confirm · ${pending.target}${attempts}`;
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

/** Folds an event list into the view the page renders. */
export function reduce(events) {
  const v = {
    status: 'waiting for a call', callSid: null, turnCount: 0,
    totals: { askMs: 0, tokens: 0, usd: 0 },
    lines: [], form: null, chips: chipsOf(null, null, null), pending: null, queued: [], asking: null,
    jev: { header: 'Jev', pending: false, groups: [], decision: '' },
    thresholds: {},
  };
  let from = null;
  let ended = false;
  let prevSlots = null;
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
    switch (e.type) {
      case 'call_started':
        from = e.from;
        ended = true; // so `live()` sets the status from one place
        live();
        v.callSid = e.callSid;
        v.thresholds = e.thresholds ?? {};
        break;
      case 'asked': {
        live();
        const rows = decisiveRows(null, v.thresholds, [], e.questions);
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
          const rows = decisiveRows(r.answers, v.thresholds, r.gates, r.questions);
          const header = [
            `Jev · turn ${r.turnIndex}`,
            `${Object.keys(r.questions).length} questions`,
            `${Math.round(r.timing?.askMs ?? 0)} ms`,
            `${tokensOf(r.usage).toLocaleString('en-US')} tokens`,
            money(r.usage?.costUsd ?? 0),
          ].join(' · ');
          v.jev = { header, pending: false, groups: groupRows(rows, slotsOf(r.form), r.pendingConfirmation ?? null), decision };
        } else {
          v.jev = { header: `Jev · turn ${r.turnIndex} · no questions`, pending: false, groups: [], decision };
        }
        break;
      }
      case 'silence':
        v.lines.push({ kind: 'marker', text: 'silence' });
        break;
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
  // A frame log line's `line` is its line number in the file, for a skip report; not shown here.
  const frameEvents = (frames ?? []).flatMap((f) => {
    const at = Date.parse(f.ts);
    const m = f.msg ?? {};
    if (f.dir === 'in' && m.type === 'silence') return [{ type: 'silence', callSid, at, promptId: null }];
    if (f.dir === 'in' && m.type === 'dtmf') return [{ type: 'dtmf', callSid, at, digit: m.digit }];
    if (f.dir === 'in' && m.type === 'interrupt') return [{ type: 'interrupt', callSid, at, utteranceUntilInterrupt: m.utteranceUntilInterrupt ?? null }];
    if (f.dir === 'log' && m.resumed) return [{ type: 'reconnect', callSid, at, attempt: 1 }];
    if (f.dir === 'out' && m.type === 'end') {
      return [{ type: 'ended', callSid, at, reason: /"reasonCode":"completed"/.test(String(m.handoffData)) ? 'completed' : 'handoff' }];
    }
    return [];
  });
  const turnEvents = (records ?? []).flatMap((r) => {
    const at = Date.parse(r.ts);
    const out = [];
    if (r.questions) {
      out.push({ type: 'asked', callSid, at: at - Math.max(1, Math.round(r.timing?.askMs ?? 0)), turnIndex: r.turnIndex, questions: r.questions, turnState: r.turnState });
    }
    out.push({ type: 'turn', callSid, at, record: r, spoken: r.spokenText ?? (opts?.spoken ? opts.spoken(r) : '') });
    return out;
  });
  // A silence or dtmf frame precedes the turn it caused (same ts, logged first), so a stable sort
  // by time with turns last among equal timestamps keeps the live order.
  const all = frameEvents.concat(turnEvents).sort((a, b) => a.at - b.at || (a.type === 'turn' ? 1 : 0) - (b.type === 'turn' ? 1 : 0));
  return events.concat(all);
}
