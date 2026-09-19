# Design: Automated threshold sweep

Date: 2026-09-19
Status: approved for planning
Parent: `JEV-IVR-HANDOFF.md` §6 and §12 (thresholds are placeholders until
tuned against real answers); builds on `2026-09-18-real-model-regression-design.md`
(the cassette and label baseline) and `2026-09-19-question-redesign-design.md`
(the questions the recording now covers).

## 1. Scope

Every value in `src/core/thresholds.ts` is a placeholder. The recorded
cassette (`fixtures/recorded/jev-1.13.0.jsonl`) holds the real model's
answers for all 166 corpus entries and 45 scenarios, and the label baseline
(`fixtures/expected/`) holds what the decision core does given label-perfect
answers. This sub-project adds `pnpm sweep`, which searches the thresholds
offline against the cassette for the set that makes real answers reproduce
the label baseline's decisions most often, explains each move by the entries
it flips, and can write the result into `thresholds.ts` with a report.

Out of scope: changing gate logic or question wording; joint search over
threshold combinations; any label change except the one in §7; the
follow-ups listed at the end of the question-redesign plan.

## 2. Command

`pnpm sweep` runs `src/harness-text/sweep.ts`:

```
pnpm sweep                       # sensitivity table, recommended set, flips, misses
pnpm sweep --apply               # also rewrite thresholds.ts and write the report
pnpm sweep --json out.json       # also write the machine-readable log
pnpm sweep --only INTENT_ROUTE,SLOT_CHOICE_FILL   # restrict the sweep
pnpm sweep --passes 3            # cap the descent (default 5)
```

The sweep always uses the `recorded` client, the fixed regression date
(`REGRESS_TODAY`) and clock (`now: () => 0`), the corpus file and scenario
directory the regression runner uses, and one `CassetteClient` instance
shared across every candidate (thresholds never reach the request key). It
fails at startup if the cassette is absent. Progress goes to stderr; the
tables go to stdout.

## 3. Scoring

For one candidate threshold set the sweep runs every corpus entry and every
scenario exactly as `regress.ts` does and compares outcomes to the baseline.

**Decision fields**: `decision`, `promptId`, `reason`, `form`, `slots`.
**Cosmetic fields**: `acks`, `decidedGate`, `verdict`, `queued`.

- `corpusMatch`: corpus entries whose decision fields all equal the
  baseline's.
- `scenarioPass`: scenarios whose own `expect` block passes
  (`checkExpectation`), excluding scenarios with a miss (§4).
- `cosmeticMatch`: entries and scenarios (excluding missed ones) whose
  cosmetic fields also all equal the baseline's.
- `misses`: scenarios in which any turn's trace record carries a
  `cassette miss` client error.

`primary = corpusMatch + scenarioPass`; `secondary = cosmeticMatch`. A
candidate is better when its primary is higher, or equal with a higher
secondary.

**Stub invariant**: before scoring, the candidate is run once with the
fixture stub; if any outcome differs from the baseline the candidate is
rejected outright and reported as `breaks stub baseline`. The label
baseline is only meaningful while the stub reproduces it.

## 4. Cassette misses

Corpus entries are single-turn and never miss. A scenario turn whose state
diverged from the recording has no answer; the runner already models that
as a client error, and the sweep detects it by the `cassette miss` prefix in
the turn's trace record. Such a scenario is excluded from both scores for
that candidate and counted in `misses`. The report lists, for the
recommended set, every missed scenario and the utterance that missed, so
one live `pnpm regress --client record` fills them. A second `pnpm sweep`
after that recording is expected to confirm the set (or move a threshold the
newly recorded turns contradict).

## 5. Sweepable thresholds, grids, and constraints

Sweepable (20): `GATE_ADDRESSED`, `GATE_INTELLIGIBLE`, `GATE_COMPLETE`,
`GATE_WANTS_HUMAN`, `INTENT_ROUTE`, `INTENT_IMPLICIT`, `INTENT_EXPLICIT`,
`INTENT_SWITCH`, `GATE_INTENT_MARGIN`, `GATE_FRUSTRATION_HIGH`,
`INTENT_TENTATIVE`, `INTENT_CHANGE`, `PROVIDER_UNSURE`, `SLOT_DETECT`,
`SLOT_CHOICE_FILL`, `SLOT_CHOICE_CONFIRM`, `SLOT_CHOICE_MARGIN`,
`CONFIRM_YES`, `CONFIRM_NO`, `MENU_NUMBER`.

Fixed: `MAX_ATTEMPTS`, `STUB_SHARPNESS`, `JEV_TIMEOUT_MS`,
`JEV_PRICE_PER_MTOK`.

Grids: probability thresholds 0.05 … 0.95 step 0.05; the two margins
(`GATE_INTENT_MARGIN`, `SLOT_CHOICE_MARGIN`) 0.05 … 0.40 step 0.05. Values
are rounded to two decimals.

Constraints, checked against the candidate as a whole; a grid point that
violates one is skipped:

- `INTENT_EXPLICIT <= INTENT_IMPLICIT <= INTENT_ROUTE`
- `INTENT_IMPLICIT <= INTENT_SWITCH`
- `SLOT_CHOICE_CONFIRM <= SLOT_CHOICE_FILL`

The table of sweepable names, grids, and constraints lives in one module
(`src/harness-text/sweepSpace.ts`) so the sweep, the tests, and the report
share it.

