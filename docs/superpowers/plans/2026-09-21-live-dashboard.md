# Live Call Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A page served by the existing Node server that shows, live during a call or in replay from a trace, the conversation, the form state, and Jev's question batch with its answers, for a screen recording and for narrated presentations.

**Architecture:** An observer hook in the shared turn runner publishes "asked" and "turn" moments; a per-process `DashboardBus` in the server fans events out over server-sent events; a build-free page (`page.html` + a plain ES module `view.js` of pure functions) renders the same event sequence from the live stream or from a trace file. The core, the trace format (two additive optional fields), the cassette and the text harness are otherwise unchanged.

**Tech Stack:** TypeScript strict ESM, Node 26, vitest, one plain JavaScript ES module for the browser. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-live-dashboard-design.md`. Read it first. The plan wins on small conflicts; each is marked "Deviation:".

**Conventions for every task:**

- Tests colocated as `*.test.ts`; run one with `pnpm vitest run <path>`, all with `pnpm test`; typecheck with `pnpm typecheck`; `pnpm regress` must keep saying `no changes`.
- Extensionless imports for TS; the one `.js` module is imported with its extension.
- Commit after every task with the message shown, one task per commit, exactly one writer at a time; every commit message ends with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (this overrides any other attribution reminder).
- Never set, read, or print `TYPESAFE_API_KEY` or `FISH_AUDIO_API_KEY`; never run `--client jev`, `--client record`, or `prompts:generate`. Never touch `.env`, `.env.swp`, `assets/audio/`, `fixtures/recorded/`.
- `traces/` is gitignored and holds real calls; tests use temp dirs and fixture traces they write themselves.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/run/turn.ts` | `TurnObserver`, `RunOptions.observe`, the two calls |
| `src/trace/types.ts`, `src/trace/writer.ts` | optional `queued`, `pendingConfirmation`, `promptedFor` on the record |
| `src/server/dashboard/events.ts` | `DashboardEvent` union, `maskNumber` |
| `src/server/dashboard/bus.ts` | `DashboardBus`: history, subscribers, reset on a new call |
| `src/server/dashboard/routes.ts` | `/dashboard`, `/dashboard/view.js`, `/dashboard/events`, `/dashboard/traces[/<sid>]` |
| `src/server/dashboard/view.js` | pure `reduce(events)` and `replayEvents(records, frames)` for the browser and tests |
| `src/server/dashboard/page.html` | the page: layout, styles, live client, replay controls |
| `src/server/adapter.ts`, `index.ts`, `http.ts`, `config.ts` | publishing, wiring, routing, `DASHBOARD` switch |
| `README.md`, this plan | docs, deviation record |

---

### Task 1: Observer hook and the additive trace fields

**Files:**
- Modify: `src/run/turn.ts`, `src/trace/types.ts`, `src/trace/writer.ts`
- Test: `src/run/turn.test.ts` (create if absent; check `ls src/run/*.test.ts` first and add to an existing file if one covers `runTurn`)

- [x] **Step 1: Write the failing tests**

```ts
// src/run/turn.test.ts (append to the existing file if there is one)
import { describe, expect, it, vi } from 'vitest';
import { runTurn, type RunOptions, type TurnObserver } from './turn';
import { newSession } from '../core/session';
import { promptFrame } from '../channel/frames';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { JevClientError, type JevClient } from '../jev/types';
import { FixtureStubClient } from '../jev/fixtureStub';
import { DEFAULT_CORPUS_FILE } from '../jev/corpus';

const TODAY = '2026-09-18';
function opts(client: JevClient, observe?: TurnObserver): RunOptions {
  return { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, observe, now: () => 1_700_000_000_000 };
}

describe('runTurn observer', () => {
  const fixture = new FixtureStubClient(DEFAULT_CORPUS_FILE);

  it('fires asked before the client and turn after, with the record', async () => {
    const order: string[] = [];
    const seen: { questions: unknown; client: unknown } = { questions: null, client: null };
    const client: JevClient = {
      ask: async (req) => { order.push('client'); seen.client = req.questions; return fixture.ask(req); },
    } as JevClient;
    const observe: TurnObserver = {
      asked: (questions) => { order.push('asked'); seen.questions = questions; },
      turn: (record, at) => { order.push('turn'); expect(record.turnIndex).toBe(0); expect(at).toBe(1_700_000_000_000); },
    };
    const session = newSession('CA1', 1_700_000_000_000);
    await runTurn(session, promptFrame("I need to reschedule my appointment, it's with Dr. Chen sometime next week"), opts(client, observe));
    expect(order).toEqual(['asked', 'client', 'turn']);
    expect(seen.questions).toBe(seen.client);
  });

  it('fires turn but not asked when the model is not needed', async () => {
    const observe = { asked: vi.fn(), turn: vi.fn() };
    const session = newSession('CA1', 0);
    // A setup frame plans the greeting without asking the model.
    await runTurn(session, { type: 'setup', callSid: 'CA1', sessionId: 'VX', from: '+15550001111', to: '+15550002222' } as never, opts(fixture, observe));
    expect(observe.asked).not.toHaveBeenCalled();
    expect(observe.turn).toHaveBeenCalledTimes(1);
  });

  it('fires turn when the client throws a client error', async () => {
    const observe = { asked: vi.fn(), turn: vi.fn() };
    const failing = { ask: async () => { throw new JevClientError('timeout', 'injected'); } } as unknown as JevClient;
    const session = newSession('CA1', 0);
    await runTurn(session, promptFrame('hello'), opts(failing, observe));
    expect(observe.asked).toHaveBeenCalledTimes(1);
    expect(observe.turn).toHaveBeenCalledTimes(1);
    expect(observe.turn.mock.calls[0]![0].error?.message).toBe('injected');
  });

  it('records queued tasks, the pending confirmation and promptedFor on the trace record', async () => {
    const session = newSession('CA1', 0);
    const run = await runTurn(session, promptFrame('I need to reschedule my appointment with Dr. Alvarez for next Thursday, and also I have a question about my bill'), opts(fixture));
    expect(run.record.queued).toEqual(['billing']);
    expect(run.record.pendingConfirmation).toBeNull();
    expect(run.record.promptedFor).toBe('name');
  });
});
```

Check the exact constructor and export names before running: `grep -n "export class\|export const DEFAULT_CORPUS_FILE\|export function newSession\|export function promptFrame\|class JevClientError" src/jev/fixtureStub.ts src/jev/corpus.ts src/core/session.ts src/channel/frames.ts src/jev/types.ts`, and the setup-frame shape in `src/channel/frames.ts` (use `setupFrame(...)` if a helper exists). Adjust the test to the real names; do not invent new helpers.

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/run/turn.test.ts`
Expected: FAIL on `observe` not being a known option / `record.queued` undefined.

- [x] **Step 3: Implement**

`src/trace/types.ts`, inside `TraceRecord` after `slots`:

```ts
  /** Added 2026-09-21 for the dashboard; optional so records written before then still load. */
  queued?: FormId[];
  pendingConfirmation?: PendingConfirmation | null;
  promptedFor?: 'intent' | 'confirm' | SlotId | null;
```

with `import type { FormId } from '../domain/forms'` and `import type { PendingConfirmation } from '../core/session'` (check the export names). Keep `v: 1`: the fields are additive.

`src/trace/writer.ts`, in `buildTraceRecord`, alongside `form` and `slots`:

```ts
    queued: [...s.queued],
    pendingConfirmation: s.pendingConfirmation,
    promptedFor: s.promptedFor,
```

where `s` is the session the function already reads `form`/`slots` from (`input.result.session`).

`src/run/turn.ts`:

```ts
export interface TurnObserver {
  /** The request to the model is about to leave; `questions` is the object the client receives. */
  asked(questions: QuestionMap, turnState: TurnState, at: number): void;
  /** The turn is resolved; `record` is the trace record as written. Fires whether or not the model was asked. */
  turn(record: TraceRecord, at: number): void;
}

export interface RunOptions {
  client: JevClient;
  thresholds: Thresholds;
  todayIso: string;
  trace?: TraceWriter | null;
  now?: () => number;
  /** Server-only. The text harness scores `text` frames and must leave this unset. */
  render?: RenderContext | null;
  /** A live watcher of the dialogue (the dashboard). Unset in the harness and the CLI. */
  observe?: TurnObserver | null;
}
```

In `runTurn`, immediately before `response = await opts.client.ask(...)`:

```ts
      opts.observe?.asked(p.questions!, p.turnState as TurnState, now());
```

and after `opts.trace?.write(record);`:

```ts
  opts.observe?.turn(record, now());
```

Import `TurnState` from `../core/state`. An observer that throws must not break the turn: wrap both calls in `try { ... } catch { /* observers are best effort */ }`.

- [x] **Step 4: Run the tests, the suite, typecheck, regress**

Run: `pnpm vitest run src/run/turn.test.ts && pnpm test && pnpm typecheck && pnpm regress`
Expected: all pass; regress `no changes` (the expected files compare outcomes, not whole records; if `fixtures/expected` shows a diff, the outcome extractor copies the whole record and the three fields must be excluded there instead of removed).

- [x] **Step 5: Commit**

```bash
git add src/run/turn.ts src/run/turn.test.ts src/trace/types.ts src/trace/writer.ts
git commit -m "feat(run): a turn observer hook; the trace record carries queued, pendingConfirmation and promptedFor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Events and the bus

