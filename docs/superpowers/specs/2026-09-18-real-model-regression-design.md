# Design: Real-model regression and answer cassette

Date: 2026-09-18
Status: approved for planning
Parent: `JEV-IVR-HANDOFF.md` §6 (thresholds are placeholders until real
distributions exist); builds on `2026-09-18-text-harness-design.md`, which
governs the core, the corpus, and the regression runner.

## 1. Scope

The Jev key has arrived. The regression runner (`pnpm regress`) is
deliberately deterministic: it always answers from the fixture stub, which
fabricates distributions from the corpus labels. Its recorded baseline in
`fixtures/expected/` therefore means "what the decision core does given
label-perfect answers". This sub-project lets the same corpus and scenarios
run against the real model and diff against that baseline, so every
difference is either Jev disagreeing with a human label or a threshold
mapping a real distribution wrongly. It also records the real answers so
threshold tuning can replay them offline and free.

Out of scope: concurrent requests, replacing the stub's generated
distributions with recorded ones, an explicit final-confirm turn, and any
threshold change. Tuning is the next sub-project and consumes this one.

## 2. Cassette client

`src/jev/cassette.ts` exports `CassetteClient implements JevClient`.

**Key.** `requestKey(req)` is the SHA-256 hex of the canonical JSON of
`{ state, questions }`: object keys sorted recursively, arrays in order,
no whitespace. `timeoutMs` and `signal` are excluded. Two requests with the
same state and the same question set therefore share one recording, whatever
thresholds produced them.

**File.** One JSONL file per model, `fixtures/recorded/<model>.jsonl`, e.g.
`fixtures/recorded/jev-1.13.0.jsonl`. Each line:

```
{ "v": 1, "key": "<sha256>", "model": "jev-1.13.0",
  "text": "<state.asr.text, for humans grepping the file>",
  "answers": <AnswerMap>, "usage": { "inputTokens", "outputTokens" },
  "recordedAt": "<ISO timestamp>" }
```

`answers` is the converted `AnswerMap` (score probabilities keyed by level
label, as the SDK client emits), not the raw SDK payload. Lines are appended,
never rewritten; on load, a later line for the same key wins. A line whose
`v` is not 1 or whose `key` is missing fails the load with the line number.

**Modes.**

| Mode | Hit | Miss |
| --- | --- | --- |
| `replay` | return recorded answers | throw `JevClientError("cassette miss: <key> <text>")` |
| `record` | return recorded answers | call the live client, append the line, return its response |

A replayed response has `source: 'recorded'` (added to `AnswerSource`;
`TraceSource` extends it and needs no change), `model` from the line,
`latencyMs` of the lookup, and `usage` copied from the line with
`estimated: false`. Cost is computed downstream from usage as today, so a
replayed run reports what the recording cost, not zero; the summary in §4
labels it as replayed. A live response in `record` mode passes through
unchanged (`source: 'jev'`).

The file is opened lazily and appended with a synchronous write per miss so a
crash mid-run keeps everything recorded so far. The client never deletes or
rewrites lines.

## 3. Client kinds

`buildClient(kind, corpusFile, thresholds)` in `src/run/client.ts` gains:

| Kind | Client |
| --- | --- |
| `stub` (default) | fixture stub, unchanged |
| `heuristic` | keyword stub, unchanged |
| `jev` | live SDK client, unchanged |
| `record` | `CassetteClient` in record mode over the live SDK client |
| `recorded` | `CassetteClient` in replay mode; no key needed |

The cassette path is `fixtures/recorded/${JEV_MODEL}.jsonl`, taken from the
pinned model constant in `sdkClient.ts`; a future model bump gets a new file.
An unknown kind throws, listing the valid kinds (today it silently falls back
to the stub). `pnpm cli --client record|recorded` works the same way with no
further change, since the CLI already calls `buildClient`.

`fixtures/recorded/` is committed: it holds corpus text and model output, no
caller data.

## 4. Regression runner

`pnpm regress` gains `--client <kind>` (default `stub`). Behavior by kind:

- **stub**: exactly today's behavior, including `--update`.
- **any other kind**: runs the same corpus entries and scenarios with the
  same fixed date and clock, sequentially, and diffs against the same
  `fixtures/expected/` baseline. `--update` is refused with a message: the
  baseline is the label-derived one and is only re-recorded from the stub.

After the diff lines, every run prints a summary block; for the stub the
cost line is omitted:

```
corpus     148/154 outcomes match expected
scenarios   33/35 pass expectation,  31/35 match expected
cost usd   0.0512  (262 requests, 1,128,004 input tokens)   [replayed]
latency ms p50 540.2  p95 812.9
```

"Match expected" counts entries whose outcome has no diff line. "Pass
expectation" is the scenario's own `expect` block, as today. Cost and latency
come from the `TraceRecord` of every turn in the run (corpus entries: the
utterance turn only; scenarios: every step turn), so the numbers cover
exactly the requests the run made. `[replayed]` is appended when every
answered turn's source is `recorded`, `[mixed]` when sources are mixed.

Exit code is 1 when there are diff lines or failing scenarios, as today, for
every kind. A cassette miss in `recorded` mode surfaces as a client error on
that turn, which the decision core already handles (the turn falls back to
the no-answer path and its outcome will diff); the summary adds a line
`cassette misses N` when N > 0 so a stale recording is obvious.

## 5. Corpus and scenario runs against the real model

No change to `runCorpusEntry` or `runScenario`. A corpus entry runs in its
labeled context (form, collected slots, prompted slot) exactly as it does for
the stub, so the recorded answer is for the state the core would really send.
Scenario `fail` steps still inject the client error at the runner and never
reach the cassette.

Order of execution is corpus entries in file order, then scenarios in file
order, so the cassette file is stable across re-recordings that hit nothing
new.

## 6. Testing

- `cassette.test.ts`: key is stable under key order and ignores
  `timeoutMs`/`signal`; replay hit returns recorded answers with
  `source: 'recorded'`; replay miss throws `JevClientError` naming the key;
  record miss calls the inner client once, appends one line, and a second
  identical request does not call it again; later duplicate key wins on
  load; malformed line fails the load with its line number. Uses a temp file
  in the test's scratch directory and a fake inner client.
- `client.test.ts` (new or extended): each kind builds the expected class;
  unknown kind throws with the list.
- `regress` has no unit test today and stays that way; the summary formatter
  is extracted to a pure function `formatRegressSummary(...)` in
  `regress.ts`'s sibling `regressSummary.ts` and tested for the four lines,
  the `[replayed]`/`[mixed]` tags, the stub's omitted cost line, and the
  misses line.
- Manual: `pnpm regress --client record` once with the key in the shell,
  commit `fixtures/recorded/jev-1.13.0.jsonl`, then
  `pnpm regress --client recorded` reproduces the same diff with no network.

## 7. README

Add to the Regression section: the three client kinds, that the baseline is
label-derived and stub-only, the recording workflow above, and that
`fixtures/recorded/` is committed and safe to share.
