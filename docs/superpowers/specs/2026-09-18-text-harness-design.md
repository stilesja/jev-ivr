# Design: Phase 0–1, decision core and text harness

Date: 2026-09-18
Status: approved for planning
Parent: `JEV-IVR-HANDOFF.md` (the handoff brief governs anything not restated here)

## 1. Scope

This spec covers the first sub-project of the Jev IVR demo: handoff Phases 0
and 1. It produces a working text harness that takes typed utterances, runs
the full turn schema against a stub decision model, resolves the gate ladder,
fills slots, emits ConversationRelay frames, and writes JSONL traces.

In scope:

- Repo scaffolding: TypeScript, pnpm, vitest, single package.
- `JevClient` interface with three implementations: fixture stub, heuristic
  stub, and an SDK-backed real client (untestable until a key arrives).
- The healthcare scheduling flow: intents, forms, slots.
- Pure decision core: state assembly, question builder, gate ladder, form
  interpretation loop, deterministic normalizers.
- ConversationRelay frame types and a prompt manifest (text only).
- Labeled fixture corpus and multi-turn scenarios.
- Text harness CLI, run metrics, JSONL trace writer, regression runner.

Out of scope, each a later sub-project:

- Twilio server, ngrok, TwiML, signature validation.
- Audio assets, fetch-audio orchestration timing.
- Browser harness and debug panel UI.
- Tier 3b LLM normalizer (interface only; stub returns unavailable).
- Partial prompts and in-flight cancellation.
- Threshold tuning and calibration curves (need the real model).

## 2. Decisions made here

| Decision | Choice | Why |
| --- | --- | --- |
| Jev access | Official `@typesafe-ai/sdk`, `client.systemOne()` | Exposes full `probabilities`; margin gate needs them. Vercel wrapper unverified. |
| Model ID | `jev-1.13.0` pinned in a constant | Aliases move; thresholds are calibrated per version. |
| Question ownership | Own `Question`/`Answer` types in `src/jev/types.ts`; SDK mapping lives only in the real client | Core must not import a vendor; another classifier must be droppable. |
| Repo layout | One pnpm package, `src/<area>/` folders | Workspace overhead buys nothing before the Twilio server exists. |
| Stub | Fixture table first, keyword heuristic fallback, source recorded in trace | Table keeps regression deterministic; heuristic keeps the REPL usable. |
| Numeric state | Bucketed into named levels before sending | Jev 1.13 reads literally and is weak on numbers. |
| Date slot | Component Choices resolved in code (cookbook pattern) | Model cannot do date arithmetic; components are bounded choices. |
| Member ID format | Eight digits, mask `^\d{8}$` | DTMF fallback stays natural; exercises spoken-number normalization. |
| Retry policy | Uniform per slot and for intent: attempt 1 open reprompt, attempt 2 DTMF-style prompt, attempt 3 agent | Handoff requires a DTMF fallback for every slot; intent is the first slot. This is a deliberate refinement of "agent on second failure". |
| Margin gate direction | Disambiguate when `top1 − top2 < 0.15` | Handoff table wrote `≥`; the prose makes the intent clear. |

## 3. Domain: healthcare scheduling flow

### Intents

`schedule_new`, `reschedule`, `cancel`, `confirm_appointment`, `billing`,
`agent`, `repeat_prompt`, `other`, `none`.

`none` means the utterance expresses no new intent. Inside an active form this
is the normal case: the caller is answering the slot prompt.

### Forms

| Intent | Required slots | On completion |
| --- | --- | --- |
| `schedule_new` | memberId, provider, date | play `schedule_confirmed`, end |
| `reschedule` | memberId, provider, date | play `reschedule_confirmed`, end |
| `cancel` | memberId, provider | play `cancel_confirmed`, end |
| `confirm_appointment` | memberId, provider | play `appointment_details`, end |
| `billing` | memberId | end with handoff `billing` |
| `agent` | none | end with handoff `live-agent` |
| `repeat_prompt` | none | replay last prompt |
| `other`, `none` (no active form) | none | reprompt per retry policy |

Slot prompt priority within a form: memberId, provider, date. The loop always
prompts for the highest-priority empty slot.

### Slot kinds

Each slot is a `SlotSpec` that contributes its own questions to the turn
schema and its own fill logic. Three kinds exist in v1.

