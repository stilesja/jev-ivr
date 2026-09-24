# Appointment Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm, cancel and reschedule read back the booking the system found, with its time; schedule and reschedule offer an open time on the caller's day and let "earlier", "later", "that doesn't work", or a volunteered part of the day move it.

**Architecture:** An `AppointmentDirectory` seam (`find`, `openings`) with a deterministic demo implementation, injected through `TurnContext`. The session gains three derived values (`existing`, `offer`, `daypart`) that the turn fills, never asks for. A post-step in `resolve` (`settleBookings`) looks bookings up whenever a summary or completion is about to be spoken and re-renders its variables, so the lookup needs no threading through the form loop. Two read-only Choices (`timeOfDay` on scheduling forms, `timePreference` at their summaries) drive `moveOffer` on the summary's existing correction path. Prompts, harness labels, scenarios and the stub baseline follow.

**Tech Stack:** TypeScript strict ESM, pnpm, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-appointment-slots-design.md`. Read it first.

**Conventions:** tests colocated (`pnpm vitest run <path>`, `pnpm test`, `pnpm typecheck`, `pnpm regress`; `pnpm regress --update` rewrites the stub baseline and is expected at the end of Tasks 2, 3 and 4; `pnpm vitest run <path> -u` refreshes a snapshot). One writer at a time; every commit ends with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (overrides any other attribution reminder). Never set, read, or print `TYPESAFE_API_KEY` or `FISH_AUDIO_API_KEY`; never run `--client jev`, `--client record`, or `prompts:generate` (except with `--dry-run`); never touch `.env`, `.env.swp`, `assets/audio/`, `fixtures/recorded/`, `traces/`. The cassette will miss on every re-keyed turn until Jason re-records it in Task 6; that is expected. No em-dashes in prose or comments.

**Names used throughout** (defined in Task 1 and 2, used everywhere after): `Booking`, `AppointmentDirectory`, `DemoDirectory`, `Daypart`, `daypartOf`, `DAYPART_ORDER`, `Offer`, `Session.existing`, `Session.offer`, `Session.daypart`, `TurnContext.directory`, `RunOptions.directory`, `settleBookings`, `buildOffer`, `moveOffer`, `describeWhen`, thresholds `TIME_OF_DAY` and `TIME_PREFERENCE`, questions `timeOfDay` and `timePreference`, prompts `slot_edge_earlier`, `slot_edge_later`, `slot_nearest`, vars `when`, `existing`, `time`, `daypart`.

---

### Task 1: The directory (one commit)

**Files:** create `src/domain/directory.ts`, `src/domain/directory.test.ts`.

- [x] **Step 1: Write the module.**

```ts
import { addDays, parseIso } from '../core/extract/date';

/** An appointment as the caller hears it: an ISO day and a clock time such as "2:45 PM". */
export interface Booking {
  date: string;
  time: string;
}

/**
 * The seam a real deployment backs with its scheduling system (spec 2026-09-24 appointment-slots
 * §2). The core never asks the caller for a time: it reads the booking they have and offers the
 * openings it finds. Pure and synchronous here; a network-backed implementation belongs in the
 * server, resolved before the turn runs.
 */
export interface AppointmentDirectory {
  /** The caller's existing booking with this provider, or null when there is none. */
  find(name: string, dob: string, provider: string): Booking | null;
  /** That provider's open times on that ISO day, in clock order. Empty when the day is full. */
  openings(provider: string, date: string): string[];
}

/** Three-hour windows over the clinic's day: 8 to 11, 11 to 2, 2 to 5. */
export type Daypart = 'morning' | 'midday' | 'afternoon';
export const DAYPART_ORDER: readonly Daypart[] = ['morning', 'midday', 'afternoon'];

/** Minutes since midnight for a clock time such as "2:45 PM". */
export function minutesOf(time: string): number {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(time);
  if (!m) throw new Error(`not a clock time: ${time}`);
  const h = Number(m[1]) % 12 + (m[3] === 'PM' ? 12 : 0);
  return h * 60 + Number(m[2]);
}

/** The window a clock time falls in. Before 11:00 is morning; 2:00 PM and later is afternoon. */
export function daypartOf(time: string): Daypart {
  const min = minutesOf(time);
  if (min < 11 * 60) return 'morning';
  if (min < 14 * 60) return 'midday';
  return 'afternoon';
}

/** The first minute of a window, and the first minute after it, for the nearest-opening rule. */
export function daypartBounds(part: Daypart): { start: number; end: number } {
  return part === 'morning' ? { start: 8 * 60, end: 11 * 60 } : part === 'midday' ? { start: 11 * 60, end: 14 * 60 } : { start: 14 * 60, end: 17 * 60 };
}

/** The demo's nine times, three in each window, in clock order. */
export const DEMO_TIMES: readonly string[] = ['8:30 AM', '9:15 AM', '10:00 AM', '11:15 AM', '12:30 PM', '1:00 PM', '2:45 PM', '3:30 PM', '4:15 PM'];

/** FNV-1a over the string, as a non-negative 32-bit integer. Stable across runs and platforms. */
export function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text.toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function isWeekend(iso: string): boolean {
  const day = new Date(parseIso(iso)).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Invents bookings and openings deterministically, so the same caller hears the same appointment
 * on every call and the harness reproduces a run from its date alone. Never returns null and never
 * an empty day; both paths belong to the framework, not the demo.
 */
export class DemoDirectory implements AppointmentDirectory {
  constructor(private readonly todayIso: string) {}

  find(name: string, dob: string, provider: string): Booking {
    const h = hashOf(`${name}|${dob}|${provider}`);
    // A weekday one to fourteen days out: step forward from tomorrow, skipping weekends, as many
    // weekdays as the hash says (one to ten), which always lands inside the fortnight.
    let date = this.todayIso;
    for (let left = (h % 10) + 1; left > 0; ) {
      date = addDays(date, 1);
      if (!isWeekend(date)) left -= 1;
    }
    return { date, time: DEMO_TIMES[(h >>> 8) % DEMO_TIMES.length]! };
  }

  openings(provider: string, date: string): string[] {
    const h = hashOf(`${provider}|${date}`);
    // Three distinct indexes into the table, in clock order. A day can hold two of one window
    // and none of another, which is what makes the nearest-opening rule reachable.
    const picked = new Set<number>();
    for (let i = 0; picked.size < 3; i += 1) picked.add((h >>> (i * 4)) % DEMO_TIMES.length);
    return [...picked].sort((a, b) => a - b).map((i) => DEMO_TIMES[i]!);
  }
}
```

Note: `hashOf` shifts by `i * 4`; for `i >= 8` the shift wraps, and three distinct values are found within a few iterations for every seed because the modulus is 9. The test below checks the loop terminates for every provider-date in a sweep.

- [x] **Step 2: Tests** in `src/domain/directory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DAYPART_ORDER, DEMO_TIMES, DemoDirectory, daypartBounds, daypartOf, hashOf, minutesOf } from './directory';
import { addDays, parseIso } from '../core/extract/date';

const TODAY = '2026-09-24';
const dir = new DemoDirectory(TODAY);

