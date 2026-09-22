import { describe, expect, it } from 'vitest';
import { runTurn, type RunOptions } from '../../run/turn';
import { newSession, type Session } from '../../core/session';
import { promptFrame, dtmfFrames, silenceFrame, setupFrame } from '../../channel/frames';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { FixtureStubClient } from '../../jev/fixtureStub';
import { HeuristicStubClient } from '../../jev/heuristicStub';
import { loadCorpus } from '../../jev/corpus';
import { DEFAULT_CORPUS_FILE } from '../../run/client';
import { spokenText } from '../../prompts/render';
import { ALL_SLOTS as REAL_ALL_SLOTS, FORMS } from '../../domain/forms';
import type { TraceRecord } from '../../trace/types';
import type { FrameLogLine } from '../frameLog';
import { DashboardBus, type PublishedEvent } from './bus';
import { makeObserver } from './observer';
import type { SessionStore } from '../sessions';
import { ALL_SLOTS, FORM_SLOTS, decisiveRows, groupRows, reduce, replayEvents, thresholdFor } from './view.js';
import type { DashboardEvent } from './events';

const TODAY = '2026-09-18';
const CALL = 'CA1';
const FROM = '…2926';
const fixture = new FixtureStubClient(loadCorpus(DEFAULT_CORPUS_FILE), { sharpness: 0.9, fallback: new HeuristicStubClient() });

type Step = string | { dtmf: string } | { silence: true };

/**
 * Runs a scripted call through the real observer and the real bus, so the events the view is
 * tested against are the ones the page receives: the observer's `asked`/`turn` (with the redacted
 * record and the spoken line) plus the moments the adapter publishes itself.
 */
async function scripted(steps: Step[]): Promise<{ events: PublishedEvent[]; records: TraceRecord[] }> {
  const events: PublishedEvent[] = [];
  const records: TraceRecord[] = [];
  const bus = new DashboardBus();
  bus.subscribe((e) => events.push(e));
  let session: Session = newSession(CALL, 0);
  // makeObserver reads the live turn counter through the store, exactly as the server wires it.
  const store = { get: () => ({ session }) } as unknown as SessionStore;
  let t = 1_000;
  const opts: RunOptions = {
    client: fixture,
    thresholds: { ...DEFAULT_THRESHOLDS },
    todayIso: TODAY,
    now: () => t,
    observe: makeObserver(bus, store, CALL),
  };
  const step = async (frame: Parameters<typeof runTurn>[1]): Promise<void> => {
    const run = await runTurn(session, frame, opts);
    records.push(run.record);
    session = run.result.session;
  };
  bus.publish({ type: 'call_started', callSid: CALL, at: t, from: FROM, todayIso: TODAY, thresholds: DEFAULT_THRESHOLDS });
  await step(setupFrame(CALL));
  for (const s of steps) {
    t += 5_000;
    if (typeof s === 'string') await step(promptFrame(s));
    else if ('dtmf' in s) {
      for (const f of dtmfFrames(s.dtmf)) {
        bus.publish({ type: 'dtmf', callSid: CALL, at: t, digit: f.digit });
        await step(f);
      }
    } else {
      bus.publish({ type: 'silence', callSid: CALL, at: t, promptId: session.lastPromptId });
      await step(silenceFrame());
    }
  }
  return { events, records };
}

/** What `/dashboard/traces/<sid>` hands the page: the record plus the line the caller heard. */
function replayRecords(records: TraceRecord[]): Array<TraceRecord & { spokenText: string }> {
  return records.map((r) => ({ ...r, spokenText: spokenText(r.decision) }));
}

const OPENER = "I need to reschedule my appointment, it's with Dr. Chen sometime next week";

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
    expect(v.pending).toBe('confirm · form · attempt 0');
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

  it('renders silence markers between turns', async () => {
    const { events } = await scripted(['I need to reschedule my appointment with Dr. Chen', { silence: true }, { silence: true }, { silence: true }]);
    const v = reduce(events);
    expect(v.lines.filter((l) => l.kind === 'marker').map((l) => l.text)).toEqual(['silence', 'silence', 'silence']);
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
});

/** Reducer behaviour that no scripted stub call produces: keypad runs and the end of a call. */
describe('reduce, call-level moments', () => {
  const started: DashboardEvent = { type: 'call_started', callSid: CALL, at: 0, from: FROM, todayIso: TODAY, thresholds: DEFAULT_THRESHOLDS };
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
});

describe('replayEvents', () => {
  it('rebuilds the live event sequence from the records and frame log', async () => {
    const { events, records } = await scripted([OPENER, { silence: true }, 'Jason Stiles']);
    const frames: FrameLogLine[] = events
      .filter((e) => e.type === 'silence' || e.type === 'dtmf')
      .map((e) => ({
        ts: new Date(e.at).toISOString(),
        dir: 'in',
        msg: e.type === 'silence' ? { type: 'silence' } : { type: 'dtmf', digit: (e as { digit: string }).digit },
        line: 1,
      }));
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
    expect(thresholdFor('intent', DEFAULT_THRESHOLDS)).toBe(DEFAULT_THRESHOLDS.INTENT_ROUTE);
    expect(thresholdFor('dobMonth', DEFAULT_THRESHOLDS)).toBe(DEFAULT_THRESHOLDS.SLOT_CHOICE_CONFIRM);
    expect(thresholdFor('providerUnsure', DEFAULT_THRESHOLDS)).toBe(DEFAULT_THRESHOLDS.PROVIDER_UNSURE);
  });
});

/**
 * view.js cannot import the domain (the browser loads it bare), so it mirrors the form slot
 * lists. This pins the mirror: a slot added to or reordered in FORMS fails here.
 */
describe('the form slot mirror', () => {
  it('matches the real FORMS', () => {
    const real = Object.fromEntries(Object.entries(FORMS).map(([form, spec]) => [form, spec.slots]));
    expect(FORM_SLOTS).toEqual(real);
  });

  it('lists every slot, in the domain order', () => {
    expect(ALL_SLOTS).toEqual([...REAL_ALL_SLOTS]);
  });
});
