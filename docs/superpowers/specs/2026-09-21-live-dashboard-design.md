# Design: Live call dashboard

**Date:** 2026-09-21
**Status:** approved in conversation; implementation plan to follow
**Depends on:** name and date of birth (PR #10), the practice-name greeting (PR #11)

## 1. Purpose

A page that shows what the system is doing during a call, for two uses: a screen recording in which Jason makes a real call while the page updates, and a narrated presentation in which a recorded call is replayed turn by turn. The viewer should come away with two things at once: the conversation is flexible (slots fill in any order, partials narrow, a correction refills exactly what it names, a second task queues), and the model underneath is only answering typed questions (the question batch and its probabilities are on screen every turn).

The page reads what the trace already records. It never influences a turn.

Out of scope: audio in the page, editing thresholds from the page, a multi-call view. The page follows one call at a time, the most recent.

## 2. Components

### 2.1 Observer hook in the turn runner

`RunOptions` (src/run/turn.ts) gains an optional `observe`:

```ts
export interface TurnObserver {
  /** The request to the model has just left. */
  asked(questions: QuestionMap, turnState: TurnState, at: number): void;
  /** The turn is resolved; `record` is the trace record as written. */
  turn(record: TraceRecord, at: number): void;
}
```

`runTurn` calls `asked` immediately before `client.ask` when `p.needsModel` is true, and `turn` after the trace record is built, whether or not the model was asked. `at` is `now()` in epoch ms. The text harness and the CLI leave `observe` unset. This is the seam any live watcher of a dialogue attaches to; the trace writer is the other consumer of the same moment.

### 2.2 DashboardBus (server)

`src/server/dashboard/bus.ts`. One bus per server process. It keeps the current call's event history (bounded, 2,000 events) and a set of subscribers. `publish(event)` appends and fans out; `subscribe(fn)` replays the history to the new subscriber first, then streams. `call_started` for a new CallSid resets the history: the bus follows the most recent call.

Events (`src/server/dashboard/events.ts`), each with `type`, `callSid`, `at` (epoch ms):

| type | payload | source |
| --- | --- | --- |
| `call_started` | `from` masked to the last four digits (`…2926`), `todayIso` | adapter, on the setup frame |
| `asked` | `turnIndex`, `questions`, `turnState` | observer `asked` |
| `turn` | the full `TraceRecord` | observer `turn` |
| `silence` | `promptId` the silence answered | adapter, when the no-input timer fires |
| `dtmf` | `digit` | adapter, on a dtmf frame (before the ignore/turn split) |
| `interrupt` | `utteranceUntilInterrupt` when Twilio supplies it | adapter, on an interrupt frame |
| `reconnect` | `attempt` | adapter, on a reconnect setup |
| `handoff` | `reason`, `number` masked | adapter, on the end frame with handoff data |
| `ended` | `reason` (`completed`, `hangup`, `handoff`, `error`) | adapter, on end or socket close after end |

The adapter already has every one of these moments; publishing is one line at each. `turn` events also carry the rendered prompt text for each outbound `text`/`play` frame, taken from the record's frames plus the render context, so the page never needs the manifest.

### 2.3 Routes

All on the existing HTTP server (src/server/http.ts), disabled when `DASHBOARD=off`:

- `GET /dashboard`: the page, a single static HTML file at `src/server/dashboard/page.html`, served with `Cache-Control: no-store`.
- `GET /dashboard/events`: server-sent events. On connect the client receives the bus history, then live events. Each SSE message is one JSON event; `id` is the event's sequence number; heartbeat comment every 15 s.
- `GET /dashboard/traces`: JSON list of `{ callSid, startedAt, turns, sizeBytes }` from `traces/*.jsonl`, newest first, capped at 50.
- `GET /dashboard/traces/<callSid>`: JSON `{ records: TraceRecord[], frames: FrameLogLine[] }` from `traces/<callSid>.jsonl` and `traces/<callSid>.frames.jsonl`. `callSid` is validated with the existing `safeFileStem` rule; anything else is 404.

The routes are unauthenticated like `/health`. The ngrok URL is not shared beyond the demo; the env switch exists for the day it is.

### 2.4 The page

`src/server/dashboard/page.html`: one file, inline CSS and script, no build step, no framework, no external requests. Dark theme, laid out for 1920 by 1080 with large type. Two modes from a toolbar: **Live** (subscribed to `/dashboard/events`) and **Replay** (a trace picked from `/dashboard/traces`).

The rendering logic lives in `src/server/dashboard/view.js`: a plain ES module with no imports and JSDoc types, pure functions from events to a view model (`reduce(events) -> View`, `replayEvents(records, frames) -> Event[]`). The page loads it as `<script type="module" src="/dashboard/view.js">`, served by the same static route as the page, and vitest imports the same file directly. Keeping it JavaScript rather than TypeScript is what removes the build step; it is the only `.js` source file in the repo and the plan adds it to the lint and format config.

Replay converts a trace into the same event sequence the live path produces: `call_started` from the first record, one synthesized `asked` per record that carries questions, then `turn`; frame-log lines become `silence`, `dtmf`, `interrupt`, `reconnect`, `handoff`, `ended` with their logged timestamps. So the page has one renderer and two sources.

## 3. What the page shows

### 3.1 Header strip

Status (`waiting for a call`, `live · …2926`, `replay · CA0915…`), turn counter, running Jev latency and cost totals for the call, and in replay the transport controls (§4).

### 3.2 Left column, top: the conversation

System and caller lines in order. A system line is the rendered prompt text with the prompt id in small type beside it. A caller line is the final transcript. Between-turn moments are quiet inline markers: `silence · 7 s`, `keypad 03051980`, `interrupted`, `reconnected`, `transfer to …4567`. The newest exchange is highlighted; the column auto-scrolls.

### 3.3 Left column, bottom: the state

The active form as a title (`reschedule`), its slots as chips in form order: empty (grey), partial (amber, with the window label or the month and day), filled (green, with the display value). Then one line each, when present: the pending confirmation (`confirm · summary · attempt 1`), the queued task (`queued · billing`), and the retry counter of the slot being asked (`asking date · attempt 2 of 3`). A chip whose value changed on this turn flashes once.

### 3.4 Right column: Jev

Header: `Jev · turn 3 · 31 questions · 172 ms · 4,180 tokens · $0.0002`. Groups in consultation order: `gates`, `intent`, `confirmation` (only while a confirmation is pending), then one group per slot on the active form in form order. Outside a form the slot groups are all slots.

A row shows the question id, a bar of its probability with the threshold drawn as a tick, and its value. Which threshold: the gate's own for a gate, `SLOT_DETECT` for a `*Given` noul, `SLOT_CHOICE_CONFIRM` for a slot choice, the intent margin rule for `intent`; the `call_started` event carries the server's effective thresholds, and a replay takes them from the same event it synthesizes, using the current defaults (a replayed call recorded under different thresholds shows today's ticks, which is acceptable for a demo and noted in the toolbar). A row is **decisive** when its answer crossed its threshold or when it is named in the record's gate rows or decision. Decisive choice rows also show their top four options with probabilities. Quiet groups collapse to `slot · date (3 quiet)` and expand on click; a decisive group is always open.

Bottom line, in words: which gate decided, which slots filled or narrowed, the next prompt: `dob filled 1980-03-05 · next: date_narrow_window`.

On `asked` the groups appear with empty bars; on `turn` they fill. Live, that is about 170 ms. In replay the `asked` state is held for a beat (§4).

## 4. Replay

Source: a trace file and its frame log (§2.3). Controls: space or right arrow advances one event; left arrow steps back (the page keeps the event list and re-renders from the start up to the cursor, so stepping back is exact); Play runs at recorded pace with 1x, 2x, 4x and a 5 s cap on any gap; Reset returns to `call_started`. The `asked` beat is 800 ms by default, adjustable in the toolbar. A call with no frame log replays turns only.

## 5. Tests

- `src/run/turn.test.ts`: `observe.asked` fires before the client is called with the same questions the client receives; `observe.turn` fires with the written record; neither fires when `observe` is unset; `turn` still fires when the model is not asked or throws a client error.
- `bus.test.ts`: fan-out, history catch-up, bound, reset on a new call.
- `src/server/server.test.ts` (or a new `dashboard.test.ts`): open the SSE stream, run a scripted call through the adapter (setup, a prompt frame, silence, a dtmf frame, end), assert the event sequence and that a late subscriber gets the history; `/dashboard/traces` lists a fixture trace; `/dashboard/traces/<sid>` returns records and frames; `DASHBOARD=off` gives 404.
- `view.test.ts`: from fixture events (built from a harness scenario run with a trace writer, so they are real records), assert the conversation lines, the chip states across an opener that fills three slots, a partial, a correction that refills two slots, a queued task; the group order and which rows are decisive; the replay event sequence built from a trace file equals the live sequence for the same scenario.
- No browser test. The page's script is small and is checked by hand on the live call.

## 6. Recording day

Start ngrok and `pnpm serve` as in the README. Open `https://PUBLIC_HOST/dashboard` (or `http://localhost:3000/dashboard`) full screen at 1920 by 1080; the page says `waiting for a call`. Start the screen recorder, dial. Afterwards, Replay the same call for a narrated take; the three calls from the name-and-birthday checklist are already on disk as rehearsal material.

## 7. README

A "Dashboard" subsection under the phone-line section: the URL, the two modes, the keys, the `DASHBOARD=off` switch, and a sentence that the page shows only what the trace stores, with the caller number masked.