describe('dayparts', () => {
  it('splits the day at 11 and 2', () => {
    expect(daypartOf('10:59 AM')).toBe('morning');
    expect(daypartOf('11:00 AM')).toBe('midday');
    expect(daypartOf('1:59 PM')).toBe('midday');
    expect(daypartOf('2:00 PM')).toBe('afternoon');
    expect(DAYPART_ORDER).toEqual(['morning', 'midday', 'afternoon']);
    expect(daypartBounds('midday')).toEqual({ start: 660, end: 840 });
  });

  it('reads clock times and rejects anything else', () => {
    expect(minutesOf('12:30 PM')).toBe(750);
    expect(minutesOf('12:05 AM')).toBe(5);
    expect(() => minutesOf('noon')).toThrow(/not a clock time/);
  });

  it('has three demo times in each window, in clock order', () => {
    expect(DEMO_TIMES.map(daypartOf)).toEqual(['morning', 'morning', 'morning', 'midday', 'midday', 'midday', 'afternoon', 'afternoon', 'afternoon']);
    const mins = DEMO_TIMES.map(minutesOf);
    expect([...mins].sort((a, b) => a - b)).toEqual(mins);
  });
});

describe('DemoDirectory', () => {
  it('finds the same booking for the same caller every time, on a weekday within a fortnight', () => {
    const a = dir.find('jason stiles', '1980-03-05', 'chen');
    expect(dir.find('jason stiles', '1980-03-05', 'chen')).toEqual(a);
    expect(new DemoDirectory(TODAY).find('Jason Stiles', '1980-03-05', 'chen')).toEqual(a);
    const day = new Date(parseIso(a.date)).getUTCDay();
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(5);
    expect(a.date > TODAY).toBe(true);
    expect(a.date <= addDays(TODAY, 14)).toBe(true);
    expect(DEMO_TIMES).toContain(a.time);
  });

  it('gives different callers different bookings', () => {
    const a = dir.find('jason stiles', '1980-03-05', 'chen');
    const b = dir.find('andy middleton', '2000-01-01', 'chen');
    expect(a).not.toEqual(b);
  });

  it('offers three openings in clock order, the same on every call', () => {
    const times = dir.openings('chen', '2026-10-06');
    expect(times).toHaveLength(3);
    expect(new Set(times).size).toBe(3);
    expect(times.map(minutesOf)).toEqual([...times.map(minutesOf)].sort((a, b) => a - b));
    expect(dir.openings('chen', '2026-10-06')).toEqual(times);
    expect(dir.openings('kim', '2026-10-06')).not.toEqual(times);
  });

  it('terminates and stays in the table for every provider and day in a month', () => {
    for (const p of ['chen', 'cheng', 'patel', 'okafor', 'nguyen', 'rossi', 'kim', 'alvarez']) {
      for (let d = 0; d < 31; d += 1) {
        const times = dir.openings(p, addDays(TODAY, d));
        expect(times).toHaveLength(3);
        for (const t of times) expect(DEMO_TIMES).toContain(t);
      }
    }
  });

  it('hashes stably and case-insensitively', () => {
    expect(hashOf('Chen')).toBe(hashOf('chen'));
    expect(hashOf('a')).not.toBe(hashOf('b'));
  });
});
```

Run `pnpm vitest run src/domain/directory.test.ts`; `pnpm typecheck`. Commit `feat(domain): an appointment directory seam with a deterministic demo implementation`.

---

### Task 2: Session, context, and the found booking and first offer (one commit)

**Files:** `src/core/session.ts`, `src/core/session.test.ts`, `src/core/thresholds.ts`, `src/harness-text/sweepSpace.ts`, `src/harness-text/sweepSpace.test.ts`, `src/core/turn.ts`, `src/core/turn.test.ts`, `src/run/turn.ts`, `src/harness-text/runner.ts`, `src/prompts/segments.ts`, `src/prompts/segments.test.ts`, `src/prompts/clips.ts`, `src/prompts/clips.test.ts`, `src/prompts/manifest.json`, `src/prompts/tags.json`, `src/prompts/render.test.ts`, snapshots, `fixtures/expected/*`.

- [x] **Step 1: Session fields.** In `src/core/session.ts`, import `type Booking, type Daypart` from `../domain/directory`, and add:

```ts
/** The openings the caller is being offered on one day, and which one the summary names. */
export interface Offer {
  date: string;
  times: string[];
  index: number;
}
```

`Session` gains, after `transferDeclined`:

```ts
  /** The booking the directory found for the identity and provider on a confirm, cancel or reschedule form; read at the summary. */
  existing: Booking | null;
  /** The openings offered on a schedule or reschedule form; the summary names `times[index]`. */
  offer: Offer | null;
  /** The part of the day the caller asked for, if they ever did. Read, never asked; carries across a chained form with the identity slots. */
  daypart: Daypart | null;
```

`newSession` sets all three to null. `cloneSession` copies `existing` and `offer` by value (`offer ? { ...offer, times: [...offer.times] } : null`). Tests in `session.test.ts`: a new session has all three null; `cloneSession` copies an offer's `times` array (`not.toBe`, `toEqual`).

- [x] **Step 2: Thresholds and sweep.** `src/core/thresholds.ts`, a new group after `// slots`:

```ts
  // appointment slots (spec 2026-09-24 appointment-slots §7)
  TIME_OF_DAY: 0.6,
  TIME_PREFERENCE: 0.6,
```

`src/harness-text/sweepSpace.ts` `SWEEPABLE` gains `'TIME_OF_DAY', 'TIME_PREFERENCE'` after `'SLOT_HELP'`; `sweepSpace.test.ts` counts move 23→25 and, if a second count exists (`parseOnly` default length), 22→24.

- [x] **Step 3: Context plumbing.** `src/core/turn.ts` `TurnContext` gains `directory: AppointmentDirectory;` (required). `src/run/turn.ts` `RunOptions` gains `/** Bookings and openings. The harness, the CLI and the server all use the demo directory today. */ directory?: AppointmentDirectory;` and `runTurn` builds `tc` with `directory: opts.directory ?? new DemoDirectory(opts.todayIso)`. Every test file that builds a `TurnContext` literal (`turn.test.ts` has `const tc`, and grep for `thresholds: { ...DEFAULT_THRESHOLDS }` across `src/`) adds `directory: new DemoDirectory('2026-09-18')` (the date that file already uses as `todayIso`).

- [x] **Step 4: Spoken variables and vocabulary.** `src/prompts/segments.ts`: `SPOKEN_VARS` gains `'when', 'existing', 'time'`; `VOCAB_VARS` gains `'daypart'`. `src/prompts/clips.ts` `vocabularyClipId`: after the intent branch, `if (name === 'daypart' && (DAYPART_ORDER as readonly string[]).includes(display)) return \`daypart.${display}\`;` and `recordableClips` adds `for (const d of DAYPART_ORDER) rows.push({ id: \`daypart.${d}\`, text: d, note: 'closed' });` (import `DAYPART_ORDER` from `../domain/directory`). `clips.test.ts`: `vocabularyClipId('daypart', 'afternoon')` is `'daypart.afternoon'`; refresh the snapshot in Step 6.

- [x] **Step 5: Bookings settle before a summary or completion is spoken.** First, in `src/domain/forms.ts`, after `FORMS`:

```ts
/** Forms that book an opening the system offers (spec 2026-09-24 appointment-slots §3). */
export const SCHEDULING_FORMS: readonly FormId[] = ['schedule_new', 'reschedule'];
/** Forms that act on a booking the directory finds. */
export const EXISTING_FORMS: readonly FormId[] = ['confirm_appointment', 'cancel', 'reschedule'];
```

Then in `src/core/turn.ts` (importing both from `../domain/forms`), add near `summaryVars`:

```ts
import { DAYPART_ORDER, daypartBounds, daypartOf, minutesOf, type AppointmentDirectory, type Daypart } from '../domain/directory';
import { describeDay } from './extract/date';
import type { Offer } from './session';

/** "Tuesday, October 6 at 2:45 PM": the one spoken span a summary or completion reads a booking as. */
export function describeWhen(date: string, time: string): string {
  return `${describeDay(date)} at ${time}`;
}

/**
 * The index the offer opens at: the first opening inside the caller's daypart when they named
 * one and the day has one; otherwise the day's first opening. `nearest` is set when the caller
 * named a daypart the day cannot serve, so the caller is told which opening they got instead.
 */
export function buildOffer(date: string, times: string[], daypart: Daypart | null): { offer: Offer; nearest: boolean } {
  if (daypart === null || times.length === 0) return { offer: { date, times, index: 0 }, nearest: false };
  const inside = times.findIndex((t) => daypartOf(t) === daypart);
  if (inside >= 0) return { offer: { date, times, index: inside }, nearest: false };
  // Closest by clock distance to the window's edges.
  const { start, end } = daypartBounds(daypart);
  const distance = (t: string): number => { const m = minutesOf(t); return m < start ? start - m : m >= end ? m - end + 1 : 0; };
  let best = 0;
  times.forEach((t, i) => { if (distance(t) < distance(times[best]!)) best = i; });
  return { offer: { date, times, index: best }, nearest: true };
}

/**
 * Look the bookings up that the summary or completion about to be spoken names, and render its
 * variables again with them. Runs once per turn, after the decision is made and before it is
 * spoken (resolve), so the form loop never needs the directory: a summary asked on the same turn
 * the date filled reads back the opening this step found. Rebuilds the offer when the day changed
 * (a correction moved it) and leaves it alone otherwise, so an index moved by earlier/later stands.
 */
export function settleBookings(s: Session, decision: Decision, directory: AppointmentDirectory): Decision {
  if (!s.form) return decision;
  const acks: Ack[] = [];
  const { name, dob, provider, date } = s.slots;
  if (EXISTING_FORMS.includes(s.form) && s.existing === null && name.value && dob.value && provider.value) {
    s.existing = directory.find(name.value, dob.value, provider.value);
  }
  if (SCHEDULING_FORMS.includes(s.form) && provider.value && date.value && (s.offer === null || s.offer.date !== date.value)) {
    const built = buildOffer(date.value, directory.openings(provider.value, date.value), s.daypart);
    s.offer = built.offer;
    if (built.nearest && s.daypart) acks.push({ promptId: 'slot_nearest', vars: { daypart: s.daypart, time: built.offer.times[built.offer.index]! } });
  }
  // Only a decision that reads the booking back needs its variables refreshed; everything else
  // keeps what it rendered. Acks are prepended so "The closest I have to the afternoon is 1:00 PM."
  // is heard before the summary that names it.
  if (decision.kind === 'prompt' && decision.target === 'confirm' && s.pendingConfirmation?.target === 'form') {
    return { ...decision, vars: summaryVars(s), acks: [...acks, ...decision.acks] };
  }
  if (decision.kind === 'complete') return { ...decision, vars: summaryVars(s), acks: [...acks, ...decision.acks] };
  return acks.length ? (decision.kind === 'prompt' ? { ...decision, acks: [...acks, ...decision.acks] } : decision) : decision;
}
```

`summaryVars` gains, after the slot loop:

```ts
  vars.when = s.offer ? describeWhen(s.offer.date, s.offer.times[s.offer.index]!) : '';
  vars.time = s.offer ? s.offer.times[s.offer.index]! : '';
  vars.existing = s.existing ? describeWhen(s.existing.date, s.existing.time) : '';
```

In `completeForm`, where `s.slots.provider` and `s.slots.date` are reset for a chained form, also `s.offer = null; s.existing = null;` (daypart stays, per spec §3). In `resolve`, the `prompt` and `dtmf` branches call it: `prompt`: `const decision = settleBookings(s, escalate(s, resolved, rung), tc.directory);` and `dtmf`: `const settled = settleBookings(s, decision, tc.directory);` used for bookkeeping and frames. (Silence never produces a first summary, and `escalate`'s offer is a `prompt` with target `confirm` but `pendingConfirmation.target === 'transfer'`, so the guard leaves it alone.)

Manifest, in `src/prompts/manifest.json`: the six changed texts and three new acks exactly as spec §4 (`slot_nearest` text: "The closest I have to the {daypart} is {time}."; the three acks `interruptible: false`). `tags.json`: `slot_edge_earlier.0`, `slot_edge_later.0`, `slot_nearest.0`, `slot_nearest.1`: `"[calm]"`. Note the completion `cancel_confirmed` and `appointment_details` are unchanged.

- [x] **Step 6: Tests.** `pnpm vitest run src/prompts -u` refreshes the clips snapshot (segments of the four summaries and two completions change; new acks and daypart rows appear) and the seam test must still pass (every spoken var ends a clause). In `src/core/turn.test.ts` add `describe('bookings')`:

```ts
describe('bookings', () => {
  const RESCHEDULE_OPENER = 'I need to reschedule my appointment with Dr. Chen next week';

  it('reads the found booking back on a confirm summary, with its time', () => {
    let r = say(started(), 'confirm my appointment with dr chen', { intent: choice({ confirm_appointment: 0.95, none: 0.05 }), provider: choice({ chen: 0.92, none: 0.08 }) });
    r = identify(r.session);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_appointment_details', target: 'confirm' });
    const found = tc.directory.find('jason stiles', '1980-03-05', 'chen');
    expect(r.session.existing).toEqual(found);
    expect(varsOf(r.decision).existing).toBe(`${describeDay(found!.date)} at ${found!.time}`);
    expect(spokenText(r.decision)).toContain(`It's on ${describeDay(found!.date)} at ${found!.time}, for Jason Stiles`);
  });

  it('offers the first opening on the chosen day and books it on yes', () => {
    const r = afterTurns(HAPPY);
    const offer = r.session.offer!;
    expect(offer.date).toBe('2026-09-22');
    expect(offer.index).toBe(0);
    expect(offer.times).toEqual(tc.directory.openings('chen', '2026-09-22'));
    expect(varsOf(r.decision).when).toBe(`Tuesday, September 22 at ${offer.times[0]}`);
    expect(varsOf(r.decision).existing).toBe(`${describeDay(r.session.existing!.date)} at ${r.session.existing!.time}`);
    const done = afterTurns([...HAPPY, 'yes']);
    expect(done.decision).toMatchObject({ kind: 'complete', promptId: 'reschedule_confirmed' });
    expect(spokenText(done.decision)).toContain(`Your appointment is moved to Tuesday, September 22 at ${offer.times[0]}.`);
  });

  it('opens the offer inside a daypart the caller volunteered on the opener', () => {
    // Pick a day whose openings include an afternoon, so the first offer is that one.
    const day = '2026-09-22';
    const times = tc.directory.openings('chen', day);
    const afternoon = times.findIndex((t) => daypartOf(t) === 'afternoon');
    const part: Daypart = afternoon >= 0 ? 'afternoon' : daypartOf(times[times.length - 1]!);
    const r = afterTurns([{ say: `${RESCHEDULE_OPENER} in the ${part}`, over: { timeOfDay: choice({ [part]: 0.9, none: 0.1 }) } }, 'Jason Stiles', 'March fifth nineteen eighty', 'Tuesday']);
    expect(r.session.daypart).toBe(part);
    expect(daypartOf(r.session.offer!.times[r.session.offer!.index]!)).toBe(part);
  });

  it('offers the nearest opening, and says so, when the day has none in the daypart', () => {
    const day = '2026-09-22';
    const times = tc.directory.openings('chen', day);
    const missing = DAYPART_ORDER.find((p) => !times.some((t) => daypartOf(t) === p));
    if (!missing) return; // this seed happens to cover every window; the buildOffer unit test below pins the rule
    const r = afterTurns([{ say: `${RESCHEDULE_OPENER} in the ${missing}`, over: { timeOfDay: choice({ [missing]: 0.9, none: 0.1 }) } }, 'Jason Stiles', 'March fifth nineteen eighty', 'Tuesday']);
    expect(r.decision).toMatchObject({ acks: [{ promptId: 'slot_nearest', vars: { daypart: missing, time: r.session.offer!.times[r.session.offer!.index] } }] });
  });

  it('rebuilds the offer when a correction moves the day, and clears it for a chained form', () => {
    let r = afterTurns([...HAPPY, 'no, Thursday']);
    expect(r.session.offer!.date).toBe('2026-09-24');
    expect(r.session.offer!.index).toBe(0);
    expect(varsOf(r.decision).when).toContain('Thursday, September 24 at');
    r = afterTurns([...HAPPY, 'yes, and can I also ask about my bill']);
    expect(r.session.form).toBe('billing');
    expect(r.session.offer).toBeNull();
    expect(r.session.existing).toBeNull();
  });
});