**Choice slot** (`provider`). One Choice question over a fixed roster plus
`none`. Roster lives in `src/domain/providers.json` with eight entries and one
near-collision pair (Chen, Cheng) so the margin gate has something to catch.
Fill rules mirror the intent bands, using the top-1 probability: ≥
`SLOT_CHOICE_FILL` (0.70) fills silently; ≥ `SLOT_CHOICE_CONFIRM` (0.45)
fills with implicit confirm; below that leaves the slot empty. Independently,
top1 − top2 < `SLOT_CHOICE_MARGIN` (0.15) disambiguates the top two. A `none`
top-1 means the slot was not mentioned and is not an attempt.

**Extracted slot** (`memberId`). Three questions: `containsMemberId` (Noul),
`memberIdSpan` (Choice over `candidateSpans` plus `none`), `memberIdComplete`
(Noul). When contains and complete both exceed `SLOT_DETECT` (0.60), the chosen span
goes to tier 3a normalization. Mask pass fills the slot. Mask fail counts as a
slot attempt and reprompts per the retry policy.

**Date slot** (`date`). Component Choice questions, all in the same call:

| Question | Options |
| --- | --- |
| `dateMode` | absolute, relative_day, weekday, window, none |
| `dateMonth` | january … december, none |
| `dateDay` | 1 … 31, none |
| `dateWeekday` | monday … sunday, none |
| `dateWeekdayQualifier` | this, next, none |
| `dateRelativeDay` | today, tomorrow, day_after_tomorrow, none |
| `dateWindow` | this_week, next_week, this_month, next_month, none |

Code resolves these against an injected `today` into one of:

```ts
{ kind: 'day', iso: 'YYYY-MM-DD', confidence }
{ kind: 'window', start: iso, end: iso, label: string, confidence }
{ kind: 'none' }
```

Confidence is the minimum top-1 probability among the components the chosen
mode used. Year is never asked; an absolute date is placed in the current year,
or the next if more than 31 days in the past. Impossible dates resolve to
`none`. A `window` result stores the window on the slot and marks it unfilled;
the next prompt narrows it (`date_narrow_window`: "Which day next week works?").
Time of day is out of scope.

### Candidate spans

Generated from the utterance for extracted slots. Tokens are whitespace-split;
spans are n-grams of length 1 to 10 that contain at least one digit or number
word; deduplicated in document order; capped at 120 plus the `none` option,
which keeps Choice cardinality well under 255.

### DTMF baseline

`src/domain/dtmf-baseline.json` holds a hand-counted turns-to-completion for
each form under a conventional DTMF tree (main menu, sub-menu, ID entry with
confirm, provider menu, date entry with confirm). The metrics summary divides
observed turns by this baseline.

## 4. Turn schema

Built by `buildQuestions(turnState, form)`. Always-on questions:

| Group | Question | Type | Options |
| --- | --- | --- | --- |
| Routing | `intent` | Choice | intent set |
| Routing | `intentSecondary` | Choice | intent set |
| Control | `addressedToSystem` | Noul | |
| Control | `utteranceComplete` | Noul | |
| Control | `wantsHuman` | Noul | |
| Control | `rephrasingLastTurn` | Noul | |
| Control | `confusedByPrompt` | Noul | |
| Control | `spokeAMenuNumber` | Noul | |
| Caller | `frustration` | Score | none, mild, high |
| Caller | `urgency` | Score | low, normal, high |
| Caller | `triedSelfService` | Noul | |
| Caller | `languageSwitch` | Choice | none, es, fr |
| Guard | `intelligible` | Noul | |

Conditional questions:

- Slot fragments for every slot in the active form. When no form is active,
  fragments for the union of all slots run anyway, so a first utterance can
  over-answer.