**Files:**
- Create: `src/server/dashboard/events.ts`, `src/server/dashboard/bus.ts`
- Test: `src/server/dashboard/bus.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// src/server/dashboard/bus.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DashboardBus } from './bus';
import { maskNumber, type DashboardEvent } from './events';

const started = (callSid: string, at = 1): DashboardEvent => ({ type: 'call_started', callSid, at, from: '…2926', todayIso: '2026-09-21', thresholds: {} });
const dtmf = (callSid: string, digit: string, at = 2): DashboardEvent => ({ type: 'dtmf', callSid, at, digit });

describe('DashboardBus', () => {
  it('fans out to subscribers and numbers events', () => {
    const bus = new DashboardBus();
    const a = vi.fn(); const b = vi.fn();
    bus.subscribe(a); bus.subscribe(b);
    bus.publish(started('CA1'));
    bus.publish(dtmf('CA1', '1'));
    expect(a).toHaveBeenCalledTimes(2);
    expect(b.mock.calls.map((c) => c[0].seq)).toEqual([1, 2]);
  });

  it('replays the history to a late subscriber', () => {
    const bus = new DashboardBus();
    bus.publish(started('CA1'));
    bus.publish(dtmf('CA1', '1'));
    const late = vi.fn();
    bus.subscribe(late);
    expect(late.mock.calls.map((c) => c[0].type)).toEqual(['call_started', 'dtmf']);
  });

  it('resets the history when a new call starts and ignores events for older calls', () => {
    const bus = new DashboardBus();
    bus.publish(started('CA1'));
    bus.publish(dtmf('CA1', '1'));
    bus.publish(started('CA2', 5));
    bus.publish(dtmf('CA1', '2', 6)); // a straggler from the old call
    const late = vi.fn();
    bus.subscribe(late);
    expect(late.mock.calls.map((c) => [c[0].type, c[0].callSid])).toEqual([['call_started', 'CA2']]);
  });

  it('bounds the history', () => {
    const bus = new DashboardBus(3);
    bus.publish(started('CA1'));
    for (let i = 0; i < 5; i++) bus.publish(dtmf('CA1', String(i), 10 + i));
    const late = vi.fn();
    bus.subscribe(late);
    // The call_started event is always kept, then the newest two.
    expect(late.mock.calls.map((c) => c[0].type)).toEqual(['call_started', 'dtmf', 'dtmf']);
  });

  it('unsubscribes', () => {
    const bus = new DashboardBus();
    const a = vi.fn();
    const off = bus.subscribe(a);
    off();
    bus.publish(started('CA1'));
    expect(a).not.toHaveBeenCalled();
  });
});

describe('maskNumber', () => {
  it('keeps the last four digits', () => {
    expect(maskNumber('+18595222926')).toBe('…2926');
    expect(maskNumber(undefined)).toBe('unknown');
    expect(maskNumber('123')).toBe('…123');
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/server/dashboard/bus.test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Implement**

```ts
// src/server/dashboard/events.ts
import type { QuestionMap } from '../../jev/types';
import type { TurnState } from '../../core/state';
import type { TraceRecord } from '../../trace/types';
import type { Thresholds } from '../../core/thresholds';

interface Base { callSid: string; at: number; seq?: number }

export type DashboardEvent =
  | (Base & { type: 'call_started'; from: string; todayIso: string; thresholds: Partial<Thresholds> })
  | (Base & { type: 'asked'; turnIndex: number; questions: QuestionMap; turnState: TurnState })
  | (Base & { type: 'turn'; record: TraceRecord; spoken: string })
  | (Base & { type: 'silence'; promptId: string | null })
  | (Base & { type: 'dtmf'; digit: string })
  | (Base & { type: 'interrupt'; utteranceUntilInterrupt: string | null })
  | (Base & { type: 'reconnect'; attempt: number })
  | (Base & { type: 'handoff'; reason: string; number: string })
  | (Base & { type: 'ended'; reason: 'completed' | 'hangup' | 'handoff' | 'error' });

export type DashboardEventType = DashboardEvent['type'];

/** The last four digits only; the page never shows a whole caller number. */
export function maskNumber(n: string | undefined | null): string {
  if (!n) return 'unknown';
  const digits = n.replace(/\D/g, '');
  return `…${digits.slice(-4)}`;
}
```

```ts
// src/server/dashboard/bus.ts
import type { DashboardEvent } from './events';

export type Subscriber = (event: DashboardEvent) => void;

/**
 * Fans dashboard events out to subscribers and keeps the current call's history so a page
 * opened mid-call catches up. Follows the most recent call: a `call_started` for a new CallSid
 * drops the previous history, and later events for an older call are ignored.
 */
export class DashboardBus {
  private history: DashboardEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private callSid: string | null = null;
  private seq = 0;

  constructor(private readonly maxHistory = 2000) {}

  publish(event: DashboardEvent): void {
    if (event.type === 'call_started') {
      this.callSid = event.callSid;
      this.history = [];
    } else if (event.callSid !== this.callSid) {
      return;
    }
    const numbered = { ...event, seq: ++this.seq };
    this.history.push(numbered);
    if (this.history.length > this.maxHistory) {
      // Keep call_started at index 0, drop the oldest of the rest.
      this.history.splice(1, this.history.length - this.maxHistory);
    }
    for (const s of this.subscribers) {
      try { s(numbered); } catch { /* a broken subscriber never breaks a call */ }
    }
  }

  /** Replays the history, then streams. Returns the unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    for (const e of this.history) fn(e);
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  current(): string | null { return this.callSid; }
  size(): number { return this.subscribers.size; }
}
```

- [x] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run src/server/dashboard/bus.test.ts && pnpm typecheck`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/server/dashboard/events.ts src/server/dashboard/bus.ts src/server/dashboard/bus.test.ts
git commit -m "feat(server): dashboard events and a per-call event bus

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The adapter publishes; the server wires the bus

**Files:**
- Modify: `src/server/adapter.ts`, `src/server/index.ts`, `src/server/config.ts`
- Test: `src/server/adapter.test.ts`, `src/server/config.test.ts`

- [x] **Step 1: Read first** `src/server/adapter.ts` in full (about 470 lines) and the existing test scaffolding in `src/server/adapter.test.ts` (how a fake `deps`, store and socket are built). The moments to publish are all already there:

| moment | where in adapter.ts | event |
| --- | --- | --- |
| first setup for a call | the `deps.store.create(frame.callSid, socket)` branch | `call_started` (`from: maskNumber(frame.from)`, `todayIso: entry.opts.todayIso`, `thresholds: entry.opts.thresholds`) |
| reconnect setup | the `existing` branch, after `entry.frames.write('log', { resumed: true, ... })` | `reconnect` (`attempt: existing.reconnects`) |
| silence turn fires | inside `armNoInput`'s timer, before `turn(deps, e, silenceFrame())` | `silence` (`promptId: e.session.lastPromptId`) |
| a dtmf frame | in `handleSocketMessage` right after the `clearNoInput` line (before the `#`/`*` ignore) | `dtmf` |
| an interrupt frame | same place | `interrupt` (`utteranceUntilInterrupt: frame.utteranceUntilInterrupt ?? null`; check the field name in `src/channel/frames.ts`) |
| a turn ends the call | in `turn()`, where `ending` is computed | `handoff` when `kind === 'handoff'` (`reason: run.result.decision.reason`, `number: maskNumber(deps.handoffNumber)`; add `handoffNumber?: string` to `AdapterDeps`) and then `ended` (`reason: kind === 'complete' ? 'completed' : 'handoff'`) |
| socket closes on a call that has not ended | `handleSocketClose` where the store entry is still live and this is the live socket | `ended` with `reason: 'hangup'` (only if `!entry.ended`; a reconnect will not get here because Twilio's reconnect setup arrives on a new socket first; if it does, the next `reconnect` event tells the page) |
| a turn throws | the `catch` in `turn()` | nothing extra: the `turn` observer event carries `error` |

`asked` and `turn` come from the observer (Task 1), not the adapter: `index.ts` attaches it.

- [x] **Step 2: Write the failing tests** in `src/server/adapter.test.ts`, following the file's existing helpers for building `deps` and a fake socket. Add `bus: new DashboardBus()` to the deps the helpers build (keep it optional in `AdapterDeps` so other tests need no change) and a subscriber that collects `event.type`:

```ts
it('publishes the call lifecycle to the dashboard bus', async () => {
  const bus = new DashboardBus();
  const seen: string[] = [];
  bus.subscribe((e) => seen.push(e.type));
  const { deps, socket, ctx } = makeDeps({ bus }); // adapt to the file's helper
  await handleSocketMessage(deps, socket, ctx, JSON.stringify(setupFrame('CA1', 'VX', '+18595222926')));
  await handleSocketMessage(deps, socket, ctx, JSON.stringify({ type: 'dtmf', digit: '1' }));
  await handleSocketMessage(deps, socket, ctx, JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'What', durationUntilInterruptMs: 300 }));
  expect(seen.slice(0, 3)).toEqual(['call_started', 'turn', 'dtmf']);
  expect(seen).toContain('interrupt');
  const started = bus['history'][0] as { from: string };
  expect(started.from).toBe('…2926');
});

it('publishes silence when the no-input timer fires', async () => {
  // Mirror the existing no-input test (fake timers, noInputMs small); after advancing time expect
  // the collected types to include 'silence' before the silence turn's 'turn'.
});

it('publishes handoff and ended when a turn hands off, and ended on a hangup', async () => {
  // Say "agent" (an utterance the fixture stub routes to a live-agent handoff) and expect
  // [..., 'turn', 'handoff', 'ended']; on a fresh call, close the socket before end and expect 'ended' with reason 'hangup'.
});
```

Fill the two sketched tests with the file's real helpers; the point of each is the event sequence. Also in `src/server/config.test.ts`: `DASHBOARD=off` → `config.dashboard === false`; unset → `true`; any other value → a config error naming `DASHBOARD` (follow how the file tests other switches such as `SIGNATURE_CHECK`).

- [x] **Step 3: Run to verify they fail**

Run: `pnpm vitest run src/server/adapter.test.ts src/server/config.test.ts`
Expected: FAIL (no `bus` in deps, no `dashboard` in config).

- [x] **Step 4: Implement**

`src/server/config.ts`: add `dashboard: boolean` to `ServerConfig`, read `DASHBOARD` (`off` → false, unset or `on` → true, else error), print it in the startup config summary like the other booleans.

`src/server/adapter.ts`:

```ts
import { DashboardBus } from './dashboard/bus';
import { maskNumber } from './dashboard/events';
...
export interface AdapterDeps {
  ...
  /** The dashboard's event bus; absent when the dashboard is off. */
  bus?: DashboardBus;
  /** For the masked number on a handoff event. */
  handoffNumber?: string;
}