describe('buildOffer', () => {
  it('picks the nearest opening to a window with none, by clock distance', () => {
    expect(buildOffer('2026-10-06', ['9:15 AM', '11:15 AM', '1:00 PM'], 'afternoon')).toEqual({ offer: { date: '2026-10-06', times: ['9:15 AM', '11:15 AM', '1:00 PM'], index: 2 }, nearest: true });
    expect(buildOffer('2026-10-06', ['11:15 AM', '2:45 PM', '4:15 PM'], 'morning')).toEqual({ offer: { date: '2026-10-06', times: ['11:15 AM', '2:45 PM', '4:15 PM'], index: 0 }, nearest: true });
    expect(buildOffer('2026-10-06', ['9:15 AM', '2:45 PM', '4:15 PM'], 'afternoon')).toMatchObject({ offer: { index: 1 }, nearest: false });
    expect(buildOffer('2026-10-06', ['9:15 AM', '2:45 PM'], null)).toMatchObject({ offer: { index: 0 }, nearest: false });
  });
});
```

(Imports: `buildOffer`, `describeWhen` from `./turn`; `describeDay` from `./extract/date`; `DAYPART_ORDER`, `DemoDirectory`, `daypartOf`, `type Daypart` from `../domain/directory`. `timeOfDay` is not a question yet in this task; passing it in `over` is harmless and becomes live in Task 3. The daypart test therefore asserts only after Task 3 lands; mark it `it.skip` with a `// Task 3` note in this commit and unskip it there.) `HAPPY` ends at the summary with `'Tuesday'` = 2026-09-22 and Thursday = 2026-09-24 for `todayIso` 2026-09-18; check the file's date constants before asserting. Existing tests that assert `vars` on a summary or completion (`toMatchObject` on `vars` with only slot keys) still pass; any that assert the full spoken text of a summary or completion need the new wording (grep `Shall I`, `You're booked`, `is moved`).

`seedCorpusSession` in `src/harness-text/runner.ts` builds the summary text for `confirm_` contexts with `summaryVars(session)`; it must settle bookings first so the model reads a real summary: give it a third parameter `directory: AppointmentDirectory`, and before computing `lastPromptText` in the confirming branch call `settleBookings(session, { kind: 'ignore' }, directory)` (exported from turn.ts; a non-prompt decision only fills the session). `runCorpusEntry` passes `opts.directory ?? new DemoDirectory(opts.todayIso)`.

`pnpm regress`: every summary and completion outcome that the baseline records by `promptId`/`acks`/`slots` is unchanged, but the spoken text is not part of the outcome, so expect "no changes" except entries whose acks gain `slot_nearest` (none yet: no corpus entry carries a daypart). If anything else moves, stop and report. `pnpm test`, `pnpm typecheck` clean. Commit `feat(core): summaries read the found booking and offer an opening on the caller's day`.

---

### Task 3: The two questions and moving the offer (one commit)

**Files:** `src/core/questions.ts`, `src/core/questions.test.ts` (+ snapshot), `src/core/turn.ts`, `src/core/turn.test.ts`, `src/jev/corpus.ts`, `src/jev/corpus.test.ts`, `src/jev/fixtureStub.ts`, `src/jev/heuristicStub.ts`, `fixtures/expected/*`.

- [x] **Step 1: Questions.** In `src/core/questions.ts` (import `SCHEDULING_FORMS` from `../domain/forms`):

```ts
/** Spec 2026-09-24 appointment-slots §5: a part of the day the caller volunteers. Read, never asked. */
function timeOfDay(): QuestionMap {
  return {
    timeOfDay: {
      type: 'choice',
      instructions: 'Read asr.text. Does the caller say what part of the day they want the appointment in? Read only what they say about the time of day; a weekday or a date on its own says nothing about it.',
      criteria: {
        morning: 'Asks for the morning, first thing, early, or a time before eleven',
        midday: 'Asks for midday, noon, lunchtime, late morning, early afternoon, or a time between eleven and two',
        afternoon: 'Asks for the afternoon, late in the day, after work, end of day, or a time from two onward',
        none: 'Says nothing about the part of the day',
      },
    },
  };
}

/** Spec §5: at a scheduling summary, a move along the day's openings. */
function timePreference(): QuestionMap {
  return {
    timePreference: {
      type: 'choice',
      instructions: 'Read asr.text and node.promptJustPlayed. The caller was offered an appointment at a specific time. Do they ask for a different time on the same day, and in which direction?',
      criteria: {
        earlier: 'Asks for an earlier time, or anything before the offered time, as in earlier, sooner in the day, or before that',
        later: 'Asks for a later time, or anything after the offered time, as in later, after that, or later in the day',
        different: 'Says the offered time does not work without saying which way, as in not that time, a different time, or that time is no good',
        none: 'Accepts, declines for another reason, names a day or a part of the day such as the morning or the afternoon, or says nothing about the time',
      },
    },
  };
}
```

In `buildQuestions`: after `inForm()`, `if (session.form && SCHEDULING_FORMS.includes(session.form)) Object.assign(q, timeOfDay());`, and after `formConfirmation(...)`: `if (session.pendingConfirmation?.target === 'form' && SCHEDULING_FORMS.includes(session.pendingConfirmation.form)) Object.assign(q, timePreference());`. Tests in `questions.test.ts`: `timeOfDay` present on a reschedule form and absent outside a form and on a cancel form; `timePreference` present only at a reschedule or schedule summary, absent at a cancel summary and mid-form. Refresh the snapshots (`-u`); the reschedule form and summary snapshots gain the questions.