- When a confirmation is pending: `confirmsYes` and `confirmsNo` (Noul).
- When a DTMF-style menu prompt was just played: `menuNumberSaid` (Choice over
  the menu's option numbers plus `none`).

Instructions are complete sentences, one judgment each, and name the state
field they read, following the docs' literal-reading guidance.

## 5. State sent to the model

`TurnState` is derived from the session and the event on every turn. It is the
handoff's shape with numeric fields bucketed and history trimmed.

```ts
interface TurnState {
  node: { id: string; promptJustPlayed: string; options: string[] };
  turn: { attempt: 'first' | 'second' | 'third_or_more';
          elapsed: 'under_30s' | 'under_2m' | 'over_2m' };
  slots: Record<string, { value: string | null; confirmed: boolean }>;
  history: Array<{ node: string; intent: string; outcome: string }>; // last 3
  caller: { verified: boolean; openAppointment: boolean;
            priorCalls: 'none' | 'one' | 'several' };
  asr: { text: string; isFinal: boolean; bargeIn: boolean; dtmf: string | null };
  candidateSpans: string[];
  pendingConfirmation: { slot: string; value: string } | null;
}
```

Every question that reads a field names it, for example "Read `asr.text`.
Does the caller name a provider?"

## 6. Gate ladder

Evaluated in order. First failing gate decides. Every gate, including ones
after the deciding gate, is still evaluated and written to the trace with
`value`, `threshold`, `passed`, and `outcome`, so the debug table is complete.

| # | Gate | Condition to pass | On fail |
| --- | --- | --- | --- |
| 1 | `addressedToSystem` | noul ≥ `GATE_ADDRESSED` (0.70) | ignore: no frames, no attempt counted |
| 2 | `intelligible` | noul ≥ `GATE_INTELLIGIBLE` (0.50) | slot attempt +1, reprompt per retry policy |
| 3 | `utteranceComplete` | noul ≥ `GATE_COMPLETE` (0.60) | if `asr.isFinal` is false: hold, wait. If final: outcome `noted`, ladder continues |
| 4 | `wantsHuman` | noul < `GATE_WANTS_HUMAN` (0.70) | end, handoff `live-agent` |
| 5 | intent switch | see below | routes or confirms |
| 6 | intent margin | top1 − top2 ≥ `GATE_INTENT_MARGIN` (0.15), only when gate 5 routed | disambiguate top two |
| 7 | escalation | not (`frustration.probabilities.high` ≥ `GATE_FRUSTRATION_HIGH` (0.60) and attempt ≠ first) | end, handoff `live-agent` |
| 8 | slot fill | per slot kind, section 3 | per slot outcome |

Gate 5 uses the top-1 probability from `intent.probabilities`, not the
reported `confidence` statistic, so the bands stay comparable to the margin.

- No active form: ≥ `INTENT_ROUTE` (0.85) routes silently; ≥ `INTENT_IMPLICIT`
  (0.60) routes with implicit confirm in the next prompt; ≥ `INTENT_EXPLICIT`
  (0.40) asks an explicit confirm; below that counts an intent attempt and
  reprompts per the retry policy.
- Active form and `intent` is `none` or `other`: gate passes, no route change.
- Active form and a different intent ≥ `INTENT_SWITCH` (0.85): switch forms,
  keep any slot values the new form also needs.
- `agent` and `repeat_prompt` are handled here at the same bands.

Thresholds live in `src/core/thresholds.ts` as named exports with a
`PLACEHOLDER` comment. The CLI can override any of them per run.

## 7. Turn function

The core is synchronous and pure. The only I/O is the model call, so a turn is
two calls with the client in between.

```ts
plan(session, event, clock): { turnState, questions }
resolve(session, event, answers, clock): { session, gates, decision, frames, trace }
```

`runTurn(session, event, client, clock)` in the harness does plan, ask,
resolve, and returns the same result plus timing. Fixture replay, the Twilio
adapter, and the browser harness all call the same two functions.

`Session` holds: ids, active form and its slot states, attempt counters per
slot and for intent, last prompt id, history, caller record, pending
confirmation, DTMF digit buffer, consecutive client failure count.

`Event` is an inbound ConversationRelay frame. `prompt` frames drive the full
schema. `dtmf` frames append to the buffer; when the buffer satisfies the
active slot's DTMF rule (eight digits for memberId, one digit for a menu), the
turn fills or routes without a model call and the trace records
`answers: null, source: 'dtmf'`. `setup` initializes the session and emits
the greeting. `interrupt` and `error` are logged.

Decisions are a closed union: `ignore`, `hold`, `prompt(promptId, slot?)`,
`confirm(slot, value, mode)`, `disambiguate(slot, a, b)`, `route(form)`,
`complete(form)`, `handoff(reason)`, `replay`.

## 8. Extraction tiers

Tier 1 and 2 are questions in the turn schema (section 3). Tier 3a lives in
`src/core/extract/` and is pure:

- `spokenNumber.ts`: number words to digits. Handles digit words, "oh" as
  zero, "double"/"triple", tens and compound numbers ("forty four" → 44,
  "four hundred" → 400), and already-numeric tokens. Output is the digit
  string.
- `mask.ts`: validates against the slot's regex.
- `date.ts`: component resolver from section 3.

Tier 3b is `interface LlmNormalizer { normalize(req: ExtractionRequest):
Promise<ExtractionResult | 'unavailable'> }` with a stub that always returns
`'unavailable'`. Unavailable counts as a slot attempt so the retry policy
reaches the DTMF prompt.

NATO alphabet and checksum normalizers are not needed by v1 slots and are not
built.

## 9. Client interface

```ts
type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | string[] | null> }
  | { type: 'score';  instructions: string; criteria: string[] }
  | { type: 'noul';   instructions: string; criteria?: string };

type Answer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score';  score: number;  probabilities: Record<string, number>; confidence: number }
  | { type: 'noul';   noul: number };

interface JevRequest  { state: JsonValue; questions: Record<string, Question>; timeoutMs?: number; signal?: AbortSignal }
interface JevResponse { answers: Record<string, Answer>; model: string;
                        usage: { inputTokens: number; outputTokens: number };
                        latencyMs: number; source: 'jev' | 'stub:fixture' | 'stub:heuristic' | 'replay' }
interface JevClient   { ask(req: JevRequest): Promise<JevResponse> }
```

Implementations in `src/jev/`:

- `fixtureStub.ts`: keyed on normalized utterance text. A corpus entry's labels
  become sharp distributions (label gets `STUB_SHARPNESS` 0.90, remainder
  spread evenly). Entries may carry explicit `answers` overrides that replace
  the generated ones for any question. Unknown utterances fall through to the
  heuristic stub. Accepts an `injectFailure` option that rejects with a
  timeout error for a given turn, for testing the failure path.
- `heuristicStub.ts`: keyword rules produce plausible distributions for any
  text. Marked clearly as a development aid; never used in regression.
- `sdkClient.ts`: wraps `TypeSafeClient.systemOne()`. Maps our types to the
  SDK's, pins `jev-1.13.0`, sets per-attempt timeout `JEV_TIMEOUT_MS` (1500,
  placeholder) and `maxRetries: 1`, measures wall-clock latency. Selected by
  `--client jev` and requires `TYPESAFE_API_KEY`.