## 6. Search

Coordinate descent from the current `DEFAULT_THRESHOLDS`:

1. For each sweepable threshold in the order listed in §5 (or `--only`),
   evaluate every grid value with all other thresholds held at their
   current values. Record the score at each value.
2. Find the best primary score on that grid (ties broken by secondary).
   Take the longest contiguous run of grid values achieving it (a
   plateau); if several runs tie in length, prefer the one containing the
   current value, then the one nearest to it. The candidate value is the
   plateau's middle point (lower-middle on an even run).
3. Move only when the candidate value differs from the current one AND
   (a) primary improves, or (b) primary ties and secondary improves, or
   (c) both tie and the current value sits on an edge of its plateau while
   the candidate is its center (a free move to safer ground). A plateau of
   length one at the best score is a **cliff**: never moved to; flagged.
4. A pass is one loop over all thresholds. Repeat until a pass makes no
   move or `--passes` is reached.

Each move records: threshold, from, to, primary/secondary before and
after, plateau extent, and the ids whose decision fields changed (flips),
split into gained and lost.

## 7. The one label decision

`ns-03` ("um") and `ns-04` ("ksh brr the") are tagged `unintelligible` and
override `intelligible` so the stub yields `nomatch` (a re-prompt). The
real model rejects both at the addressed-to-system gate first, which
ignores them. Ignoring background noise is the better behavior, so their
overrides change to `addressedToSystem: 0.5` (keeping the intelligible
override) and the baseline is re-recorded from the stub, making `ignore`
the labeled outcome. This is the only fixture change in the sub-project and
it lands before the sweep runs, so the sweep does not spend moves on it.

## 8. Outputs

**Sensitivity table** (stdout, one row per threshold): current value,
recommended value, best primary, and the grid rendered as a compact strip
(one character per grid point: `#` at the best score, `+` within one of it,
`-` below, `x` constraint-skipped, `!` breaks the stub) with the current and
recommended positions marked. A cliff is annotated.

**Moves**: one block per applied move with the flips listed by id.

**Cliffs and ties**: thresholds left alone because their best was a cliff,
and thresholds whose whole grid scored the same (insensitive on this
corpus), listed so a human knows which values are unconstrained by data.

**Misses**: for the recommended set, the scenarios and utterances to record.

**`--apply`**: rewrites the numeric literal of each moved key inside
`DEFAULT_THRESHOLDS` in `src/core/thresholds.ts` by a targeted text edit
(the key's line is matched; comments and untouched keys are byte-identical
afterwards; the file is re-imported and checked to equal the recommended
set), and writes `docs/tuning/<YYYY-MM-DD>-sweep.md` containing the tables
above plus the before/after scores and the cassette's request count. The
report file is named by the real calendar date (it is provenance, not a
fixture); the runs inside it still use the fixed regression date.

**`--json`**: `{ before, after, moves, table, cliffs, insensitive, misses }`.

Exit code 0 whether or not moves were found; non-zero only on a startup
error (no cassette, bad `--only` name) or when `--apply`'s re-import check
fails.

## 9. Module layout

| Path | Responsibility |
| --- | --- |
| `src/harness-text/sweepSpace.ts` | sweepable names, grids, constraints, `isAllowed(candidate)` |
| `src/harness-text/sweepScore.ts` | `scoreOutcomes(baseline, actual)` from outcomes and trace records: the four counts and the miss list; pure |
| `src/harness-text/sweepSearch.ts` | `plateau(gridScores)`, `chooseMove(...)`, `coordinateDescent(evaluate, space, start, passes)`; pure, takes an `evaluate(candidate)` callback |
| `src/harness-text/sweepApply.ts` | `rewriteThresholds(source, values)` pure text transform; `renderReport(result)`; `renderTable(result)` |
| `src/harness-text/sweep.ts` | CLI: wiring, clients, the evaluate callback, file writes |

The evaluate callback reuses `runCorpusEntry`, `runScenario`,
`loadScenarios`, `loadCorpus`, `buildClient`, `readExpected`-style loading
(exported from `regress.ts` or moved to a small shared module if it is not
already exported), and `diff` from `regressDiff.ts` for the stub invariant.

## 10. Testing

- `sweepSpace.test.ts`: grid sizes; each constraint accepts and rejects a
  case; `--only` names validated.
- `sweepScore.test.ts`: decision versus cosmetic classification; a missed
  scenario is excluded from both scores and listed; the stub-invariant
  rejection.
- `sweepSearch.test.ts`: plateau selection (single plateau, tied plateaus
  preferring the current value, even-length middle); cliff never chosen;
  the three move rules and the no-move case; descent terminates and
  applies moves in order with an evaluate stub that returns canned scores.
- `sweepApply.test.ts`: rewriting one and several keys leaves every other
  byte unchanged and produces a file whose re-import equals the values; the
  report renders the strip with the expected characters.
- `sweep.test.ts`: end to end against a temporary cassette and baseline of
  three entries, asserting the recommended value and the flips.
- Manual: `pnpm sweep` on the real cassette; read the table; `--apply`;
  `pnpm test` and `pnpm regress` green (the stub invariant guarantees the
  latter); commit thresholds and the report.

## 11. README

Regression section gains a "Tuning" paragraph: what `pnpm sweep` does, the
scoring, the plateau rule, the cliff and insensitive lists, `--apply`, and
the record-then-confirm loop.