- [x] **Step 2: Corpus labels and stubs.** `src/jev/corpus.ts`: `CorpusEntry` gains `/** a part of the day the caller volunteers (appointment-slots §5) */ timeOfDay?: Daypart;` and `/** at a scheduling summary: a move along the day's openings */ timePreference?: 'earlier' | 'later' | 'different';`; `ENTRY_KEYS` gains both; validation: `timeOfDay` must be one of the three dayparts and needs a `schedule_new`/`reschedule` form context or `confirm_schedule_new`/`confirm_reschedule` (use `contextForm`); `timePreference` must be one of the three and needs `confirm_schedule_new` or `confirm_reschedule`. Tests in `corpus.test.ts`: accepted where allowed, rejected on `cancel` and on `no_form`, rejected for a bad value. `src/jev/fixtureStub.ts` choice branch: `if (id === 'timeOfDay') return pick(entry.timeOfDay);` and `if (id === 'timePreference') return pick(entry.timePreference);` (`pick` maps undefined to `none`). `src/jev/heuristicStub.ts` choice switch:

```ts
      case 'timeOfDay': {
        const winner = has(text, /\b(morning|first thing|early|before (eleven|11))\b/) ? 'morning'
          : has(text, /\b(midday|mid-day|noon|lunch|lunchtime|late morning|early afternoon)\b/) ? 'midday'
          : has(text, /\b(afternoon|late in the day|after work|end of (the )?day|evening)\b/) ? 'afternoon' : 'none';
        return choiceAnswer(sharp(labels, winner, 0.9));
      }
      case 'timePreference': {
        const winner = has(text, /\b(earlier|sooner|before that)\b/) ? 'earlier'
          : has(text, /\b(later|after that)\b/) ? 'later'
          : has(text, /\b(different time|not that time|another time|time (doesn'?t|does not|won'?t) work|no good)\b/) ? 'different' : 'none';
        return choiceAnswer(sharp(labels, winner, 0.9));
      }
```

(`early afternoon` must be tested before `afternoon`, which the order above does, and `morning` before `late morning`: put the midday test first or exclude `late morning` from the morning pattern with a negative lookbehind `(?<!late )morning`. Use the lookbehind.)

- [x] **Step 3: Reading the daypart and moving the offer.** In `src/core/turn.ts`:

```ts
/** Spec §5: a part of the day the caller volunteers anywhere on a scheduling form is remembered. */
function readDaypart(s: Session, answers: AnswerMap, t: Thresholds): Daypart | null {
  const a = answers.timeOfDay;
  const [top] = isChoice(a) ? rankProbabilities(a.probabilities) : [];
  if (!top || top.label === 'none' || top.p < t.TIME_OF_DAY) return null;
  return top.label as Daypart;
}

/**
 * At a scheduling summary, move along the day's openings (spec §6 cases 2 and 3): a daypart to
 * the first opening inside it (or the nearest, said out loud), else earlier/later/different by
 * one step. `moved` is false at an edge or when nothing in the answer asked for a move; an edge
 * says so with an ack. The caller answered the summary, so the caller of this helper decides what
 * an unmoved offer costs on the ladder.
 */
function moveOffer(s: Session, answers: AnswerMap, t: Thresholds): { moved: boolean; acks: Ack[] } {
  const offer = s.offer;
  if (!offer || offer.times.length === 0) return { moved: false, acks: [] };
  const part = readDaypart(s, answers, t);
  if (part !== null) {
    s.daypart = part;
    const built = buildOffer(offer.date, offer.times, part);
    const moved = built.offer.index !== offer.index;
    s.offer = built.offer;
    const acks: Ack[] = built.nearest ? [{ promptId: 'slot_nearest', vars: { daypart: part, time: built.offer.times[built.offer.index]! } }] : [];
    return { moved, acks };
  }
  const a = answers.timePreference;
  const [top] = isChoice(a) ? rankProbabilities(a.probabilities) : [];
  if (!top || top.label === 'none' || top.p < t.TIME_PREFERENCE) return { moved: false, acks: [] };
  const last = offer.times.length - 1;
  if (top.label === 'earlier') {
    if (offer.index === 0) return { moved: false, acks: [{ promptId: 'slot_edge_earlier', vars: {} }] };
    offer.index -= 1;
    return { moved: true, acks: [] };
  }
  if (top.label === 'later') {
    if (offer.index === last) return { moved: false, acks: [{ promptId: 'slot_edge_later', vars: {} }] };
    offer.index += 1;
    return { moved: true, acks: [] };
  }
  // different: the next opening, wrapping to the first; a day with one opening cannot move.
  if (last === 0) return { moved: false, acks: [{ promptId: 'slot_edge_later', vars: {} }] };
  offer.index = offer.index === last ? 0 : offer.index + 1;
  return { moved: true, acks: [] };
}
```

Wire it into the two summary branches. In `case 'rejected'` (form target), after `correctingFill` and before the "Nothing usable" comment:

```ts
        if (!fill.progress && SCHEDULING_FORMS.includes(pc.form)) {
          // "No, later" moves the offer: a moved offer is a correction and re-arms the summary; an
          // edge is an unchanged summary and counts a turn on its ladder (spec §6).
          const move = moveOffer(s, answers, t);
          if (move.moved) return { decision: continueForm(s, [...acks, ...fill.acks, ...move.acks], null), events: fill.events };
          if (move.acks.length) { s.pendingConfirmation = pc; return { decision: reaskConfirmation(s, t, [...acks, ...move.acks]), events: fill.events }; }
        }
```

In `case 'confirm_unanswered'` (form target), the same block after its `correctingFill` (using `pc.form`; the confirmation is still pending there, so drop the `s.pendingConfirmation = pc` line). Also, outside the summary, a volunteered daypart is remembered on every scheduling-form turn: at the top of `handleVerdict` add `if (s.form && SCHEDULING_FORMS.includes(s.form)) { const part = readDaypart(s, answers, t); if (part !== null) s.daypart = part; }`; for the opener, `enterForm` does the same after `setForm` (it has `answers`). `moveOffer` re-reads it at the summary because the index must move too. Note `moveOffer` and `settleBookings` agree: after a move on the summary turn, `settleBookings` sees `offer.date === date.value` and leaves the index alone.

- [x] **Step 4: Tests** in `src/core/turn.test.ts`, `describe('moving the offer')`:

```ts
describe('moving the offer', () => {
  const LATER = choice({ later: 0.9, none: 0.1 });
  const EARLIER = choice({ earlier: 0.9, none: 0.1 });
  const DIFFERENT = choice({ different: 0.9, none: 0.1 });
  const atOffer = () => afterTurns(HAPPY);
  const timesAt = (r: TurnResult) => r.session.offer!.times;
  const indexAt = (r: TurnResult) => r.session.offer!.index;
  const pref = (r: TurnResult, say: string, timePreference: ReturnType<typeof choice>) =>
    heuristicTurn(r.session, say, { timePreference, confirmsYes: noul(0.05), confirmsNo: noul(0.6), changeSlot: choice({ none: 0.95 }) });

  it('moves later and earlier one opening at a time and re-reads the summary as a correction', () => {
    let r = pref(atOffer(), 'no, later', LATER);
    expect(indexAt(r)).toBe(1);
    expect(r.decision).toMatchObject({ promptId: 'confirm_reschedule', acks: [] });
    expect(varsOf(r.decision).when).toContain(timesAt(r)[1]!);
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 0 });
    r = pref(r, 'earlier please', EARLIER);
    expect(indexAt(r)).toBe(0);
  });

  it('says so at an edge and counts the turn on the summary ladder', () => {
    let r = pref(atOffer(), 'earlier', EARLIER);
    expect(indexAt(r)).toBe(0);
    expect(r.decision).toMatchObject({ promptId: 'confirm_reschedule', acks: [{ promptId: 'slot_edge_earlier', vars: {} }] });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 1 });
    r = pref(r, 'earlier', EARLIER);
    expect(r.decision).toMatchObject({ promptId: 'confirm_dtmf' });
  });

  it('takes the next opening on "that time does not work", wrapping to the first', () => {
    let r = pref(atOffer(), 'that time does not work', DIFFERENT);
    expect(indexAt(r)).toBe(1);
    r = pref(r, 'no good', DIFFERENT);
    expect(indexAt(r)).toBe(2);
    r = pref(r, 'not that one', DIFFERENT);
    expect(indexAt(r)).toBe(0);
  });

  it('moves to a daypart named at the summary, or the nearest with an ack', () => {
    const r0 = atOffer();
    const times = timesAt(r0);
    const target = DAYPART_ORDER.find((p) => times.some((t) => daypartOf(t) === p) && times.findIndex((t) => daypartOf(t) === p) !== 0);
    if (target) {
      const r = heuristicTurn(r0.session, `no, the ${target}`, { timeOfDay: choice({ [target]: 0.9, none: 0.1 }), confirmsNo: noul(0.8) });
      expect(r.session.daypart).toBe(target);
      expect(daypartOf(times[indexAt(r)]!)).toBe(target);
      expect(r.session.pendingConfirmation).toMatchObject({ attempts: 0 });
    }
    const missing = DAYPART_ORDER.find((p) => !times.some((t) => daypartOf(t) === p));
    if (missing) {
      const r = heuristicTurn(r0.session, `no, the ${missing}`, { timeOfDay: choice({ [missing]: 0.9, none: 0.1 }), confirmsNo: noul(0.8) });
      expect(r.decision).toMatchObject({ acks: [{ promptId: 'slot_nearest', vars: { daypart: missing } }] });
    }
  });

  it('restarts the offer on a new day, honouring a remembered daypart', () => {
    const r0 = atOffer();
    const part: Daypart = 'afternoon';
    let r = heuristicTurn(r0.session, 'no, the afternoon', { timeOfDay: choice({ afternoon: 0.9, none: 0.1 }), confirmsNo: noul(0.8) });
    expect(r.session.daypart).toBe(part);
    r = heuristicTurn(r.session, 'no, Thursday', { confirmsNo: noul(0.8) });
    expect(r.session.offer!.date).toBe('2026-09-24');
    const times = timesAt(r);
    const inside = times.findIndex((t) => daypartOf(t) === part);
    if (inside >= 0) expect(indexAt(r)).toBe(inside);
    else expect(r.decision).toMatchObject({ acks: [{ promptId: 'slot_nearest', vars: { daypart: part } }] });
  });

  it('ignores a preference on a cancel summary', () => {
    let r = say(started(), 'cancel with dr patel', { intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }) });
    r = identify(r.session);
    expect(r.decision).toMatchObject({ promptId: 'confirm_cancel' });
    r = say(r.session, 'later', { timePreference: LATER, confirmsNo: noul(0.6), changeSlot: choice({ none: 0.95 }) });
    expect(r.decision).toMatchObject({ promptId: 'ask_change' });
    expect(r.session.offer).toBeNull();
  });
});
```

Trace the `rejected` path before asserting: `confirmsNo: noul(0.6)` is below `CONFIRM_NO` (0.7), so these turns arrive as `confirm_unanswered`, not `rejected`; raise it to 0.8 where a `rejected` path is meant and keep one case on the unanswered path. Both branches carry the same block, and the test names should say which path each exercises. If a `timePreference` answer is not asked (no `timePreference` question because the form is cancel), `pick` in the stub never runs; the `say` helper passes the answer directly, which the gate ignores and `moveOffer` never sees because the block is guarded by `SCHEDULING_FORMS`. Unskip the Task 2 daypart tests. `pnpm regress` should still say "no changes" (no corpus entry carries the labels yet); `pnpm test`, `pnpm typecheck` clean. Commit `feat(core): a volunteered part of the day and earlier/later at the summary move the offered opening`.

---

### Task 4: Corpus, scenarios, baseline (one commit)

**Files:** `fixtures/corpus.jsonl`, `fixtures/scenarios/core.json`, `fixtures/expected/*`.

- [x] **Step 1: Corpus.** Append (ids `ts-` for time slots; every text must be unique after normalization, check with `pnpm regress` which rejects duplicates):

```jsonl
{"id":"ts-01","text":"Book me with Dr. Chen next Thursday afternoon","intent":"schedule_new","context":"no_form","slots":{"provider":"chen","date":{"mode":"weekday","weekday":"thursday","weekdayQualifier":"next"}},"timeOfDay":"afternoon","tags":["time_of_day"]}
{"id":"ts-02","text":"I need to reschedule to Tuesday morning","intent":"reschedule","context":"no_form","slots":{"date":{"mode":"weekday","weekday":"tuesday"}},"timeOfDay":"morning","tags":["time_of_day"]}
{"id":"ts-03","text":"Thursday, in the afternoon","intent":"none","context":"reschedule","prompted":"date","slots":{"date":{"mode":"weekday","weekday":"thursday"}},"timeOfDay":"afternoon","tags":["time_of_day"]}
{"id":"ts-04","text":"sometime around lunchtime works","intent":"none","context":"schedule_new","prompted":"date","timeOfDay":"midday","tags":["time_of_day"]}
{"id":"ts-05","text":"earlier","intent":"none","context":"confirm_reschedule","confirm":"unanswered","timePreference":"earlier","tags":["time_preference"]}
{"id":"ts-06","text":"later please","intent":"none","context":"confirm_reschedule","confirm":"unanswered","timePreference":"later","tags":["time_preference"]}
{"id":"ts-07","text":"no, later in the day","intent":"none","context":"confirm_schedule_new","confirm":"no","timePreference":"later","tags":["time_preference"]}
{"id":"ts-08","text":"that time doesn't work","intent":"none","context":"confirm_schedule_new","confirm":"no","timePreference":"different","tags":["time_preference"]}
{"id":"ts-09","text":"no, the morning","intent":"none","context":"confirm_reschedule","confirm":"no","timeOfDay":"morning","tags":["time_of_day"]}
{"id":"ts-10","text":"afternoon please","intent":"none","context":"confirm_schedule_new","confirm":"unanswered","timeOfDay":"afternoon","tags":["time_of_day"]}
{"id":"ts-11","text":"no, Thursday morning","intent":"none","context":"confirm_reschedule","confirm":"no","slots":{"date":{"mode":"weekday","weekday":"thursday"}},"timeOfDay":"morning","tags":["time_of_day"]}
{"id":"ts-12","text":"yes, that works","intent":"none","context":"confirm_schedule_new","confirm":"yes","tags":["time_preference"]}
```

Check the date label shapes against existing entries (`dt-*`, `fc-06`) before committing; `ts-04` has no date on purpose (it answers the day question with a window only, so it is a miss on the date and a remembered daypart). If a `weekdayQualifier` label is not how the corpus writes "next Thursday", copy the form an existing `next` entry uses.

- [x] **Step 2: Scenarios.** Append, in the file's one-field-per-line style:

```json
  { "id": "slot-daypart-opener", "steps": [ { "say": "Book me with Dr. Chen next Thursday afternoon" }, { "say": "Jason Stiles" }, { "say": "March fifth nineteen eighty" } ],
    "expect": { "decision": "prompt", "promptId": "confirm_schedule", "form": "schedule_new", "slots": { "provider": "chen" } } },
  { "id": "slot-later-then-yes", "steps": [ { "say": "I need to reschedule my appointment, it's with Dr. Chen sometime next week" }, { "say": "Jason Stiles" }, { "say": "March fifth nineteen eighty" }, { "say": "Tuesday" }, { "say": "later please" }, { "say": "yes" } ],
    "expect": { "decision": "complete", "promptId": "reschedule_confirmed", "form": "reschedule", "text": "Your appointment is moved to Tuesday, September 22 at" } },
  { "id": "slot-earlier-edge-then-day", "steps": [ { "say": "I need to reschedule my appointment, it's with Dr. Chen sometime next week" }, { "say": "Jason Stiles" }, { "say": "March fifth nineteen eighty" }, { "say": "Tuesday" }, { "say": "earlier" }, { "say": "no, Thursday morning" } ],
    "expect": { "decision": "prompt", "promptId": "confirm_reschedule", "form": "reschedule", "slots": { "date": "2026-09-24" } } },
  { "id": "slot-found-on-confirm", "steps": [ { "say": "Just confirming my visit with Dr. Chen next week" }, { "say": "Jason Stiles" }, { "say": "March fifth nineteen eighty" } ],
    "expect": { "decision": "prompt", "promptId": "confirm_appointment_details", "form": "confirm_appointment", "text": "I found your appointment with Dr. Chen. It's on" } },
  { "id": "slot-found-on-cancel", "steps": [ { "say": "I want to cancel my visit with Dr. Chen, my name is Jason Stiles" }, { "say": "March fifth nineteen eighty" } ],
    "expect": { "decision": "prompt", "promptId": "confirm_cancel", "form": "cancel", "text": "would be cancelled, for Jason Stiles" } },
```