Cost is computed everywhere as `inputTokens × JEV_PRICE_PER_MTOK / 1e6` with
the price 0.042. Stubs estimate tokens as JSON length divided by four and mark
`usage.estimated: true`.

## 10. Failure handling

A rejected `ask()` is a decision, not an exception. The harness catches it,
increments the session's consecutive-failure count, and resolves with
`answers: null`. One failure: prompt `system_slow_dtmf_hint` for the active
slot or intent. Two consecutive failures: handoff `system-failure`. A
successful turn resets the count. The trace record carries the error name and
message.

## 11. Channel frames and prompts

`src/channel/frames.ts` defines the inbound and outbound frame types exactly
as the handoff's section 4, as discriminated unions.

`src/prompts/manifest.json` maps prompt ids to `{ text, interruptible,
audio: null }`. Prompt text templates take slot values for implicit confirms
("Rescheduling with Dr. {provider}. What's your member ID?"). The decision to
frames step emits `text` frames with the rendered text and the manifest's
`interruptible` flag. `play` frames arrive with audio assets in a later
sub-project; the manifest shape already has the field.

## 12. Fixtures

`fixtures/corpus.jsonl`, 100 to 200 single-utterance entries:

```jsonc
{ "id": "resched-012", "text": "I need to reschedule my appointment, it's with Dr. Chen sometime next week",
  "intent": "reschedule", "slots": { "provider": "chen", "date": { "kind": "window", "label": "next_week" } },
  "context": "no_form",                       // or the active form name
  "answers": { "intent": { "probabilities": { "reschedule": 0.62, "cancel": 0.30 } } },  // optional override
  "tags": ["over_answer", "window"] }
```

