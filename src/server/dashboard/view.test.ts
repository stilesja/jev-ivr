import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { JevClientError } from '../../jev/types';
import { ALL_SLOTS as REAL_ALL_SLOTS, FORMS } from '../../domain/forms';
import type { TraceRecord } from '../../trace/types';
import type { FrameDir, FrameLogLine } from '../frameLog';
import { CALL, FROM, OPENER, TODAY, replayRecords, scripted } from './fixtures';
import { ALL_SLOTS, FORM_SLOTS, decisiveRows, groupRows, reduce, replayEvents, thresholdFor } from './view.js';
import type { DashboardEvent } from './events';

const started: DashboardEvent = { type: 'call_started', callSid: CALL, at: 0, from: FROM, todayIso: TODAY, thresholds: DEFAULT_THRESHOLDS };

/** The index in `events` of the nth `turn` event, so a prefix can end on a chosen turn. */
function turnIndexes(events: readonly DashboardEvent[]): number[] {
  const out: number[] = [];
  events.forEach((e, i) => {
    if (e.type === 'turn') out.push(i);
  });
  return out;
}

/** A `turn` event carrying only the fields under test; everything else is a plausible blank. */
function turnEvent(fields: Record<string, unknown>): DashboardEvent {
  return {
    type: 'turn', callSid: CALL, at: 10, spoken: '',
    record: {
      v: 1, sessionId: CALL, turnIndex: 2, ts: '2026-09-18T00:00:00.000Z',
      event: { type: 'prompt', voicePrompt: 'yes', lang: 'en-US', last: true },
      turnState: null, questions: null, answers: null, source: 'none', error: null,
      gates: [], decision: { kind: 'prompt', promptId: 'date_ask' }, frames: [], form: 'reschedule',
      slots: {}, timing: { planMs: 0, askMs: 0, resolveMs: 0, totalMs: 0 },
      usage: { inputTokens: 0, outputTokens: 0, estimated: true, costUsd: 0 },
      ...fields,
    },
  } as unknown as DashboardEvent;
}

const frameLine = (dir: FrameDir, msg: unknown, at: number): FrameLogLine => ({ ts: new Date(at).toISOString(), dir, msg, line: 1 });