function publish(deps: AdapterDeps, event: Parameters<DashboardBus['publish']>[0]): void {
  deps.bus?.publish(event);
}
```

Then one `publish(deps, { type: ..., callSid, at: Date.now(), ... })` at each moment in the table. Use the deps' clock if the adapter has one (`deps.now`); otherwise `Date.now()`.

`src/server/index.ts`: construct `const bus = config.dashboard ? new DashboardBus() : undefined;` before the store. In the `CallResources` factory, when `bus` exists, build the observer:

```ts
      const observe = bus
        ? {
            asked: (questions, turnState, at) => bus.publish({ type: 'asked', callSid, at, turnIndex: turnState.history.length, questions, turnState }),
            turn: (record, at) => bus.publish({ type: 'turn', callSid, at, record, spoken: spokenText(record.decision) }),
          }
        : null;
```

(`turnIndex`: use `record.turnIndex` in `turn`; for `asked`, keep a counter on the entry or read `session.turnIndex` via a closure over the resources object; the plan accepts `turnState.history.length` only if the Task 1 test shows it equals the turn index, otherwise thread `session.turnIndex` through a closure.) Pass `observe` in `opts`, and `bus` + `handoffNumber: config.handoffNumber` into the adapter deps object given to `attachWebSocketServer`. Export `bus` on `RunningServer` so tests can subscribe (`running.bus`).

Import `spokenText` from `../prompts/render`.

- [x] **Step 5: Run tests, suite, typecheck, regress**

Run: `pnpm vitest run src/server && pnpm test && pnpm typecheck && pnpm regress`
Expected: PASS, `no changes`.

- [x] **Step 6: Commit**

```bash
git add src/server/adapter.ts src/server/adapter.test.ts src/server/index.ts src/server/config.ts src/server/config.test.ts
git commit -m "feat(server): the adapter publishes call moments to the dashboard bus; DASHBOARD switch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Routes

**Files:**
- Create: `src/server/dashboard/routes.ts`, a placeholder `src/server/dashboard/page.html` (one line: `<!doctype html><title>dashboard</title><p>coming in Task 6</p>`) and `src/server/dashboard/view.js` (one line: `export const VIEW_PLACEHOLDER = true;`), both replaced in Tasks 5 and 6
- Modify: `src/server/http.ts` (delegate `/dashboard*` when `config.dashboard`), `src/server/index.ts` (pass `bus` and `traceDir` into `HttpDeps`)
- Test: `src/server/dashboard/routes.test.ts`, one end-to-end test in `src/server/server.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
// src/server/dashboard/routes.test.ts
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardBus } from './bus';
import { handleDashboardRequest } from './routes';

function serve(bus: DashboardBus, traceDir: string) {
  const server = createServer((req, res) => {
    const handled = handleDashboardRequest(req, res, { bus, traceDir, enabled: true });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  return new Promise<{ base: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

describe('dashboard routes', () => {
  it('serves the page and the view module with no-store', async () => {
    const s = await serve(new DashboardBus(), mkdtempSync(join(tmpdir(), 'dash-')));
    const page = await fetch(`${s.base}/dashboard`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const js = await fetch(`${s.base}/dashboard/view.js`);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    s.close();
  });

  it('streams history then live events over SSE', async () => {
    const bus = new DashboardBus();
    bus.publish({ type: 'call_started', callSid: 'CA1', at: 1, from: '…2926', todayIso: '2026-09-21', thresholds: {} });
    const s = await serve(bus, mkdtempSync(join(tmpdir(), 'dash-')));
    const res = await fetch(`${s.base}/dashboard/events`);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readUntil = async (n: number) => { while ((buf.match(/\ndata: /g) ?? []).length < n) buf += dec.decode((await reader.read()).value); };
    await readUntil(1);
    bus.publish({ type: 'dtmf', callSid: 'CA1', at: 2, digit: '1' });
    await readUntil(2);
    const events = buf.split('\n\n').filter((b) => b.includes('data: ')).map((b) => JSON.parse(b.split('data: ')[1]!));
    expect(events.map((e) => e.type)).toEqual(['call_started', 'dtmf']);
    expect(buf).toMatch(/^id: 1\n/m);
    await reader.cancel();
    s.close();
  });

  it('lists traces and returns one with its frames; refuses a bad sid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const rec = { v: 1, sessionId: 'CA9', turnIndex: 0, ts: '2026-09-21T00:00:00.000Z', event: { type: 'setup' }, decision: { kind: 'prompt', promptId: 'greeting', vars: {}, acks: [] }, slots: {}, form: null, gates: [], frames: [], timing: {}, usage: {} };
    writeFileSync(join(dir, 'CA9.jsonl'), JSON.stringify(rec) + '\n');
    writeFileSync(join(dir, 'CA9.frames.jsonl'), JSON.stringify({ ts: '2026-09-21T00:00:00.000Z', dir: 'in', msg: { type: 'setup', callSid: 'CA9' } }) + '\n');
    const s = await serve(new DashboardBus(), dir);
    const list = await (await fetch(`${s.base}/dashboard/traces`)).json();
    expect(list).toEqual([{ callSid: 'CA9', startedAt: '2026-09-21T00:00:00.000Z', turns: 1, sizeBytes: expect.any(Number) }]);
    const one = await (await fetch(`${s.base}/dashboard/traces/CA9`)).json();
    expect(one.records).toHaveLength(1);
    expect(one.frames).toHaveLength(1);
    expect((await fetch(`${s.base}/dashboard/traces/..%2Fetc`)).status).toBe(404);
    expect((await fetch(`${s.base}/dashboard/traces/CA404`)).status).toBe(404);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is not handled when disabled', async () => {
    const server = createServer((req, res) => {
      const handled = handleDashboardRequest(req, res, { bus: new DashboardBus(), traceDir: tmpdir(), enabled: false });
      res.writeHead(handled ? 200 : 404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    expect((await fetch(`http://127.0.0.1:${port}/dashboard`)).status).toBe(404);
    server.close();
  });
});
```

And in `src/server/server.test.ts`, after the worked-example test:

```ts
  it('streams the worked example to the dashboard while it runs', async () => {
    const { relay, base, callSid } = await connected();
    const res = await fetch(`${base}/dashboard/events`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    relay.prompt('Jason Stiles');
    await relay.waitForTexts(2);
    // Read until a `turn` for turn 1 has arrived.
    while (!/"turnIndex":1/.test(buf)) buf += dec.decode((await reader.read()).value);
    const types = buf.split('\n\n').filter((b) => b.includes('data: ')).map((b) => JSON.parse(b.split('data: ')[1]!).type);
    expect(types).toEqual(['call_started', 'turn', 'asked', 'turn']);
    expect(buf).toContain('"spoken":"What\'s your first and last name?"');
    await reader.cancel();
    relay.close();
    expect(callSid).toBe('CA1');
  });
```

(The greeting turn asks no questions, so no `asked` precedes its `turn`.)

- [x] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/server/dashboard/routes.test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Implement**

```ts
// src/server/dashboard/routes.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardBus } from './bus';
import { readFrameLog } from '../frameLog';

export interface DashboardDeps { bus: DashboardBus; traceDir: string; enabled: boolean }

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HEARTBEAT_MS = 15_000;
const SID = /^[A-Za-z0-9_-]{1,64}$/;

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** Returns true when the request was a dashboard route (handled), false to let the caller continue. */
export function handleDashboardRequest(req: IncomingMessage, res: ServerResponse, deps: DashboardDeps): boolean {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (!path.startsWith('/dashboard')) return false;
  if (!deps.enabled) return false;
  if (req.method !== 'GET') { send(res, 405, 'text/plain', 'method not allowed'); return true; }

  if (path === '/dashboard' || path === '/dashboard/') {
    send(res, 200, 'text/html; charset=utf-8', readFileSync(join(HERE, 'page.html')));
    return true;
  }
  if (path === '/dashboard/view.js') {
    send(res, 200, 'text/javascript; charset=utf-8', readFileSync(join(HERE, 'view.js')));
    return true;
  }
  if (path === '/dashboard/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const off = deps.bus.subscribe((event) => {
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const beat = setInterval(() => res.write(': hb\n\n'), HEARTBEAT_MS);
    beat.unref?.();
    req.on('close', () => { off(); clearInterval(beat); });
    return true;
  }
  if (path === '/dashboard/traces') {
    const rows = readdirSync(deps.traceDir)
      .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.frames.jsonl'))
      .map((f) => {
        const full = join(deps.traceDir, f);
        const text = readFileSync(full, 'utf8');
        const lines = text.split('\n').filter(Boolean);
        let startedAt: string | null = null;
        try { startedAt = (JSON.parse(lines[0] ?? '{}') as { ts?: string }).ts ?? null; } catch { startedAt = null; }
        return { callSid: f.slice(0, -'.jsonl'.length), startedAt, turns: lines.length, sizeBytes: statSync(full).size };
      })
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .slice(0, 50);
    send(res, 200, 'application/json', JSON.stringify(rows));
    return true;
  }
  const m = /^\/dashboard\/traces\/([^/]+)$/.exec(path);
  if (m) {
    const sid = decodeURIComponent(m[1]!);
    const file = join(deps.traceDir, `${sid}.jsonl`);
    if (!SID.test(sid) || !existsSync(file)) { send(res, 404, 'text/plain', 'not found'); return true; }
    const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);
    const framesPath = join(deps.traceDir, `${sid}.frames.jsonl`);
    const frames = existsSync(framesPath) ? readFrameLog(framesPath) : [];
    send(res, 200, 'application/json', JSON.stringify({ records, frames }));
    return true;
  }
  send(res, 404, 'text/plain', 'not found');
  return true;
}
```

`src/server/http.ts`: add `bus?: DashboardBus` and `traceDir` (already in config) to `HttpDeps`; at the top of the request handler, before the `/audio/` branch:

```ts
      if (deps.bus && handleDashboardRequest(req, res, { bus: deps.bus, traceDir: deps.config.traceDir, enabled: deps.config.dashboard })) return;