Coverage targets: every intent, every slot alone and in combination, spoken
number forms, absolute and relative dates, near-collision providers, side
speech, unintelligible text, frustration, human requests, menu numbers, and
around twenty entries with explicit low-confidence or low-margin overrides.

`fixtures/scenarios/*.json`, about fifteen multi-turn scripts, each a list of
inbound frames with an expected final decision and expected slot values:
happy path per form, over-answering, intent switch mid-form, window then day,
each retry policy step through to agent, DTMF entry, explicit confirm yes and
no, disambiguation both ways, frustration escalation, client failure once and
twice.

`fixtures/expected/` holds the regression runner's recorded outcomes: for each
corpus entry and scenario, the decision, filled slots, and the gate that
decided.

## 13. Text harness

`src/harness-text/cli.ts`, run with `pnpm cli`:

- No arguments: REPL. Type an utterance to send a `prompt` frame with
  `last: true`. `dtmf:1234` sends digit frames. `/reset` starts a new session.
- `--corpus fixtures/corpus.jsonl`: run every entry as a fresh single turn.
- `--scenarios fixtures/scenarios`: run every script.
- `--client stub|jev`, `--trace traces/<name>.jsonl`, `--threshold NAME=VALUE`
  (repeatable), `--today YYYY-MM-DD`, `--quiet`.

Per turn the CLI prints: the utterance, a probability table for every
question (sorted, top three per Choice, all levels per Score, the value per
Noul), the gate table, the decision, and the outbound frames' rendered text.

Run summary: slots filled per utterance, turns to completion per form against
the DTMF baseline, decision latency p50 and p95, total and per-call cost, and
count of decisions by deciding gate.

`pnpm regress` runs corpus and scenarios with the fixture stub and diffs
against `fixtures/expected/`, printing changed outcomes. `pnpm regress
--update` rewrites the expected files.

## 14. Trace record

One JSONL line per turn, written by `src/trace/writer.ts`. Frozen here.

```ts
interface TraceRecord {
  v: 1;
  sessionId: string; turnIndex: number; ts: string;
  event: InboundFrame;
  turnState: TurnState | null;                 // null for dtmf-only turns
  questions: Record<string, Question> | null;
  answers: Record<string, Answer> | null;
  source: 'jev' | 'stub:fixture' | 'stub:heuristic' | 'replay' | 'dtmf' | 'error';
  error: { name: string; message: string } | null;
  gates: Array<{ gate: string; value: number | null; threshold: number | null;
                 passed: boolean; outcome: string; decided: boolean }>;
  decision: Decision;
  frames: OutboundFrame[];
  slots: Record<string, SlotState>;            // after the turn
  timing: { planMs: number; askMs: number; resolveMs: number; totalMs: number };
  usage: { inputTokens: number; outputTokens: number; estimated: boolean; costUsd: number };
}
```

## 15. Testing

- Vitest, written test-first per module: spoken numbers, date resolver,
  candidate spans, question builder shape, each gate in isolation, form loop
  transitions, decision to frames, trace record shape, fixture stub
  determinism, DTMF buffer rules, failure handling.
- The fixture and scenario runners are the integration suite. `pnpm test` runs
  unit tests; `pnpm regress` is a separate command so threshold experiments do
  not fail CI-style runs.
- The SDK client has a unit test for the type mapping only, with the network
  call mocked.

## 16. Repo layout

```
src/
  domain/        intents, forms, slot specs, providers.json, dtmf-baseline.json
  core/          state.ts, questions.ts, gates.ts, thresholds.ts, fia.ts, turn.ts, decision.ts
  core/extract/  spokenNumber.ts, mask.ts, date.ts, llmNormalizer.ts
  jev/           types.ts, client.ts, fixtureStub.ts, heuristicStub.ts, sdkClient.ts
  channel/       frames.ts, render.ts
  prompts/       manifest.json, render.ts
  trace/         writer.ts, types.ts
  harness-text/  cli.ts, runner.ts, metrics.ts, print.ts
fixtures/        corpus.jsonl, scenarios/, expected/
traces/          gitignored output
docs/superpowers/specs/
```

## 17. Open items carried forward

Unchanged from the handoff's section 12, minus the ones the docs resolved
(probabilities exposure, Noul field name, SDK choice, retry semantics). Still
open and blocked on a key or a real call: every threshold value, measured
latency, partial prompt semantics, smart-format effects.