describe('reduce', () => {
  it('shows the conversation, fills three slots from the opener, narrows, and reaches the summary', async () => {
    const { events } = await scripted([OPENER, 'Jason Stiles', 'March fifth nineteen eighty', 'Tuesday']);
    const v = reduce(events);
    expect(v.status).toBe('live · …2926');
    expect(v.callSid).toBe(CALL);
    expect(v.lines.map((l) => l.kind)).toEqual(['system', 'caller', 'system', 'caller', 'system', 'caller', 'system', 'caller', 'system']);
    expect(v.lines[0]!.text).toBe('Thanks for calling Stiles Family Medical Practice. How can I help you today?');
    expect(v.lines.at(-1)!.text).toMatch(/^Your appointment with Dr. Chen would move to Tuesday, September 22, for Jason Stiles, born March 5th, 1980/);
    expect(v.form).toBe('reschedule');
    expect(v.chips.map((c) => [c.id, c.state])).toEqual([['name', 'filled'], ['dob', 'filled'], ['provider', 'filled'], ['date', 'filled']]);
    expect(v.pending).toBe('confirm · summary (reschedule) · attempt 0');
    expect(v.turnCount).toBe(5);
    expect(v.totals.askMs).toBeGreaterThanOrEqual(0);
    expect(v.totals.tokens).toBeGreaterThan(0);
  });

  it('never renders the caller number the setup record carries', async () => {
    const { events, records } = await scripted([OPENER]);
    const setup = records[0]!.event;
    expect(setup.type).toBe('setup');
    const rendered = JSON.stringify(reduce(events));
    for (const n of ['+15550000001', '+15550000002']) expect(rendered).not.toContain(n);
    expect(rendered).toContain(FROM);
  });

  it('marks a partial chip after "next week" and flashes chips that changed on the last turn', async () => {
    const { events } = await scripted([OPENER, 'Jason Stiles']);
    const v = reduce(events);
    const date = v.chips.find((c) => c.id === 'date')!;
    expect(date.state).toBe('partial');
    expect(date.label).toMatch(/next week/);
    expect(v.chips.find((c) => c.id === 'name')!.changed).toBe(true);
    expect(v.chips.find((c) => c.id === 'provider')!.changed).toBe(false);
  });

  it('shows a correction refilling two slots and a queued task', async () => {
    const { events } = await scripted([
      OPENER,
      'Jason Stiles',
      'March fifth nineteen eighty',
      'and can I also ask about my bill',
      'Tuesday',
      'no, Thursday with Dr. Alvarez',
    ]);
    const v = reduce(events);
    expect(v.queued).toEqual(['billing']);
    expect(v.chips.filter((c) => c.changed).map((c) => c.id).sort()).toEqual(['date', 'provider']);
    expect(v.chips.find((c) => c.id === 'provider')!.label).toBe('Dr. Alvarez');
  });

  it('renders silence markers with how long the caller was quiet', async () => {
    const { events } = await scripted(['I need to reschedule my appointment with Dr. Chen', { silence: true }, { silence: true }, { silence: true }]);
    const v = reduce(events);
    expect(v.lines.filter((l) => l.kind === 'marker').map((l) => l.text)).toEqual(['silence · 5 s', 'silence · 5 s', 'silence · 5 s']);
    expect(v.status).toBe('live · …2926');
  });

  it('groups the Jev rows in consultation order and marks decisive rows', async () => {
    const { events } = await scripted([OPENER, 'Jason Stiles', 'March fifth nineteen eighty']);
    const v = reduce(events);
    expect(v.jev.groups.map((g) => g.name)).toEqual(['gates', 'intent', 'slot · name', 'slot · dob', 'slot · provider', 'slot · date']);
    const dob = v.jev.groups.find((g) => g.name === 'slot · dob')!;
    expect(dob.rows.filter((r) => r.decisive).map((r) => r.id)).toEqual(['dobGiven', 'dobMonth', 'dobDay', 'dobYear']);
    expect(dob.rows.find((r) => r.id === 'dobMonth')!.top!.slice(0, 1)).toEqual([{ label: 'march', p: expect.any(Number) }]);
    expect(v.jev.decision).toMatch(/dob filled 1980-03-05/);
    expect(v.jev.decision).toMatch(/next: date_narrow_window/);
    expect(v.jev.header).toMatch(/^Jev · turn 4 · \d+ questions · \d+ ms · [\d,]+ tokens · \$[\d.]+$/);
    expect(v.jev.pending).toBe(false);
  });

  it('shows the asked state with empty bars until the turn arrives', async () => {
    const { events } = await scripted(['Jason Stiles']);
    const upToAsked = events.slice(0, events.findIndex((e) => e.type === 'asked') + 1);
    const v = reduce(upToAsked);
    expect(v.jev.pending).toBe(true);
    expect(v.jev.header).toMatch(/^Jev · turn 2 · \d+ questions · asking…$/);
    expect(v.jev.groups.flatMap((g) => g.rows).every((r) => r.p === null)).toBe(true);
    expect(v.jev.groups.map((g) => g.name)).toEqual(['gates', 'intent', 'slot · name', 'slot · dob', 'slot · memberId', 'slot · provider', 'slot · date']);
  });

  it('names the slot being asked with its attempt counter', async () => {
    const { events } = await scripted([OPENER, { silence: true }]);
    expect(reduce(events).asking).toBe('asking name · attempt 2 of 3');
  });

  /**
   * The confirmation questions are asked because a confirmation was pending when the batch left,
   * so the group has to follow the ask-time state: the record's post-turn `pendingConfirmation` is
   * empty on the turn that speaks the summary and already cleared on the turn that answers it.
   */
  it('groups the confirmation questions on the turn that answers the summary', async () => {
    const { events } = await scripted([OPENER, 'Jason Stiles', 'March fifth nineteen eighty', 'Tuesday', 'yes']);
    const turns = turnIndexes(events);
    expect(turns.length).toBe(6);

    const answering = reduce(events);
    const group = answering.jev.groups.find((g) => g.name === 'confirmation')!;
    expect(group.rows.map((r) => r.id).sort()).toEqual(['changeSlot', 'confirmsNo', 'confirmsYes']);
    expect(answering.jev.groups.map((g) => g.name).slice(0, 3)).toEqual(['gates', 'intent', 'confirmation']);

    // The turn that speaks the summary asked nothing about it yet: no confirmation group at all.
    const summary = reduce(events.slice(0, turns[4]! + 1));
    expect(summary.pending).toBe('confirm · summary (reschedule) · attempt 0');
    expect(summary.jev.groups.find((g) => g.name === 'confirmation')).toBeUndefined();
    expect(summary.jev.groups.flatMap((g) => g.rows).filter((r) => r.id === 'confirmsYes')).toEqual([]);
  });

  it('draws a score row against the rule the ladder compared, and leaves an unread score bare', async () => {
    const { events, records } = await scripted([OPENER]);
    const opener = records[1]!;
    const gates = reduce(events).jev.groups.find((g) => g.name === 'gates')!;

    const frustration = gates.rows.find((r) => r.id === 'frustration')!;
    const row = opener.gates.find((g) => g.gate === 'frustration')!;
    expect(frustration.kind).toBe('score');
    expect(frustration.p).toBe(row.value);
    expect(frustration.threshold).toBe(DEFAULT_THRESHOLDS.GATE_FRUSTRATION_HIGH);
    // The winning level stays the value, and its probability is not what the bar draws.
    expect(frustration.value).toBe('none');
    const levels = (opener.answers!.frustration as { probabilities: Record<string, number> }).probabilities;
    expect(frustration.p).not.toBe(levels.none);

    // `urgency` is asked but no gate reads it, so there is no pair to draw.
    const urgency = gates.rows.find((r) => r.id === 'urgency')!;
    expect(urgency.p).toBeNull();
    expect(urgency.threshold).toBeNull();
    expect(urgency.value).toBeTruthy();
  });

  it('keeps the last consultation on screen through a turn that asked nothing', async () => {
    const { events } = await scripted([OPENER, { silence: true }]);
    const before = reduce(events.slice(0, events.findIndex((e) => e.type === 'silence')));
    const after = reduce(events);
    expect(before.jev.groups.length).toBeGreaterThan(0);
    expect(after.jev.groups).toEqual(before.jev.groups);
    expect(after.jev.header).toBe('Jev · turn 3 · no questions (last: turn 2)');
    expect(after.jev.decision).not.toBe(before.jev.decision);
  });

  it('says so when the model call failed, and leaves the rows pending', async () => {
    const boom = { ask: (): Promise<never> => Promise.reject(new JevClientError('timed out')) };
    const { events } = await scripted(['Jason Stiles'], { client: boom });
    const v = reduce(events);
    expect(v.jev.header).toMatch(/^Jev · turn 2 · \d+ questions · .* · error: JevClientError$/);
    expect(v.lines.map((l) => l.text)).toContain('model error · JevClientError');
    const rows = v.jev.groups.flatMap((g) => g.rows);
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((r) => r.kind === 'pending')).toBe(true);
  });
});