```

`src/server/index.ts`: `const deps = { config, store, tokens, hints: buildHints(), log, bus };` and log `dashboard: /dashboard` or `dashboard: off` at startup.

- [x] **Step 4: Run the tests, suite, typecheck**

Run: `pnpm vitest run src/server && pnpm test && pnpm typecheck`
Expected: PASS. Note: `tsc` must not choke on importing nothing from `view.js` here (routes read it as a file, not a module).

- [x] **Step 5: Commit**

```bash
git add src/server/dashboard/routes.ts src/server/dashboard/routes.test.ts src/server/dashboard/page.html src/server/dashboard/view.js src/server/http.ts src/server/index.ts src/server/server.test.ts
git commit -m "feat(server): dashboard routes: page, view module, SSE stream, trace listing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The view module (pure, tested)

**Files:**
- Replace: `src/server/dashboard/view.js`
- Create: `src/server/dashboard/view.d.ts` (types for the TS tests), `src/server/dashboard/view.test.ts`
- Modify: `tsconfig.json` only if `tsc` refuses the `.js` import even with the `.d.ts` beside it (then add `"allowJs": true`), and the lint/format config if the repo has one (check `package.json` scripts; there is no eslint or prettier config today, so nothing to add)

- [x] **Step 1: Write the failing tests.** Fixture events come from a real run: the test runs the harness's fixture stub through `runTurn` over a scripted call and collects the observer's events, so the view is tested against real records.

```ts
// src/server/dashboard/view.test.ts
import { describe, expect, it } from 'vitest';
import { runTurn, type RunOptions } from '../../run/turn';
import { newSession, type Session } from '../../core/session';
import { promptFrame, dtmfFrames, silenceFrame } from '../../channel/frames';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { FixtureStubClient } from '../../jev/fixtureStub';
import { DEFAULT_CORPUS_FILE } from '../../jev/corpus';
import { spokenText } from '../../prompts/render';
import { reduce, replayEvents, decisiveRows, groupRows } from './view.js';
import type { DashboardEvent } from './events';

const TODAY = '2026-09-18';
const fixture = new FixtureStubClient(DEFAULT_CORPUS_FILE);

/** Runs a scripted call through the observer and returns the live-shaped event list plus the records. */
async function scripted(steps: Array<string | { dtmf: string } | { silence: true }>) {
  const events: DashboardEvent[] = [];
  const records: unknown[] = [];
  let session: Session = newSession('CA1', 0);
  let t = 1_000;
  const opts: RunOptions = {
    client: fixture, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => t,
    observe: {
      asked: (questions, turnState, at) => events.push({ type: 'asked', callSid: 'CA1', at, turnIndex: session.turnIndex, questions, turnState }),
      turn: (record, at) => { records.push(record); events.push({ type: 'turn', callSid: 'CA1', at, record, spoken: spokenText(record.decision) }); },
    },
  };
  events.push({ type: 'call_started', callSid: 'CA1', at: t, from: '…2926', todayIso: TODAY, thresholds: DEFAULT_THRESHOLDS });
  const setup = { type: 'setup', callSid: 'CA1', sessionId: 'VX', from: '+18595222926', to: '+15550000000' } as never;
  session = (await runTurn(session, setup, opts)).result.session;
  for (const step of steps) {
    t += 5_000;
    if (typeof step === 'string') session = (await runTurn(session, promptFrame(step), opts)).result.session;
    else if ('dtmf' in step) { for (const f of dtmfFrames(step.dtmf)) { events.push({ type: 'dtmf', callSid: 'CA1', at: t, digit: f.digit }); session = (await runTurn(session, f, opts)).result.session; } }
    else { events.push({ type: 'silence', callSid: 'CA1', at: t, promptId: session.lastPromptId }); session = (await runTurn(session, silenceFrame(), opts)).result.session; }
  }
  return { events, records };
}

describe('reduce', () => {
  it('shows the conversation, fills three slots from the opener, narrows, and reaches the summary', async () => {
    const { events } = await scripted([
      "I need to reschedule my appointment, it's with Dr. Chen sometime next week",
      'Jason Stiles', 'March fifth nineteen eighty', 'Tuesday',
    ]);
    const v = reduce(events);
    expect(v.status).toBe('live · …2926');
    expect(v.lines.map((l) => l.kind)).toEqual(['system', 'caller', 'system', 'caller', 'system', 'caller', 'system', 'caller', 'system']);
    expect(v.lines[0]!.text).toBe('Thanks for calling Stiles Family Medical Practice. How can I help you today?');
    expect(v.lines.at(-1)!.text).toMatch(/^Your appointment with Dr. Chen would move to Tuesday, September 22, for Jason Stiles, born March 5th, 1980/);
    expect(v.form).toBe('reschedule');
    expect(v.chips.map((c) => [c.id, c.state])).toEqual([['name', 'filled'], ['dob', 'filled'], ['provider', 'filled'], ['date', 'filled']]);
    expect(v.pending).toBe('confirm · form · attempt 0');
    expect(v.turnCount).toBe(5);
    expect(v.totals.askMs).toBeGreaterThanOrEqual(0);
  });

  it('marks a partial chip after "next week" and flashes chips that changed on the last turn', async () => {
    const { events } = await scripted(["I need to reschedule my appointment, it's with Dr. Chen sometime next week", 'Jason Stiles']);
    const v = reduce(events);
    const date = v.chips.find((c) => c.id === 'date')!;
    expect(date.state).toBe('partial');
    expect(date.label).toMatch(/next week/);
    expect(v.chips.find((c) => c.id === 'name')!.changed).toBe(true);
    expect(v.chips.find((c) => c.id === 'provider')!.changed).toBe(false);
  });

  it('shows a correction refilling two slots and a queued task', async () => {
    const { events } = await scripted([
      "I need to reschedule my appointment with Dr. Alvarez for next Thursday, and also I have a question about my bill",
      'Jason Stiles', 'March fifth nineteen eighty', 'no, Thursday with Dr. Chen',
    ]);
    const v = reduce(events);
    expect(v.queued).toEqual(['billing']);
    const changed = v.chips.filter((c) => c.changed).map((c) => c.id).sort();
    expect(changed).toEqual(['date', 'provider']);
  });

  it('renders silence and keypad markers between turns', async () => {
    const { events } = await scripted(['I need to reschedule my appointment with Dr. Chen', { silence: true }, { silence: true }, { silence: true }]);
    const v = reduce(events);
    expect(v.lines.filter((l) => l.kind === 'marker').map((l) => l.text)).toEqual(['silence', 'silence', 'silence']);
  });

  it('groups the Jev rows in consultation order and marks decisive rows', async () => {
    const { events } = await scripted(["I need to reschedule my appointment, it's with Dr. Chen sometime next week", 'Jason Stiles', 'March fifth nineteen eighty']);
    const v = reduce(events);
    expect(v.jev.groups.map((g) => g.name)).toEqual(['gates', 'intent', 'slot · name', 'slot · dob', 'slot · provider', 'slot · date']);
    const dob = v.jev.groups.find((g) => g.name === 'slot · dob')!;
    expect(dob.rows.filter((r) => r.decisive).map((r) => r.id)).toEqual(['dobGiven', 'dobMonth', 'dobDay', 'dobYear']);
    expect(dob.rows.find((r) => r.id === 'dobMonth')!.top!.slice(0, 1)).toEqual([{ label: 'march', p: expect.any(Number) }]);
    expect(v.jev.decision).toMatch(/dob filled 1980-03-05/);
    expect(v.jev.decision).toMatch(/next: date_narrow_window/);
    expect(v.jev.header).toMatch(/^Jev · turn 3 · \d+ questions · \d+ ms · [\d,]+ tokens · \$[\d.]+$/);
  });

  it('shows the asked state with empty bars until the turn arrives', async () => {
    const { events } = await scripted(['Jason Stiles']);
    const upToAsked = events.slice(0, events.findIndex((e) => e.type === 'asked') + 1);
    const v = reduce(upToAsked);
    expect(v.jev.pending).toBe(true);
    expect(v.jev.groups.flatMap((g) => g.rows).every((r) => r.p === null)).toBe(true);
  });
});

describe('replayEvents', () => {
  it('rebuilds the live event sequence from the records and frame log', async () => {
    const { events, records } = await scripted(["I need to reschedule my appointment, it's with Dr. Chen sometime next week", { silence: true }, 'Jason Stiles']);
    const frames = events
      .filter((e) => e.type === 'silence' || e.type === 'dtmf')
      .map((e) => ({ ts: new Date(e.at).toISOString(), dir: 'in', msg: e.type === 'silence' ? { type: 'silence' } : { type: 'dtmf', digit: (e as { digit: string }).digit }, line: 1 }));
    const rebuilt = replayEvents(records as never, frames as never, { from: '…2926', thresholds: DEFAULT_THRESHOLDS });
    expect(rebuilt.map((e) => e.type)).toEqual(events.map((e) => e.type));
    expect(reduce(rebuilt).lines.map((l) => l.text)).toEqual(reduce(events).lines.map((l) => l.text));
    expect(reduce(rebuilt).chips).toEqual(reduce(events).chips);
  });
});

describe('row helpers', () => {
  it('a noul row is decisive when it crosses its threshold; a choice when its winner is not none', () => {
    const rows = decisiveRows({ addressedToSystem: { type: 'noul', noul: 0.97 }, wantsHuman: { type: 'noul', noul: 0.02 }, intent: { type: 'choice', choice: 'none', probabilities: { none: 0.9, cancel: 0.1 } } } as never, { GATE_ADDRESSED: 0.7, GATE_WANTS_HUMAN: 0.7 } as never, []);
    expect(rows.find((r) => r.id === 'addressedToSystem')!.decisive).toBe(true);
    expect(rows.find((r) => r.id === 'wantsHuman')!.decisive).toBe(false);
    expect(rows.find((r) => r.id === 'intent')!.decisive).toBe(false);
  });
  it('groups by role using the question id and the form slots', () => {
    const g = groupRows([{ id: 'addressedToSystem' }, { id: 'intent' }, { id: 'nameGiven' }, { id: 'dateMode' }] as never, ['name', 'dob', 'provider', 'date'], null);
    expect(g.map((x) => x.name)).toEqual(['gates', 'intent', 'slot · name', 'slot · dob', 'slot · provider', 'slot · date']);
  });
});
```