Every step text must exist in the corpus (the ones above do: `sn-*`, `rs-02`, `cf-04`, `cn-04`, `reschedule-happy`'s steps, and the new `ts-*`), or the stub falls back to the heuristic. The `expect.text` of `slot-later-then-yes` is a prefix on purpose: the time depends on the demo hash. Run `pnpm regress`: the new entries and scenarios show as new; `ts-11` on the `earlier` edge scenario must land on the Thursday morning opening or `slot_nearest`; inspect. `pnpm regress --update`; `pnpm regress`, `pnpm test`, `pnpm typecheck` clean. Commit `fixtures: time-of-day and time-preference corpus entries, slot scenarios, baseline`.

---

### Task 5: Docs (one commit)

**Files:** `README.md`, this plan, the spec.

- [x] **README.** The call walkthrough: the summary line becomes "Your appointment with Dr. Chen is on <found day and time>. It would move to Tuesday, September 22 at <offered time>, for Jason Stiles, born March 5th, 1980. Shall I make that change?" (write the real demo values by running `pnpm cli` with the walkthrough's lines and copying what it says) and the completion "Your appointment is moved to Tuesday, September 22 at <time>." Text harness counts: corpus and scenarios (verify). Regression labels paragraph: `timeOfDay` and `timePreference`. Confirmation section: a paragraph on the directory seam, the found booking on confirm/cancel/reschedule, the offered opening and that a time is never asked for, a volunteered part of the day (never asked; three-hour windows 8 to 11, 11 to 2, 2 to 5; nearest opening with its ack), and earlier/later/different with the edge acks and their ladder cost. Recorded prompts: the clip list (three new acks, three daypart vocabulary clips, the four summaries' and two completions' re-recorded segments; run `pnpm prompts:check` for the exact missing and stale ids and counts). Live-call checklist: a call that says "Book me with Dr. Chen next Thursday afternoon" and hears the afternoon opening; "earlier" at the offer; "later" then yes and the completion with the time; a confirm call hearing the found booking.
- [x] **Spec and plan.** Spec status "implemented on branch appointment-slots; see the plan's deviation record"; fix any sentence the code contradicts. Append `## Deviations recorded during execution` here from the implementers' reports and the reviews; tick the boxes of Tasks 1 to 5. Commit `docs: appointment slots (found booking, offered opening, time-of-day preference)`.

---

### Task 6 (Jason)

- [ ] `pnpm prompts:check`; `pnpm prompts:generate` for the missing clips; `--only <id> --force` for each stale one it names. As of this commit, that is 10 missing (`confirm_reschedule.5`, `confirm_cancel.4`, `confirm_appointment_details.4`, `slot_edge_earlier.0`, `slot_edge_later.0`, `slot_nearest.0`, `slot_nearest.1`, `daypart.morning`, `daypart.midday`, `daypart.afternoon`) and 17 stale (`confirm_schedule.0`-`.3`, `confirm_reschedule.1`-`.4`, `confirm_cancel.1`-`.3`, `confirm_appointment_details.0`-`.3`, `schedule_confirmed.0`, `reschedule_confirmed.0`), plus `confirm_schedule.4` reported unused (its slot moved when the summary's tail changed; check the sheet before deleting it). Listen to a summary end to end for the two TTS seams (the found booking, the offered opening).
- [ ] `pnpm regress --client record` (every out-of-form turn, every scheduling-form turn and every summary turn re-keys; only cancel and confirm identity turns stand), then `pnpm regress --client recorded` and read the `ts-*` rows first: `timeOfDay` and `timePreference` are new to the model. Watch `ts-04` (a window with no day) and `ts-11` (a day and a window in one breath).
- [ ] Restart `pnpm serve`; walk the new checklist calls.

---

## Deviations recorded during execution

### Task 1: the directory (commits cc0d3bd, fcd2b43)

- The plan's `openings` loop (`(h >>> (i * 4)) % 9`) never terminates for the seed okafor/2026-10-19: JavaScript shift counts wrap modulo 32, so the candidates repeat with period 8 and that seed only ever reaches two residues. The first fix hashed the iteration index in, which clustered the three openings (54 of 84 possible sets; a one-per-window day only 0.2% of the time); it was replaced with a draw of three from nine without replacement off one hash (base 9, then 8, then 7), which terminates by construction and lands close to uniform (one-per-window 32%, a given window empty 24%, all three in one window 4%, against a random draw's 32/24/4).
- `hashOf` loops over UTF-16 code units. The plan's code-point loop read only the high surrogate of anything outside the basic multilingual plane.
- The seam's doc comment now states that the interface is synchronous by design: `settleBookings` calls it inside `resolve`, on the same turn that fills the keys it needs, so a network-backed directory would need `resolve` to hand a lookup step back to the async `runTurn`, which is a framework change this seam does not cover.
- Spec §2 said the server passes `new DemoDirectory()`; the constructor takes `todayIso`. Fixed in the spec.
- Spec §2 named `DAYPARTS`; the code has `DAYPART_ORDER`, `daypartOf`, `daypartBounds`. Fixed in the spec.

### Task 2: the found booking and the first offer (commit 0eac4b6, fix commit 62aec3a)

- `offer` and `existing` are cleared only on the chained-form path of `completeForm`. A plain completion keeps them, because the call ends right after and `settleBookings` re-renders the completion's variables from the same offer the summary already read.
- `tags.json` needed an entry for every recordable clip: the four summaries' segment counts changed (`confirm_schedule` lost one, the other three gained one) and the three `daypart.*` vocabulary clips were added.
- Two `render.test.ts` rule tests needed rewriting: a summary now names `{when}` instead of `{date}`, plus `{existing}` on the three forms that find a booking; a completion may name only `{when}`, and only on the two booking forms.
- The chained-form turn test needed an explicit `intentChange` override, because the heuristic stub does not label "yes, and can I also ask about my bill" as adding a request on its own.
- In the first commit `ask_change` and `confirm_dtmf` (prompts with target `confirm` while a form summary is pending) had their empty vars replaced with the summary's; the fix commit matches the summary prompt's id instead, and a test pins that `ask_change`'s vars stay empty.
- In the first commit `slot_nearest` was prepended to whatever prompt the turn produced; the fix commit adds it last and only on the decision that reads the summary back. It can still ride on a transfer offer only through the `moveOffer` path, where a daypart named on the same turn the offer is made is answered before the offer displaces the summary. Rare, and left as is.
- Found in review, fixed in the follow-up commit: `existing` was looked up only while it was still null, and the offer was rebuilt only when the date changed, so a provider or identity correction at the summary kept reading back the old doctor's booking and openings.
- Fix commit 62aec3a: `existing` is now recomputed from the current identity and provider on every settle. `Offer` records `provider` and is rebuilt when the provider or the day changed (the index stands only when neither did) and cleared when the form or its keys no longer apply. The offer is built, with `slot_nearest` attached last, only on the decision that actually reads the summary back or a completion, since spec §3's "when the form becomes full" put the nearest ack on a slot question and ignored a daypart said after the date. `settleBookings` also runs on the silence branch, because a transfer offer declined by two silences re-asks a summary that needs its offer. `seedCorpusSession` settles with the summary prompt as the decision. `summaryVars` renders an empty day as `''` rather than "at undefined". `buildOffer` takes `(provider, date, times, daypart)`. `directoryOf(opts)` sits beside `nowOf`, and `RunOptions`'s doc now warns that an omitted directory means invented bookings.
- Spec §3 said the found booking is looked up "when the form becomes full" and the offer "rebuilt whenever a correction changes the date"; the code recomputes both from the current slots on every summary read, which also covers a corrected doctor or identity. Fixed in the spec.
- Spec §4's examples said "October 6th"; `describeDay` gives "October 6" with no ordinal, matching every other spoken date. Fixed in the spec.

### Task 3: the two questions and moving the offer (commit 6c2491e, fix commit 1abeba2)

- `timeOfDay` was asked only while a scheduling form was active, so an opener such as "book me with Dr. Chen next Thursday afternoon" never carried its window, even though spec §5 says it is read on the opener. Decision: ask it on every out-of-form turn as well, the way `secondIntent` already is; keep the `enterForm` read; and allow the corpus label on `no_form` entries whose intent is a scheduling form. This re-keys every opener turn, but the cassette is fully re-recorded in Task 6 regardless.
- `src/server/dashboard/view.js` and its test changed, outside the plan's file list: the two new question ids need their thresholds (`TIME_OF_DAY`, `TIME_PREFERENCE`) and groups (`timePreference` in the confirmation group, `timeOfDay` under the date slot); without that they fell into `other` with no tick.
- At a `confirm_unanswered` edge (earlier at the earliest opening), the existing rule that a turn which queued a request does not count is kept; a `rejected` edge always counts.
- `enterForm` reads the daypart only for scheduling forms, matching the check at the top of `handleVerdict`.
- On the `rejected` path, a daypart that leaves the index where it was and needs no nearest ack falls through to `ask_change`, the existing plain-no behavior.
- A repeated missing daypart from the nearest opening leaves the index put, plays `slot_nearest` once, and still counts the turn.
- Fix round, commit 1abeba2: `different` at the last opening no longer wraps to the first, though spec §6 originally said it should; instead it plays "That's the latest opening that day." and counts on the ladder, so a caller who turns down every opening reaches the keypad prompt instead of cycling 1, 2, 0, 1 with a fresh attempt count each time. A daypart is not recorded from an `ignore`, `hold`, or `nomatch` turn. A daypart that does not move the index no longer swallows a preference said in the same breath ("later, in the morning" at a morning offer still moves later). The yes to an explicit intent check also reads its own turn's daypart ("yes, in the afternoon"). `timeOfDay`'s instructions now say a greeting like "good morning" is not a part of the day, and that "earlier" or "later" on their own are not either; `changeSlot`'s date criterion excludes "a different time on the same day". Fixed in the spec (§5, §6).
- Known and left: a daypart said on an out-of-form turn that does not enter a form (a disambiguation answer, a nomatch retry) is dropped; a mid-form switch from cancel or confirm into a scheduling form loses a daypart said in the switching breath, because `timeOfDay` is not asked under those forms.

### Task 4: corpus, scenarios, baseline (commits e68242f, 5ba15e9)

- A sixth scenario, `slot-different-to-edge`, pins the no-wrap rule: three "that time doesn't work" answers walk 8:30, 10:00, 12:30, and a fourth, added in the second commit, plays "That's the latest opening that day." and reaches the keypad prompt.
- `ts-09` ("no, the morning" at an offer already in the morning) lands on "What should I change?": on the rejected path, a daypart that leaves the index where it was is a plain no. A short "That one is already in the morning" acknowledgment would be kinder; not built. Noted in the README as a known rough edge.
- `ts-04` ("sometime around lunchtime works" at the day question) is a miss on the date and remembers midday; the retry line follows.
- The `confirm_` contexts seed Dr. Patel on 2026-09-22, whose demo openings are 10:00 AM, 11:15 AM, and 1:00 PM with no afternoon, so `ts-10` "afternoon please" exercises the nearest rule in the baseline.
- Second commit 5ba15e9: `slot-daypart-opener` pins the 4:15 PM afternoon opening; `slot-nearest-opening` pins "The closest I have to the afternoon is 12:30 PM."; `slot-daypart-remembered` pins that a daypart said on a missed day answer opens the offer at 12:30 PM; `slot-different-to-edge` now walks to the keypad prompt on the fourth refusal, pinning the ladder cost of an edge.
- Corpus and scenario counts: 241 entries, 89 scenarios.

### Found on the real-model record (commits 7faf13a, ca3b691, and the cassette commit)

- At "What should I change?" a bare "no" scored 0.62 as `timePreference: different`, which moved the offer, re-armed the summary and kept the repeated-no ladder from ever handing off. The question now says a bare no answers the yes/no, not the time; the summary turns re-keyed and were re-recorded.
- "Monday, September 28" split the model's mode 0.50 weekday to 0.48 absolute and landed on the next Monday. The date slot now lets a confident month and day take the mode. The entry fills the 28th with an implicit readback, since the split leaves it under the silent-fill band; recorded as a known diff on `dt-09`.
- "Agent" alone scored 0.67 on `addressedToSystem` against the 0.70 gate once `timeOfDay` joined the opener's questions, and was ignored. `GATE_ADDRESSED` stepped 0.70 → 0.65 by judgment (the sweep's grid gains that outcome from 0.55 to 0.65 and loses none, and declined to move on its own). The trade: "um" scores 0.66, so the `ns-03` noise entry now gets the open re-ask instead of being ignored.
- `fc-09` ("no, next week") and `fc-13` ("no, it's Jason Miles") now decide on the `changeSlot` gate rather than the confirmation gate with the same outcome; informational, like `fc-23`.
- Real model after the second record: 229/241 corpus, 88/89 scenarios; every `ts-*` row and every `slot-*` scenario matches.