/** Reducer behaviour that no scripted stub call produces: keypad runs and the end of a call. */
describe('reduce, call-level moments', () => {
  const digits = (s: string): DashboardEvent[] => [...s].map((digit, i) => ({ type: 'dtmf', callSid: CALL, at: i + 1, digit }));

  it('merges a keypad run into one marker', () => {
    const v = reduce([started, ...digits('03051980')]);
    expect(v.lines.map((l) => l.text)).toEqual(['keypad 03051980']);
  });

  it('renders the end of a call, including an eviction', () => {
    expect(reduce([started, { type: 'ended', callSid: CALL, at: 1, reason: 'completed' }]).status).toBe('ended · completed');
    expect(reduce([started, { type: 'ended', callSid: CALL, at: 1, reason: 'error' }]).status).toBe('ended · error');
  });

  it('un-ends the call when a reconnect or another turn follows the hangup the action webhook published', () => {
    const ended: DashboardEvent = { type: 'ended', callSid: CALL, at: 1, reason: 'hangup' };
    const reconnect: DashboardEvent = { type: 'reconnect', callSid: CALL, at: 2, attempt: 1 };
    expect(reduce([started, ended, reconnect]).status).toBe('live · …2926');
    expect(reduce([started, ended, reconnect]).lines.map((l) => l.text)).toEqual(['reconnected (1)']);
  });

  it('marks a transfer', () => {
    const v = reduce([started, { type: 'handoff', callSid: CALL, at: 1, reason: 'billing', number: '…4567' }]);
    expect(v.lines.map((l) => l.text)).toEqual(['transfer to …4567 (billing)']);
  });

  it('starts over when a second call begins', async () => {
    const { events } = await scripted([OPENER, 'Jason Stiles']);
    const second: DashboardEvent = { type: 'call_started', callSid: 'CA2', at: 99_000, from: '…1111', todayIso: TODAY, thresholds: DEFAULT_THRESHOLDS };
    const v = reduce([...events, second]);
    expect(v.callSid).toBe('CA2');
    expect(v.status).toBe('live · …1111');
    expect(v.lines).toEqual([]);
    expect(v.turnCount).toBe(0);
    expect(v.totals).toEqual({ askMs: 0, tokens: 0, usd: 0 });
    expect(v.form).toBeNull();
    expect(v.chips.every((c) => c.state === 'empty' && c.label === '' && !c.changed)).toBe(true);
    expect(v.pending).toBeNull();
    expect(v.queued).toEqual([]);
    expect(v.asking).toBeNull();
    expect(v.jev).toEqual({ header: 'Jev', pending: false, groups: [], decision: '' });
    // Nothing of the first call survives: the whole view is the one the second call alone builds.
    expect(v).toEqual(reduce([second]));
  });

  it('names what the pending confirmation is about', () => {
    const line = (pendingConfirmation: Record<string, unknown>): string | null => reduce([started, turnEvent({ pendingConfirmation })]).pending;
    expect(line({ target: 'form', form: 'reschedule', attempts: 1 })).toBe('confirm · summary (reschedule) · attempt 1');
    expect(line({ target: 'slot', slot: 'date', value: '2026-09-22', display: 'Tuesday, September 22' })).toBe('confirm · date → Tuesday, September 22');
    expect(line({ target: 'intent', intent: 'billing' })).toBe('confirm · billing');
  });
});