Check the exact names of `dtmfFrames`, `silenceFrame`, `FixtureStubClient`, `DEFAULT_CORPUS_FILE`, and whether the setup frame needs a helper; adjust. The expected group list assumes the current forms (name, dob, provider, date); read `src/domain/forms.ts`.

- [x] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/server/dashboard/view.test.ts`
Expected: FAIL (placeholder module).

- [x] **Step 3: Implement `view.js`**

```js
// src/server/dashboard/view.js
// Pure functions from dashboard events to a view model. Plain JavaScript on purpose: the browser
// loads this file as a module with no build step, and vitest imports the same file. Types are in
// view.d.ts.

/** @typedef {import('./events').DashboardEvent} DashboardEvent */

const GATE_THRESHOLD = {
  addressedToSystem: 'GATE_ADDRESSED', intelligible: 'GATE_INTELLIGIBLE', wantsHuman: 'GATE_WANTS_HUMAN',
  frustrated: 'GATE_FRUSTRATION_HIGH', complete: 'GATE_COMPLETE',
};
const GATE_IDS = new Set(Object.keys(GATE_THRESHOLD).concat(['tentative', 'hedged', 'confirmsYes', 'confirmsNo']));
const CONFIRM_IDS = new Set(['confirmsYes', 'confirmsNo', 'changeSlot']);
const SLOT_PREFIX = { name: ['name'], dob: ['dob'], memberId: ['memberId', 'containsMemberId'], provider: ['provider'], date: ['date'] };

export function thresholdFor(id, thresholds) {
  if (id in GATE_THRESHOLD) return thresholds[GATE_THRESHOLD[id]] ?? null;
  if (/Given$/.test(id) || id === 'containsMemberId') return thresholds.SLOT_DETECT ?? null;
  if (id === 'intent') return thresholds.INTENT_ROUTE ?? null;
  return thresholds.SLOT_CHOICE_CONFIRM ?? null;
}

function slotOf(id) {
  for (const [slot, prefixes] of Object.entries(SLOT_PREFIX)) {
    if (prefixes.some((p) => id === p || id.startsWith(p))) return slot;
  }
  return null;
}

/** One row per question, with the answer folded in when present. */
export function decisiveRows(answers, thresholds, gateRows, questions) {
  const ids = questions ? Object.keys(questions) : Object.keys(answers ?? {});
  const named = new Set((gateRows ?? []).filter((g) => g.decided).map((g) => g.gate));
  return ids.map((id) => {
    const a = answers ? answers[id] : null;
    const threshold = thresholdFor(id, thresholds ?? {});
    if (!a) return { id, kind: 'pending', p: null, value: null, threshold, decisive: false, top: null };
    if (a.type === 'noul') {
      const p = a.noul;
      return { id, kind: 'noul', p, value: p.toFixed(2), threshold, decisive: named.has(id) || (threshold !== null && p >= threshold), top: null };
    }
    if (a.type === 'choice') {
      const entries = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]);
      const p = a.probabilities?.[a.choice] ?? null;
      const decisive = named.has(id) || (a.choice !== 'none' && threshold !== null && p !== null && p >= threshold);
      return { id, kind: 'choice', p, value: a.choice, threshold, decisive, top: entries.slice(0, 4).map(([label, pr]) => ({ label, p: pr })) };
    }
    return { id, kind: a.type, p: typeof a.score === 'number' ? a.score : null, value: String(a.score ?? ''), threshold, decisive: named.has(id), top: null };
  });
}

/** Groups rows: gates, intent, confirmation (when pending), then one group per form slot in form order. */
export function groupRows(rows, formSlots, pending) {
  const groups = [{ name: 'gates', rows: [] }, { name: 'intent', rows: [] }];
  if (pending) groups.push({ name: 'confirmation', rows: [] });
  const slotGroups = new Map(formSlots.map((s) => [s, { name: `slot · ${s}`, rows: [] }]));
  const other = { name: 'other', rows: [] };
  for (const r of rows) {
    if (CONFIRM_IDS.has(r.id) && pending) groups[2].rows.push(r);
    else if (GATE_IDS.has(r.id)) groups[0].rows.push(r);
    else if (r.id === 'intent') groups[1].rows.push(r);
    else { const s = slotOf(r.id); if (s && slotGroups.has(s)) slotGroups.get(s).rows.push(r); else other.rows.push(r); }
  }
  const out = groups.concat([...slotGroups.values()]);
  if (other.rows.length) out.push(other);
  return out.map((g) => ({ ...g, decisive: g.rows.some((r) => r.decisive), quiet: g.rows.filter((r) => !r.decisive).length }));
}

const ALL_SLOTS = ['name', 'dob', 'memberId', 'provider', 'date'];
const FORM_SLOTS = {
  schedule_new: ['name', 'dob', 'provider', 'date'], reschedule: ['name', 'dob', 'provider', 'date'],
  cancel: ['name', 'dob', 'provider'], confirm_appointment: ['name', 'dob', 'provider'], billing: ['memberId'],
};

function partialLabel(w) {
  if (!w) return '';
  if (w.kind === 'dob') return `${w.month}/${w.day}`;
  return w.label ?? `${w.start}…${w.end}`;
}

function chipsOf(slots, prevSlots, form) {
  const order = form && FORM_SLOTS[form] ? FORM_SLOTS[form] : ALL_SLOTS;
  return order.map((id) => {
    const s = slots?.[id] ?? { value: null, display: null, window: null, attempts: 0 };
    const prev = prevSlots?.[id];
    const state = s.value ? 'filled' : s.window ? 'partial' : 'empty';
    const label = s.value ? (s.display ?? s.value) : s.window ? partialLabel(s.window) : '';
    const changed = !!prev && (prev.value !== s.value || JSON.stringify(prev.window) !== JSON.stringify(s.window));
    return { id, state, label, changed, attempts: s.attempts ?? 0 };
  });
}

function decisionLine(record) {
  const d = record.decision;
  const parts = [];
  const decided = (record.gates ?? []).find((g) => g.decided);
  if (decided) parts.push(`${decided.gate}: ${decided.outcome}`);
  for (const [id, s] of Object.entries(record.slots ?? {})) {
    // Filled or narrowed this turn: compared by the caller of reduce, so here we only name what is set.
    if (s.value) parts.push(`${id} ${s.value}`);
  }
  if (d.kind === 'prompt') parts.push(`next: ${d.promptId}`);
  else if (d.kind === 'complete') parts.push(`complete: ${d.promptId}`);
  else if (d.kind === 'handoff') parts.push(`handoff: ${d.reason}`);
  else parts.push(d.kind);
  return parts.join(' · ');
}

function money(usd) { return `$${usd.toFixed(4)}`; }

/** Folds an event list into the view the page renders. */
export function reduce(events) {
  const v = {
    status: 'waiting for a call', callSid: null, turnCount: 0,
    totals: { askMs: 0, tokens: 0, usd: 0 },
    lines: [], form: null, chips: chipsOf(null, null, null), pending: null, queued: [], asking: null,
    jev: { header: 'Jev', pending: false, groups: [], decision: '' },
    thresholds: {},
  };
  let prevSlots = null;
  let lastRecord = null;
  for (const e of events) {
    switch (e.type) {
      case 'call_started':
        v.status = `live · ${e.from}`; v.callSid = e.callSid; v.thresholds = e.thresholds ?? {};
        break;
      case 'asked': {
        const formSlots = e.turnState.activeForm && FORM_SLOTS[e.turnState.activeForm] ? FORM_SLOTS[e.turnState.activeForm] : ALL_SLOTS;
        const rows = decisiveRows(null, v.thresholds, [], e.questions);
        v.jev = { header: `Jev · turn ${e.turnIndex + 1} · ${Object.keys(e.questions).length} questions · asking…`, pending: true, groups: groupRows(rows, formSlots, e.turnState.pendingConfirmation), decision: '' };
        break;
      }
      case 'turn': {
        const r = e.record;
        v.turnCount = r.turnIndex + 1;
        const ev = r.event;
        if (ev && ev.type === 'prompt') v.lines.push({ kind: 'caller', text: ev.voicePrompt, turn: r.turnIndex });
        if (ev && ev.type === 'error') v.lines.push({ kind: 'marker', text: `relay error`, turn: r.turnIndex });
        if (e.spoken) v.lines.push({ kind: 'system', text: e.spoken, promptId: r.decision.promptId ?? r.decision.kind, turn: r.turnIndex });
        v.form = r.form;
        v.chips = chipsOf(r.slots, prevSlots, r.form);
        prevSlots = r.slots;
        v.pending = r.pendingConfirmation ? `confirm · ${r.pendingConfirmation.target} · attempt ${r.pendingConfirmation.attempts ?? 0}` : null;
        v.queued = r.queued ?? [];
        const asked = r.promptedFor;
        v.asking = asked && asked !== 'intent' && asked !== 'confirm' && r.slots?.[asked] ? `asking ${asked} · attempt ${r.slots[asked].attempts + 1} of 3` : null;
        v.totals.askMs += r.timing?.askMs ?? 0; v.totals.tokens += r.usage?.inputTokens ?? 0; v.totals.usd += r.usage?.costUsd ?? 0;
        const formSlots = r.form && FORM_SLOTS[r.form] ? FORM_SLOTS[r.form] : ALL_SLOTS;
        if (r.questions) {
          const rows = decisiveRows(r.answers, v.thresholds, r.gates, r.questions);
          v.jev = {
            header: `Jev · turn ${r.turnIndex + 1} · ${Object.keys(r.questions).length} questions · ${Math.round(r.timing?.askMs ?? 0)} ms · ${(r.usage?.inputTokens ?? 0).toLocaleString('en-US')} tokens · ${money(r.usage?.costUsd ?? 0)}`,
            pending: false, groups: groupRows(rows, formSlots, r.pendingConfirmation), decision: decisionLine(r),
          };
        } else {
          v.jev = { header: `Jev · turn ${r.turnIndex + 1} · no questions`, pending: false, groups: [], decision: decisionLine(r) };
        }
        lastRecord = r;
        break;
      }
      case 'silence': v.lines.push({ kind: 'marker', text: 'silence' }); break;
      case 'dtmf': v.lines.push({ kind: 'marker', text: `keypad ${e.digit}` }); break;
      case 'interrupt': v.lines.push({ kind: 'marker', text: 'interrupted' }); break;
      case 'reconnect': v.lines.push({ kind: 'marker', text: `reconnected (${e.attempt})` }); break;
      case 'handoff': v.lines.push({ kind: 'marker', text: `transfer to ${e.number} (${e.reason})` }); break;
      case 'ended': v.status = `ended · ${e.reason}`; break;
    }
  }
  // Merge consecutive keypad markers into one ("keypad 03051980").
  const merged = [];
  for (const l of v.lines) {
    const last = merged[merged.length - 1];
    if (l.kind === 'marker' && last && last.kind === 'marker' && /^keypad /.test(l.text) && /^keypad /.test(last.text)) last.text += l.text.slice('keypad '.length);
    else merged.push({ ...l });
  }
  v.lines = merged;
  void lastRecord;
  return v;
}