describe('replayEvents', () => {
  it('rebuilds the live event sequence from the records and frame log', async () => {
    const { events, records } = await scripted([OPENER, { silence: true }, 'Jason Stiles']);
    const frames: FrameLogLine[] = events
      .filter((e) => e.type === 'silence' || e.type === 'dtmf')
      .map((e) => frameLine('in', e.type === 'silence' ? { type: 'silence' } : { type: 'dtmf', digit: (e as { digit: string }).digit }, e.at));
    const rebuilt = replayEvents(replayRecords(records), frames, { from: FROM, thresholds: DEFAULT_THRESHOLDS });
    expect(rebuilt.map((e) => e.type)).toEqual(events.map((e) => e.type));
    expect(reduce(rebuilt).lines).toEqual(reduce(events).lines);
    expect(reduce(rebuilt).chips).toEqual(reduce(events).chips);
    expect(reduce(rebuilt).jev.decision).toBe(reduce(events).jev.decision);
  });

  it('is empty for an empty trace and tolerates a missing frame log', async () => {
    const { records } = await scripted([OPENER]);
    expect(replayEvents([], [], {})).toEqual([]);
    expect(replayEvents(replayRecords(records), [], {}).map((e) => e.type)).toEqual(['call_started', 'turn', 'asked', 'turn']);
  });

  it('ends on a handoff, with the transfer marker before it', async () => {
    const { records } = await scripted([OPENER]);
    const end = (reasonCode: string): FrameLogLine => frameLine('out', { type: 'end', handoffData: JSON.stringify({ reasonCode, completed: [] }) }, 20_000);

    const rebuilt = replayEvents(replayRecords(records), [end('live-agent')], { handoffNumber: '…4567' });
    expect(rebuilt.map((e) => e.type).slice(-2)).toEqual(['handoff', 'ended']);
    const v = reduce(rebuilt);
    expect(v.lines.at(-1)!.text).toBe('transfer to …4567 (live-agent)');
    expect(v.status).toBe('ended · handoff');

    // A completed call ends without a transfer, and an unreadable payload is a transfer of unknown reason.
    const done = replayEvents(replayRecords(records), [end('completed')], {});
    expect(done.filter((e) => e.type === 'handoff')).toEqual([]);
    expect(reduce(done).status).toBe('ended · completed');
    const garbled = replayEvents(replayRecords(records), [frameLine('out', { type: 'end', handoffData: 'not json' }, 20_000)], {});
    expect(reduce(garbled).lines.at(-1)!.text).toBe('transfer to … (unknown)');
  });

  it('ends a caller hangup, which leaves no end frame at all', async () => {
    const { records } = await scripted([OPENER]);
    const closed = frameLine('log', { socketClosed: true, ended: false }, 20_000);
    expect(reduce(replayEvents(replayRecords(records), [closed], {})).status).toBe('ended · hangup');

    // With an end frame the close says nothing new: that frame already ended the call.
    const both = [frameLine('out', { type: 'end', handoffData: '{"reasonCode":"completed"}' }, 19_000), frameLine('log', { socketClosed: true, ended: true }, 20_000)];
    const reasons = replayEvents(replayRecords(records), both, {}).filter((e) => e.type === 'ended').map((e) => (e as { reason: string }).reason);
    expect(reasons).toEqual(['completed']);
  });

  it('numbers reconnect attempts by the resumed sockets the log holds', async () => {
    const { records } = await scripted([OPENER]);
    const frames = [
      frameLine('log', { resumed: true, sessionId: CALL }, 8_000),
      frameLine('log', { replacedSocket: true }, 9_000),
      frameLine('log', { resumed: true, sessionId: CALL }, 10_000),
    ];
    const v = reduce(replayEvents(replayRecords(records), frames, {}));
    expect(v.lines.filter((l) => l.kind === 'marker').map((l) => l.text)).toEqual(['reconnected (1)', 'reconnected (2)']);
  });
});

describe('row helpers', () => {
  it('a noul row is decisive when it crosses its threshold; a choice when its winner is not none', () => {
    const answers = {
      addressedToSystem: { type: 'noul', noul: 0.97 },
      wantsHuman: { type: 'noul', noul: 0.02 },
      intent: { type: 'choice', choice: 'none', probabilities: { none: 0.9, cancel: 0.1 } },
    };
    const rows = decisiveRows(answers, { GATE_ADDRESSED: 0.7, GATE_WANTS_HUMAN: 0.7 }, []);
    expect(rows.find((r) => r.id === 'addressedToSystem')!.decisive).toBe(true);
    expect(rows.find((r) => r.id === 'wantsHuman')!.decisive).toBe(false);
    expect(rows.find((r) => r.id === 'intent')!.decisive).toBe(false);
  });

  it('marks a row the record names as the deciding gate, whatever its probability', () => {
    const answers = { confirmsNo: { type: 'noul', noul: 0.1 } };
    const gates = [{ gate: 'confirmation', value: 0.1, threshold: 0.7, passed: true, outcome: 'rejected', decided: true }];
    expect(decisiveRows(answers, DEFAULT_THRESHOLDS, gates).find((r) => r.id === 'confirmsNo')!.decisive).toBe(true);
  });

  it('credits only the confirmation answer the gate read', () => {
    const answers = {
      confirmsYes: { type: 'noul', noul: 0.92 },
      confirmsNo: { type: 'noul', noul: 0.04 },
    };
    const confirmed = [{ gate: 'confirmation', value: 0.92, threshold: 0.7, passed: true, outcome: 'confirmed', decided: true }];
    const yes = decisiveRows(answers, { CONFIRM_YES: 0.7, CONFIRM_NO: 0.7 }, confirmed);
    expect(yes.filter((r) => r.decisive).map((r) => r.id)).toEqual(['confirmsYes']);
    // An unanswered summary read neither answer, so neither row is the one that decided.
    const unanswered = [{ gate: 'confirmation', value: 0.3, threshold: 0.7, passed: false, outcome: 'unanswered', decided: true }];
    expect(decisiveRows({ confirmsYes: { type: 'noul', noul: 0.3 } }, { CONFIRM_YES: 0.7 }, unanswered).filter((r) => r.decisive)).toEqual([]);
  });

  it('groups by role using the question id and the form slots', () => {
    const rows = [{ id: 'addressedToSystem' }, { id: 'intent' }, { id: 'nameGiven' }, { id: 'dateMode' }];
    const g = groupRows(rows as never, ['name', 'dob', 'provider', 'date'], null);
    expect(g.map((x) => x.name)).toEqual(['gates', 'intent', 'slot · name', 'slot · dob', 'slot · provider', 'slot · date']);
    expect(g.find((x) => x.name === 'slot · name')!.rows.map((r) => r.id)).toEqual(['nameGiven']);
  });

  it('adds a confirmation group only while one is pending, and never loses a row to "other"', () => {
    const rows = [{ id: 'confirmsYes' }, { id: 'changeSlot' }, { id: 'menuNumberSaid' }, { id: 'somethingNew' }];
    const pending = groupRows(rows as never, ['name'], { target: 'form' });
    expect(pending.map((x) => x.name)).toEqual(['gates', 'intent', 'confirmation', 'slot · name', 'other']);
    expect(pending.find((x) => x.name === 'confirmation')!.rows.map((r) => r.id)).toEqual(['confirmsYes', 'changeSlot']);
    expect(pending.find((x) => x.name === 'other')!.rows.map((r) => r.id)).toEqual(['somethingNew']);
    expect(groupRows(rows as never, ['name'], null).map((x) => x.name)).toEqual(['gates', 'intent', 'slot · name', 'other']);
  });

  it('keeps a known slot the current form does not have in a slot group of its own', () => {
    const rows = [{ id: 'nameGiven' }, { id: 'containsMemberId' }, { id: 'somethingNew' }];
    const g = groupRows(rows as never, ['name'], null);
    expect(g.map((x) => x.name)).toEqual(['gates', 'intent', 'slot · name', 'slot · memberId', 'other']);
    expect(g.find((x) => x.name === 'slot · memberId')!.rows.map((r) => r.id)).toEqual(['containsMemberId']);
  });

  it('routes every slot question a real turn asks into that slot\'s group', async () => {
    // The first spoken turn is outside a form, so the batch carries every slot's questions; this
    // is what pins SLOT_PREFIX against the ids the slot specs actually ask.
    const { records } = await scripted(['Jason Stiles']);
    const rows = decisiveRows(null, DEFAULT_THRESHOLDS, [], records[1]!.questions);
    const groups = groupRows(rows, ALL_SLOTS, null);
    for (const slot of ALL_SLOTS) {
      expect(groups.find((g) => g.name === `slot · ${slot}`)!.rows.length).toBeGreaterThan(0);
    }
    expect(groups.find((g) => g.name === 'other')).toBeUndefined();
  });

  it('maps every question id a real turn asks to the threshold that decides it', async () => {
    const { records } = await scripted([OPENER, 'Jason Stiles', 'March fifth nineteen eighty', 'Tuesday', 'no, Thursday with Dr. Alvarez']);
    const ids = new Set<string>();
    for (const r of records) for (const id of Object.keys(r.questions ?? {})) ids.add(id);
    expect(ids.size).toBeGreaterThan(30);
    // The rows the gate ladder only reports (`info()` in core/gates.ts) have no threshold to
    // draw; everything the ladder or a slot actually decides on must have one.
    const informational = ['rephrasingLastTurn', 'confusedByPrompt', 'spokeAMenuNumber', 'urgency', 'triedSelfService', 'languageSwitch'];
    const unmapped = [...ids].filter((id) => thresholdFor(id, DEFAULT_THRESHOLDS) === null).sort();
    expect(unmapped).toEqual([...informational].sort());
    expect(thresholdFor('addressedToSystem', DEFAULT_THRESHOLDS)).toBe(DEFAULT_THRESHOLDS.GATE_ADDRESSED);
    expect(thresholdFor('nameGiven', DEFAULT_THRESHOLDS)).toBe(DEFAULT_THRESHOLDS.SLOT_DETECT);
    expect(thresholdFor('dobMonth', DEFAULT_THRESHOLDS)).toBe(DEFAULT_THRESHOLDS.SLOT_CHOICE_CONFIRM);
    expect(thresholdFor('providerUnsure', DEFAULT_THRESHOLDS)).toBe(DEFAULT_THRESHOLDS.PROVIDER_UNSURE);
  });

  /** INTENT_ROUTE is never applied at runtime: gates.ts routes at EXPLICIT, or SWITCH in a form. */
  it('ticks the intent row at the rung the ladder uses for the form in hand', async () => {
    expect(thresholdFor('intent', DEFAULT_THRESHOLDS, null)).toBe(DEFAULT_THRESHOLDS.INTENT_EXPLICIT);
    expect(thresholdFor('intent', DEFAULT_THRESHOLDS, 'reschedule')).toBe(DEFAULT_THRESHOLDS.INTENT_SWITCH);

    // And a real turn's row takes the rung from the form the batch was asked under, not the one
    // the turn ends on: the opener is spoken outside a form and enters one.
    const { events, records } = await scripted([OPENER, 'Jason Stiles']);
    const turns = turnIndexes(events);
    const opener = reduce(events.slice(0, turns[1]! + 1));
    expect(records[1]!.turnState!.activeForm).toBeNull();
    expect(records[1]!.form).toBe('reschedule');
    expect(opener.jev.groups.find((g) => g.name === 'intent')!.rows[0]!.threshold).toBe(DEFAULT_THRESHOLDS.INTENT_EXPLICIT);
    expect(reduce(events).jev.groups.find((g) => g.name === 'intent')!.rows[0]!.threshold).toBe(DEFAULT_THRESHOLDS.INTENT_SWITCH);
  });
});

/**
 * view.js cannot import the domain (the browser loads it bare), so it mirrors the form slot
 * lists. This pins the mirror: a slot added to or reordered in FORMS fails here.
 */
describe('the form slot mirror', () => {
  it('matches the real FORMS', () => {
    const real: Record<string, readonly string[]> = Object.fromEntries(Object.entries(FORMS).map(([form, spec]) => [form, spec.slots]));
    expect(FORM_SLOTS).toEqual(real);
  });

  it('lists every slot, in the domain order', () => {
    expect(ALL_SLOTS).toEqual([...REAL_ALL_SLOTS]);
  });
});

/** The records a replay reads are the trace's own, so their shape is worth one assertion. */
describe('replayRecords', () => {
  it('carries the line the caller heard on every record', async () => {
    const { records } = await scripted([OPENER]);
    const spoken = replayRecords(records).map((r) => r.spokenText);
    expect(spoken[0]).toMatch(/^Thanks for calling/);
    expect(spoken.at(-1)).toBe("What's your first and last name?");
  });
});