/** Rebuilds the live event sequence from a trace file and its frame log. */
export function replayEvents(records, frames, opts) {
  const events = [];
  if (!records.length) return events;
  const first = records[0];
  const callSid = first.sessionId;
  const at0 = Date.parse(first.ts);
  events.push({ type: 'call_started', callSid, at: at0, from: opts?.from ?? 'replay', todayIso: first.ts.slice(0, 10), thresholds: opts?.thresholds ?? {} });
  const frameEvents = (frames ?? []).flatMap((f) => {
    const at = Date.parse(f.ts);
    const m = f.msg ?? {};
    if (f.dir === 'in' && m.type === 'silence') return [{ type: 'silence', callSid, at, promptId: null }];
    if (f.dir === 'in' && m.type === 'dtmf') return [{ type: 'dtmf', callSid, at, digit: m.digit }];
    if (f.dir === 'in' && m.type === 'interrupt') return [{ type: 'interrupt', callSid, at, utteranceUntilInterrupt: m.utteranceUntilInterrupt ?? null }];
    if (f.dir === 'log' && m.resumed) return [{ type: 'reconnect', callSid, at, attempt: 1 }];
    if (f.dir === 'out' && m.type === 'end') return [{ type: 'ended', callSid, at, reason: m.handoffData && /"reasonCode":"completed"/.test(m.handoffData) ? 'completed' : 'handoff' }];
    return [];
  });
  const turnEvents = records.flatMap((r) => {
    const at = Date.parse(r.ts);
    const out = [];
    if (r.questions) out.push({ type: 'asked', callSid, at: at - Math.max(1, Math.round(r.timing?.askMs ?? 0)), turnIndex: r.turnIndex, questions: r.questions, turnState: r.turnState });
    out.push({ type: 'turn', callSid, at, record: r, spoken: opts?.spoken ? opts.spoken(r) : r.spokenText ?? '' });
    return out;
  });
  // A silence or dtmf frame precedes the turn it caused (same ts, logged first), so a stable sort by time keeps the order.
  const all = frameEvents.concat(turnEvents).sort((a, b) => a.at - b.at || (a.type === 'turn' ? 1 : 0) - (b.type === 'turn' ? 1 : 0));
  return events.concat(all);
}
```

Deviation from the spec worth recording: `replayEvents` needs the spoken text per record. The trace record does not carry it and the browser has no manifest, so the `/dashboard/traces/<sid>` route (Task 4) is amended in this task to add `spokenText: string` to each record it returns (computed server-side with `spokenText(record.decision)`); `replayEvents` reads `r.spokenText`. Update the Task 4 route and its test accordingly in this commit.

Also remove the `decisionLine` slot listing of every filled slot in favour of the slots that changed on this turn: compute inside `reduce` by comparing with `prevSlots` (filled: `id value`; narrowed: `id → partial`) and pass the list into `decisionLine`. The test expects `dob filled 1980-03-05` on the birthday turn and not the name and provider filled on earlier turns.

`view.d.ts`:

```ts
import type { DashboardEvent } from './events';
import type { TraceRecord } from '../../trace/types';
import type { FrameLogLine } from '../frameLog';
import type { Thresholds } from '../../core/thresholds';

export interface Row { id: string; kind: string; p: number | null; value: string | null; threshold: number | null; decisive: boolean; top: Array<{ label: string; p: number }> | null }
export interface Group { name: string; rows: Row[]; decisive: boolean; quiet: number }
export interface Chip { id: string; state: 'empty' | 'partial' | 'filled'; label: string; changed: boolean; attempts: number }
export interface Line { kind: 'system' | 'caller' | 'marker'; text: string; promptId?: string; turn?: number }
export interface View {
  status: string; callSid: string | null; turnCount: number;
  totals: { askMs: number; tokens: number; usd: number };
  lines: Line[]; form: string | null; chips: Chip[]; pending: string | null; queued: string[]; asking: string | null;
  jev: { header: string; pending: boolean; groups: Group[]; decision: string };
  thresholds: Partial<Thresholds>;
}
export function reduce(events: DashboardEvent[]): View;
export function replayEvents(records: Array<TraceRecord & { spokenText?: string }>, frames: FrameLogLine[], opts?: { from?: string; thresholds?: Partial<Thresholds> }): DashboardEvent[];
export function decisiveRows(answers: unknown, thresholds: Partial<Thresholds>, gateRows: unknown[], questions?: unknown): Row[];
export function groupRows(rows: Row[], formSlots: string[], pending: unknown): Group[];
export function thresholdFor(id: string, thresholds: Partial<Thresholds>): number | null;
```

- [x] **Step 4: Run the tests, suite, typecheck**

Run: `pnpm vitest run src/server/dashboard && pnpm test && pnpm typecheck`
Expected: PASS. If `tsc` reports it cannot find the module `./view.js`, add `"allowJs": true` to `tsconfig.json` compilerOptions (and confirm `include` still covers `src`); if that pulls the `.js` into the program with errors, keep `allowJs` off and make sure `view.d.ts` sits beside `view.js` with the same base name, which TypeScript resolves for a `.js` import.

- [x] **Step 5: Commit**

```bash
git add src/server/dashboard/view.js src/server/dashboard/view.d.ts src/server/dashboard/view.test.ts src/server/dashboard/routes.ts src/server/dashboard/routes.test.ts tsconfig.json
git commit -m "feat(dashboard): the view module: events to view model, replay from a trace

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Drop `tsconfig.json` from the add if it was not changed.)

---

### Task 6: The page

**Files:**
- Replace: `src/server/dashboard/page.html`
- Test: none automated beyond the routes test serving it; checked by hand against a replay and a live call (Task 8)

- [x] **Step 1: Write the page.** One file. Requirements it must meet, all from the spec §3 and §4:

- Dark theme, `1920×1080` layout: a 56 px header strip, then a two-column grid (`1fr 1fr`, 24 px gap, 24 px padding). Base font 18 px system sans; monospace for ids and numbers. Colors as CSS variables: background `#0f1115`, panel `#171a21`, border `#2a2f3a`, text `#d7dae0`, muted `#8b93a7`, system line `#9fc5ff`, caller line `#ffd58a`, filled `#3ccf7a`, partial `#ffb454`, bar `#4f8cff`, quiet `#5a6172`, threshold tick `#ffd58a`.
- Header: status (left), `turn N` and running totals (`Jev 620 ms · 12,400 tokens · $0.0006`) (center), mode toggle Live / Replay and, in replay, the trace picker (`<select>` filled from `/dashboard/traces`), buttons Reset · Step back · Step · Play/Pause, speed `<select>` 1x/2x/4x, and a numeric input for the `asked` beat (default 800 ms), plus a small note `thresholds: today's defaults` (right).
- Left column: a `.conversation` panel (flex 1, scrolls, auto-scrolls to the bottom on update; the newest system+caller pair has a left border highlight; markers render as small muted italic lines) and a `.state` panel (form title; chips as pills with the state color and the label; `.changed` chips run a 900 ms CSS keyframe that brightens then settles; the three optional lines `pending`, `queued · billing`, `asking …`).
- Right column: the Jev panel: header line; for each group, a heading (`gates`, `intent`, `confirmation`, `slot · dob`), rows for decisive ones and, when the group is quiet, a collapsed line `slot · date (3 quiet)` that toggles open on click (state kept in a `Set` of open group names across renders); a row is `id | bar | value`, the bar 10 px tall with the threshold tick as a 2 px absolutely positioned line at `threshold*100%`; decisive choice rows add a line of up to four `label p` pills with the winner highlighted; pending rows (no answer yet) draw an empty bar with a faint pulse animation; the bottom line shows `decision`.
- Live mode: `new EventSource('/dashboard/events')`; append each parsed event to `events`, call `render(reduce(events))`. On a `call_started` clear the array first (the bus already sends history, so a page opened mid-call gets it).
- Replay mode: fetch `/dashboard/traces`, on pick fetch `/dashboard/traces/<sid>`, build `all = replayEvents(records, frames, { from: 'replay', thresholds: null })` and set `cursor = 0`. `render(reduce(all.slice(0, cursor)))`. Step: `cursor += 1`; if the event at the new cursor-1 is `asked`, that is the beat: when playing, schedule the next step after `beatMs` instead of the recorded gap. Play: a timer chain using `min(5000, (all[cursor].at - all[cursor-1].at)) / speed` between events (`beatMs` after an `asked`). Keys: Space toggles play, ArrowRight steps, ArrowLeft steps back, Home resets. Thresholds for replay: the page requests `/dashboard/thresholds`? No: the spec says today's defaults; the page gets them from the live `call_started` if one was ever seen, otherwise from a constant block in the page that mirrors `DEFAULT_THRESHOLDS` for the ids the rows use (`GATE_ADDRESSED 0.7`, `GATE_INTELLIGIBLE 0.45`, `GATE_WANTS_HUMAN 0.7`, `GATE_FRUSTRATION_HIGH 0.6`, `GATE_COMPLETE 0.6`, `SLOT_DETECT 0.6`, `SLOT_CHOICE_CONFIRM 0.45`, `INTENT_ROUTE`: read the value from `src/core/thresholds.ts`). Keep that block next to a comment naming the source file.
- No external requests, no framework. All rendering is `innerHTML` from template strings built from the view model; escape text with a small `esc()`.
- The page must not throw on a `turn` for a call that has no `asked` (the greeting), on records missing the optional fields (old traces), or on an empty trace list.

Write it in full; a starting skeleton follows, to be completed rather than copied as-is:

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Jev IVR · live</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --border:#2a2f3a; --text:#d7dae0; --muted:#8b93a7; --sys:#9fc5ff; --usr:#ffd58a; --filled:#3ccf7a; --partial:#ffb454; --bar:#4f8cff; --quiet:#5a6172; --tick:#ffd58a; }
  html,body { margin:0; background:var(--bg); color:var(--text); font:18px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; height:100%; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { height:56px; display:flex; align-items:center; gap:24px; padding:0 24px; border-bottom:1px solid var(--border); }
  main { display:grid; grid-template-columns:1fr 1fr; gap:24px; padding:24px; height:calc(100vh - 56px); box-sizing:border-box; }
  .col { display:flex; flex-direction:column; gap:24px; min-height:0; }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px; overflow:auto; min-height:0; }
  .conversation { flex:1; } .state { flex:0 0 auto; }
  .line { padding:4px 0 4px 12px; border-left:3px solid transparent; } .line.now { border-left-color:var(--bar); }
  .sys { color:var(--sys); } .usr { color:var(--usr); } .marker { color:var(--muted); font-style:italic; font-size:15px; }
  .pid { color:var(--muted); font-size:13px; margin-left:8px; }
  .chip { display:inline-block; padding:4px 12px; border-radius:16px; border:1px solid var(--border); margin:4px 6px 4px 0; }
  .chip.filled { border-color:var(--filled); color:#c9f2d6; } .chip.partial { border-color:var(--partial); color:#f2e6c9; } .chip.empty { color:var(--muted); }
  .chip.changed { animation: flash .9s ease-out; } @keyframes flash { 0% { background:#2f7a4f; } 100% { background:transparent; } }
  .grp { color:var(--muted); font-size:13px; letter-spacing:.08em; text-transform:uppercase; margin:12px 0 4px; border-bottom:1px solid var(--border); cursor:pointer; }
  .row { display:grid; grid-template-columns: 220px 1fr 140px; gap:12px; align-items:center; padding:2px 0; }
  .bar { position:relative; height:10px; background:#262b36; border-radius:5px; overflow:hidden; }
  .bar i { position:absolute; left:0; top:0; bottom:0; background:var(--bar); } .bar i.hi { background:var(--filled); } .bar i.lo { background:var(--quiet); }
  .bar em { position:absolute; top:-2px; bottom:-2px; width:2px; background:var(--tick); }
  .bar.pending i { width:100%; opacity:.15; animation: pulse 1s infinite alternate; } @keyframes pulse { to { opacity:.35; } }
  .top { grid-column: 2 / 4; display:flex; gap:6px; flex-wrap:wrap; } .top span { padding:1px 8px; border-radius:4px; background:#262b36; font-size:14px; } .top span.win { background:#1f4d33; color:#c9f2d6; }
  .decision { margin-top:12px; color:var(--usr); }
  .controls { margin-left:auto; display:flex; gap:8px; align-items:center; } button, select, input { font:inherit; background:#262b36; color:var(--text); border:1px solid var(--border); border-radius:6px; padding:4px 10px; }
</style></head>
<body>
<header>
  <div id="status">waiting for a call</div>
  <div id="totals" class="mono"></div>
  <div class="controls">
    <button id="mode-live">Live</button><button id="mode-replay">Replay</button>
    <select id="trace" hidden></select>
    <button id="reset" hidden>Reset</button><button id="back" hidden>◀</button><button id="step" hidden>▶ step</button><button id="play" hidden>Play</button>
    <select id="speed" hidden><option>1</option><option>2</option><option>4</option></select>
    <label id="beatwrap" hidden>beat <input id="beat" type="number" value="800" min="0" step="100" style="width:80px"> ms</label>
    <span id="note" class="mono" style="color:var(--muted);font-size:13px"></span>
  </div>
</header>
<main>
  <div class="col"><div class="panel conversation" id="conversation"></div><div class="panel state" id="state"></div></div>
  <div class="col"><div class="panel" id="jev" style="flex:1"></div></div>
</main>
<script type="module">
  import { reduce, replayEvents } from './dashboard/view.js';
  // ... state, render(view), live (EventSource), replay (fetch, cursor, timers, keys) as specified above ...
</script>
</body></html>
```

Note the module path: the page is served at `/dashboard` so a relative `./dashboard/view.js` resolves to `/dashboard/view.js`; if the page is opened at `/dashboard/` (trailing slash) the relative path would differ, so use the absolute `/dashboard/view.js`.

- [x] **Step 2: Check it by hand in replay.** Start the server against a fixture trace: `TRACE_DIR=$(pwd)/fixtures/dashboard-sample NO_INPUT_MS=0 pnpm serve` is not needed; instead write a small script step: run `pnpm cli --scenarios fixtures/scenarios --trace /tmp/dash/replay.jsonl` is also not the right shape (one file for many scenarios). Simplest: `pnpm cli --trace /tmp/dash/CAdemo.jsonl` and type the worked example, `/silence` once, then `dtmf:03051980` at a birthday prompt; that writes a trace with one session. Copy it to a temp `TRACE_DIR`, start `pnpm serve` with that `TRACE_DIR` and `PUBLIC_HOST=localhost`, open `http://localhost:3000/dashboard`, switch to Replay, pick the trace, step through with the arrow keys. There is no frame log for a CLI trace, so between-turn markers will be absent there; that is expected. Fix anything that throws or renders wrongly; the console must be clean.

- [x] **Step 3: `pnpm test && pnpm typecheck`** (the routes test serves the real page now).

- [x] **Step 4: Commit**

```bash
git add src/server/dashboard/page.html
git commit -m "feat(dashboard): the page: live stream, replay with step and play, two-column layout

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: README and the deviation record

- [x] README: under "Phone line (Twilio ConversationRelay)" add a `### Dashboard` subsection: the URL (`https://PUBLIC_HOST/dashboard`, or `http://localhost:3000/dashboard` on the machine running the server), what the two columns show in two sentences, Live vs Replay, the keys (Space, arrows, Home), the speed and beat controls, `DASHBOARD=off`, and that the page shows only what the trace stores with the caller number masked. Add `DASHBOARD` to the config list. Mention the two new optional trace fields in the trace paragraph. In "Layout", add `src/server/dashboard` with one line.
- [x] Append `## Deviations recorded during execution` to this plan with what changed per task (at minimum: the `spokenText` field on the trace route, the decision-line rule, any `tsconfig` change, and anything a review asked for).
- [x] Commit: `docs: the live call dashboard; record plan deviations`.

---

### Task 8 (Jason, not an agent)

1. `pnpm serve` with ngrok up; open `https://PUBLIC_HOST/dashboard` full screen at 1920×1080. Dial. Check: the greeting appears as the first system line, the opener fills chips, "next week" shows a partial chip, the birthday turn shows the dob group decisive, the summary shows the confirmation group, "no, Thursday" flashes the date chip, "and also my bill" shows the queue line, the end shows `ended · completed`.
2. Switch to Replay and pick that call. Step through with the arrow keys; play at 1x; confirm the silence, keypad and interrupt markers of any earlier call show up where they happened.
3. If the `asked` beat feels too fast or slow for narration, change the beat box; if the threshold ticks look wrong on an old trace, that is the recorded-under-other-thresholds caveat.
4. Record.

---

## Self-review

- Spec coverage: §2.1 (Task 1), §2.2 (Tasks 2 and 3), §2.3 (Task 4), §2.4 and §3 (Tasks 5 and 6), §4 (Task 6), §5 (each task's tests; the replay-equals-live test in Task 5), §6 (Task 8), §7 (Task 7).
- Names used across tasks: `TurnObserver`, `RunOptions.observe`, `DashboardBus`, `DashboardEvent`, `maskNumber`, `handleDashboardRequest`, `DashboardDeps`, `reduce`, `replayEvents`, `decisiveRows`, `groupRows`, `thresholdFor`, `spokenText`, config `dashboard`, env `DASHBOARD`, routes `/dashboard`, `/dashboard/view.js`, `/dashboard/events`, `/dashboard/traces`, `/dashboard/traces/<sid>`, trace fields `queued`, `pendingConfirmation`, `promptedFor`, route field `spokenText`.
- Known judgment calls left to the implementer, each to be recorded as a deviation if taken differently: the `turnIndex` on `asked` (Task 3), whether `tsconfig` needs `allowJs` (Task 5), and the exact `decisionLine` wording (Task 5 test pins `dob filled 1980-03-05` and `next: date_narrow_window`).

---

## Deviations recorded during execution

Tasks 1–7 are done on branch `dashboard`; Task 8 is Jason's. Each heading names
the commit the work landed in. The plan text above is left as written, so this
section is the record of where the implementation went elsewhere and why.

### Before the first task

- The trace record gained a third optional field beyond the spec's two:
  `queued`, `pendingConfirmation` **and** `promptedFor`. The spec listed none of
  them; replay needs all three, because the queue line, the pending line and the
  "asking …" line cannot be recovered from the decision alone.
- `/dashboard/traces/<sid>` returns each record with an added `spokenText`. The
  browser has no prompt manifest, so the prompt text has to be rendered on the
  server; live events already carry it as `spoken`, and the view maps the two
  names onto one field.

### Task 1 — observer hook and the trace fields (`755c83c`)

- `FormId` lives in `src/domain/intents`, not `src/domain/forms`; `JevClientError`
  is `(message, cause)`; `FixtureStubClient` takes a loaded corpus
  (`FixtureStubClient(loadCorpus(DEFAULT_CORPUS_FILE), …)`) and `DEFAULT_CORPUS_FILE`
  is exported from `src/run/client`, not `src/jev/corpus`. The `setupFrame` helper
  exists and was used. Tests were appended to the existing `src/run/turn.test.ts`.
- **The first turn's `record.turnIndex` is 1, not 0**: `bookkeep` increments the
  session counter before the record is built. Every later index claim in the plan
  is off by one against this; the setup turn is turn 1 and the first model turn is
  turn 2.
- `tsconfig.json` was not touched, here or later: `include` is `src/**/*.ts` and no
  TypeScript file imports `view.js` as a module, so `allowJs` was never needed.

### Task 2 — events and the bus (`8d146cb`)

Implemented verbatim from the plan; no deviations.

### Task 3 — the adapter publishes, the server wires the bus (`51b425a`)

- `asked.turnIndex` is `store.get(callSid).session.turnIndex + 1`, read through the
  store rather than a closure over the `CallResources` object: `SessionStore.create`
  spreads the object, so a closure would freeze the session at call setup.
  `turnState.history.length` (the plan's fallback) is wrong because it saturates at
  `HISTORY_WINDOW = 3`.
- On a turn that resolves to ignore or hold, `bookkeep` returns early and does not
  increment, so `asked` is one ahead of the `turn` that follows it. **`turnIndex` is
  a label, not a key**: the page pairs an `asked` with the next `turn` by arrival
  order. This is documented on the event variant itself.
- Timestamps are `Date.now()`; `AdapterDeps` has no clock to borrow.
- Found while testing: the `turn` event carried the raw setup frame, i.e. the whole
  caller number. Fixed in `fe3868a`.

### Fix commit `fe3868a` — Task 1 review

- Assertions inside an observer callback were swallowed by `runTurn`'s
  best-effort `try/catch`: the tests now capture in the callback and assert after
  the `await`. A test that a throwing observer does not break the turn was added.
- `writer.ts` aliased `pendingConfirmation`, whose `attempts` is mutated in place
  on later turns, so an old record's pending line would change under it; it is
  copied now.
- `redactRecord` / `redactFrameLine` added to `events.ts`; `turn` events publish
  the redacted record. The trace on disk is unchanged — redaction is on the way
  out to the page, not on the way in to the file.

### Task 4 — routes (`923b107`)

- The end-to-end SSE test waits for `record.turnIndex === 2`, the first model turn.
- Frames are returned as `{ ...redactFrameLine(line), line }`, keeping the frame
  log's line number through the redaction, which widens the type back.
- `decodeURIComponent` is guarded and a bad sid 404s before it can reach `join`.
- `ReplayRecord = TraceRecord & { spokenText: string }` is the route's record type.

### Fix commit `b1f6598` — Tasks 2 and 3 review

- `bus.subscribe`'s history replay was not exception-isolated while the fan-out
  was; both now go through one private `deliver()`.
- **The hangup model in the plan was wrong.** A relay-side reconnect is driven by
  `/cr-action` *after* the relay session ends, so the socket close that the plan
  wanted to read as a hangup happens on a reconnect too. `ended{hangup}` is now
  published from `decideActionTwiml` branch (b) in `http.ts` — the one place that
  can tell a caller hangup from a reconnect — and the adapter's close handler
  publishes nothing. The old `adapter.test.ts` assertion was vacuous (it never
  closed the socket).
- An evicted live call published nothing, and `reason: 'error'` had no producer at
  all. The evictor body is now `sweep()` on `RunningServer`, and it publishes
  `ended{error}` when the bus's live call is evicted before it ended. It has to
  read liveness *before* `evictIdle`, which deletes the entry.
- `makeObserver(bus, store, callSid)` was extracted to
  `src/server/dashboard/observer.ts` and is used by both `index.ts` and the adapter
  tests; the tests' own copy had already drifted (no `redactRecord`, asserting the
  raw number).
- `seq` moved off `Base` onto a `PublishedEvent` the bus owns, so only published
  events carry one.

### Task 5 — the view module (`a7e3e91`)

- **Gate ids come from `ALWAYS_ON_IDS` in `src/core/questions.ts`**, not from the
  plan's hand-written list, which named three ids that do not exist and missed
  nine that do. `thresholdFor` maps the real threshold names and returns `null`
  for informational rows rather than inventing a tick.
- Turn labels are the recorded 1-based index, with no `+ 1` anywhere.
- Dead turns (ignore/hold, no questions) contribute only their marker: `runTurn`
  writes a record for interrupt and error frames too, with a repeated `turnIndex`.
- `ended` is reversible: an `asked`, a `reconnect` or a consulting turn un-ends the
  call, because `/cr-action` publishes `hangup` before a reconnect is known.
- `decisionLine` names only the slots that moved (`dob filled 1980-03-05`,
  `date → next week`, `date cleared`) — the plan's wording, pinned by its test.
- `ALL_SLOTS` / `FORM_SLOTS` are exported and pinned against `src/domain`, so a new
  slot cannot silently fall out of the groups. `MAX_ATTEMPTS` comes from the
  thresholds rather than a constant in the view.
- The fixtures build their events through `makeObserver` and a real bus, so the
  tested sequence is the one the server publishes. The correction script is
  corpus-backed (`rs-02` → name → dob → `sw-07` → Tuesday → `fc-07`).

### Fix commit `c3c8a09` — Task 4 review

- **Redaction was incomplete on `/dashboard/traces/<sid>`, found against real
  traces.** The `/cr-action` frame line is `{ route: '/cr-action', ...params }`
  with no `msg.type`, so `From`/`To`/`Caller`/`Called`, the `*City|State|Zip|Country`
  geo fields and `AccountSid` all passed straight through, and setup lines and
  records kept `forwardedFrom`, `accountSid` and `callerName`. Redaction is now
  `redactDeep` by key name, case-insensitively, to depth 6, over every frame line
  and the record's `event` — deliberately not `turnState`, whose name ends in
  "State" and would be shredded by the geo-suffix rule. After the change, a scan of
  47 frame logs and 49 traces on disk found zero caller numbers and zero account
  ids.
- A corrupt trailing line 500'd a whole trace; parsing is per line and tolerant
  now, and the listing counts corrupt lines. A missing trace directory returns `[]`
  instead of 500ing. `HEAD /dashboard` is allowed rather than 405.
- An open SSE stream held shutdown open forever (`server.close` waits for idle
  connections and a stream is never idle): `closeAllConnections()` runs before
  `close()`. SSE writes are skipped when `res.writableLength` is over 1 MB.
- The listing stats and sorts by mtime before reading the 50 newest, rather than
  reading every file whole.

### Task 6 — the page (`3ccc5f9`)

- 371 lines as committed; checked by hand in a browser on port 3999 against a scripted
  nine-record trace: no console messages, and the lines, chips, groups, correction
  flashes and replay controls all verified.
- Deviations from the plan's requirement list: the replay status string is
  overridden to `replay · <sid>`; empty groups are not rendered at all (so the
  confirmation group appears on the answer turn); bars have three colours
  (decisive green, crossed-tick blue, quiet grey); a `#conn` span shows
  `reconnecting…`; Space matches `e.code` as well as `e.key`; and the beat is
  **not** divided by the speed select — it is a narration setting, not part of the
  recorded pace.
- Not covered by the by-hand check: live mode against real events, the reconnecting
  note on screen, and a saved screenshot (an open SSE stream keeps a headless load
  from finishing).

### Fix commit `536e653` — Task 5 review

- The confirmation group was off by one turn: it is grouped by the ask-time state
  (`r.turnState?.pendingConfirmation ?? r.pendingConfirmation`), while the state
  panel's pending line stays post-turn.
- Score rows take their probability and threshold from the record's matching gate
  row (the level probability), else `null`.
- The intent tick is not `INTENT_ROUTE`, which is never applied at run time: it is
  `INTENT_SWITCH` inside a form and `INTENT_EXPLICIT` outside one, the values the
  gate ladder actually compares against. The test that pinned `INTENT_ROUTE` was
  wrong and was fixed.
- `reduce` rebuilds its accumulator on a second `call_started`, so a second call in
  one page session does not inherit the first one's lines.
- A non-consulted turn no longer blanks the Jev column: the last consultation stays
  on screen and only the header and decision line update.
- Replay gained the two endings it never produced: `handoff` parsed from
  `handoffData.reasonCode` (with `ended.reason` from the same code), and a caller
  hangup mapped from a log line with `socketClosed` when no end frame was seen. The
  replayed reconnect attempt is a counter rather than a hardcoded 1.
- A consulted turn whose answers are `null` shows the error name in the header
  instead of a column of blank bars. The pending line keeps its subject
  (`summary (reschedule) · attempt 1`, `date next week`, `reschedule`).

### Seams worth keeping for the framework

These are the pieces designed to outlive this dashboard, and the shape to reuse
when the codebase is generalized into an IVR-app framework:

- **`TurnObserver` / `RunOptions.observe`** (`src/run/turn.ts`): the one seam a live
  watcher of a dialogue attaches to, best-effort and unable to affect a turn. The
  trace writer consumes the same two moments.
- **`DashboardBus`** (`src/server/dashboard/bus.ts`): a per-process, per-call event
  bus with bounded history and isolated delivery. Nothing in it is dashboard-specific
  beyond the event union.
- **`makeObserver(bus, store, callSid)`** (`.../observer.ts`): the adapter, the
  server and the tests all build their observer here, which is what stopped the
  tests' copy from drifting away from the real one a second time.
- **`redactDeep`** (`.../events.ts`): redaction by key name over arbitrary objects,
  the right shape for any unauthenticated read of recorded call data.
- **`view.js` as a pure reducer**: `reduce(events)` and `replayEvents(records, frames)`
  are pure functions with no imports, so the browser and vitest run the same code and
  live and replay share one renderer.
- **`fixtures.scripted`** (`.../fixtures.ts`): drives real turns through the real
  observer and bus to produce test events, so the view is tested against records the
  server would actually publish rather than hand-written ones.
