# Threshold Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm sweep` searches the placeholder thresholds offline against the recorded cassette for the set that makes real answers reproduce the label baseline's decisions most often, explains every move by the entries it flips, and writes the result into `thresholds.ts` with a report.

**Architecture:** The regression runner's loop and baseline loading move into small shared modules. Four pure modules do the work: the sweep space (names, grids, constraints), scoring (decision versus cosmetic fields, misses, the stub invariant), search (plateaus, move rules, coordinate descent over an `evaluate` callback), and apply (targeted file rewrite, table and report rendering). A thin CLI wires them to the cassette.

**Tech Stack:** TypeScript strict ESM, pnpm, vitest, `node:util` parseArgs. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-19-threshold-sweep-design.md`. Read it first. The plan wins on small conflicts; each is marked "Deviation:".

**Conventions for every task:**

- Tests colocated as `*.test.ts`; run one with `pnpm vitest run <path>`, all with `pnpm test`; typecheck with `pnpm typecheck`.
- Extensionless imports; strict TS; `noUncheckedIndexedAccess` is on.
- Commit after every task with the message shown, one task per commit, exactly one writer at a time; every commit message ends with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never set, read, or print `TYPESAFE_API_KEY`; never run `--client jev` or `--client record`. `pnpm sweep` and `pnpm regress --client recorded` are offline and allowed.
- `src/core`, `src/domain`, `src/jev`, `src/prompts`, `src/server` are not modified, except `src/core/thresholds.ts` values in Task 9.
- Temp files in tests go under `mkdtempSync(join(tmpdir(), 'sweep-'))` and are removed in `afterEach`.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/harness-text/baseline.ts` | `REGRESS_TODAY`, `EXPECTED_DIR`, `ScenarioOutcome`, `readExpected`, `writeExpected` (moved out of `regress.ts`) |
| `src/harness-text/runAll.ts` | `runAll(corpus, scenarios, opts, hooks?, into?)`: the corpus-then-scenarios loop, collecting outcomes and trace records |
| `src/harness-text/regress.ts` | uses the two modules above; behavior unchanged |
| `src/harness-text/sweepSpace.ts` | sweepable names, grids, constraints, `violated`, `parseOnly` |
| `src/harness-text/sweepScore.ts` | `scoreOutcomes`, `better`, `flips`, field lists |
| `src/harness-text/sweepSearch.ts` | `bestPlateau`, `chooseMove`, `coordinateDescent` |
| `src/harness-text/sweepApply.ts` | `rewriteThresholds`, `renderStrip`, `renderTable`, `renderMoves`, `renderReport` |
| `src/harness-text/sweep.ts` | `runSweep(config)` and the CLI |
| `package.json` | `"sweep": "tsx src/harness-text/sweep.ts"` |
| `fixtures/corpus.jsonl`, `fixtures/expected/*` | the one label change (§7) and its baseline |
| `src/core/thresholds.ts`, `docs/tuning/<date>-sweep.md` | the applied result (Task 9) |
| `README.md` | Tuning paragraph |

---

### Task 1: Extract the regression loop and baseline loading

**Files:**
- Create: `src/harness-text/baseline.ts`, `src/harness-text/runAll.ts`, `src/harness-text/runAll.test.ts`
- Modify: `src/harness-text/regress.ts`

No behavior change: `pnpm regress` output must be byte-identical before and after.

- [ ] **Step 1: Write the failing test**

Create `src/harness-text/runAll.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runAll } from './runAll';
import { loadCorpus } from '../jev/corpus';
import { loadScenarios } from './runner';
import { buildClient, buildThresholds, DEFAULT_CORPUS_FILE } from '../run/client';
import { REGRESS_TODAY } from './baseline';

describe('runAll', () => {
  it('runs corpus entries then scenarios, collecting outcomes and every trace record', async () => {
    const thresholds = buildThresholds([]);
    const corpus = loadCorpus(DEFAULT_CORPUS_FILE).slice(0, 3);
    const scenarios = loadScenarios('fixtures/scenarios').slice(0, 2);
    const seen: string[] = [];
    const r = await runAll(corpus, scenarios, { client: buildClient('stub', DEFAULT_CORPUS_FILE, thresholds), thresholds, todayIso: REGRESS_TODAY, now: () => 0 }, {
      onCorpus: (done, total, entry) => seen.push(`c${done}/${total}:${entry.id}`),
      onScenario: (done, total, scenario) => seen.push(`s${done}/${total}:${scenario.id}`),
    });
    expect(Object.keys(r.corpus)).toEqual(corpus.map((e) => e.id));
    expect(Object.keys(r.scenarios)).toEqual(scenarios.map((s) => s.id));
    expect(seen).toEqual([...corpus.map((e, i) => `c${i + 1}/3:${e.id}`), ...scenarios.map((s, i) => `s${i + 1}/2:${s.id}`)]);
    expect(Object.keys(r.scenarioRecords)).toEqual(scenarios.map((s) => s.id));
    // A keypad step is one frame per digit, so records per scenario is at least steps plus the setup turn.
    for (const s of scenarios) expect(r.scenarioRecords[s.id]!.length).toBeGreaterThanOrEqual(s.steps.length + 1);
    expect(r.records.length).toBe(3 + Object.values(r.scenarioRecords).flat().length);
    expect(typeof r.scenarios[scenarios[0]!.id]!.pass).toBe('boolean');
  });

  it('writes into a caller-provided accumulator so an aborted run keeps partial results', async () => {
    const thresholds = buildThresholds([]);
    const corpus = loadCorpus(DEFAULT_CORPUS_FILE).slice(0, 2);
    const into = { corpus: {}, scenarios: {}, corpusRecords: {}, scenarioRecords: {}, records: [] };
    await expect(runAll(corpus, [], { client: buildClient('stub', DEFAULT_CORPUS_FILE, thresholds), thresholds, todayIso: REGRESS_TODAY, now: () => 0 }, {
      onCorpus: (done) => { if (done === 1) throw new Error('stop'); },
    }, into)).rejects.toThrow('stop');
    expect(Object.keys(into.corpus)).toEqual([corpus[0]!.id]);
  });
});
```

`runScenario` returns one `TurnRun` per frame (setup, each say, each keypad digit), which is why the test bounds the per-scenario count from below and derives the total from the per-scenario lists rather than from step counts.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/harness-text/runAll.test.ts`
Expected: FAIL, cannot resolve `./runAll` / `./baseline`.

- [ ] **Step 3: Implement baseline.ts**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Outcome } from './runner';

/** Fixed so recorded outcomes never depend on the wall clock. */
export const REGRESS_TODAY = '2026-09-18';
export const EXPECTED_DIR = 'fixtures/expected';

export type ScenarioOutcome = Outcome & { pass: boolean; mismatches: string[] };

export interface Baseline {
  corpus: Record<string, Outcome>;
  scenarios: Record<string, ScenarioOutcome>;
}

export function readExpected<T>(file: string, dir: string = EXPECTED_DIR): Record<string, T> {
  const path = `${dir}/${file}`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, T>) : {};
}

export function readBaseline(dir: string = EXPECTED_DIR): Baseline {
  return { corpus: readExpected<Outcome>('corpus.json', dir), scenarios: readExpected<ScenarioOutcome>('scenarios.json', dir) };
}

export function writeExpected(baseline: Baseline, dir: string = EXPECTED_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/corpus.json`, JSON.stringify(baseline.corpus, null, 2) + '\n');
  writeFileSync(`${dir}/scenarios.json`, JSON.stringify(baseline.scenarios, null, 2) + '\n');
}
```

- [ ] **Step 4: Implement runAll.ts**

```ts
import type { CorpusEntry } from '../jev/corpus';
import type { TraceRecord } from '../trace/types';
import type { ScenarioOutcome } from './baseline';
import { runCorpusEntry, runScenario, type Outcome, type RunOptions, type Scenario } from './runner';

export interface RunAllResult {
  corpus: Record<string, Outcome>;
  scenarios: Record<string, ScenarioOutcome>;
  /** the utterance turn's record per corpus entry */
  corpusRecords: Record<string, TraceRecord>;
  /** every turn's record per scenario, setup included */
  scenarioRecords: Record<string, TraceRecord[]>;
  /** all of the above in run order */
  records: TraceRecord[];
}

export interface RunAllHooks {
  onCorpus?(done: number, total: number, entry: CorpusEntry, record: TraceRecord): void;
  onScenario?(done: number, total: number, scenario: Scenario, records: TraceRecord[]): void;
}

export function emptyRunAll(): RunAllResult {
  return { corpus: {}, scenarios: {}, corpusRecords: {}, scenarioRecords: {}, records: [] };
}

/**
 * Corpus entries in file order, then scenarios in file order, exactly as the regression
 * runner and the cassette expect. Results accumulate into `into` as they arrive so a hook
 * that throws (a live-run abort) leaves the caller holding everything that ran.
 */
export async function runAll(corpus: CorpusEntry[], scenarios: Scenario[], opts: RunOptions, hooks: RunAllHooks = {}, into: RunAllResult = emptyRunAll()): Promise<RunAllResult> {
  let done = 0;
  for (const entry of corpus) {
    const r = await runCorpusEntry(entry, opts);
    into.corpus[entry.id] = r.outcome;
    into.corpusRecords[entry.id] = r.run.record;
    into.records.push(r.run.record);
    done += 1;
    hooks.onCorpus?.(done, corpus.length, entry, r.run.record);
  }
  done = 0;
  for (const scenario of scenarios) {
    const r = await runScenario(scenario, opts);
    const records = r.runs.map((run) => run.record);
    into.scenarios[scenario.id] = { ...r.outcome, pass: r.pass, mismatches: r.mismatches };
    into.scenarioRecords[scenario.id] = records;
    into.records.push(...records);
    done += 1;
    hooks.onScenario?.(done, scenarios.length, scenario, records);
  }
  return into;
}
```

- [ ] **Step 5: Rewire regress.ts**

Delete its local `REGRESS_TODAY`, `EXPECTED_DIR`, `ScenarioOutcome`, `Recorded`, and `readExpected`; import `REGRESS_TODAY`, `readBaseline`, `writeExpected`, `type ScenarioOutcome` from `./baseline` and `emptyRunAll`, `runAll` from `./runAll`. Keep `export const REGRESS_TODAY` available to existing importers by re-exporting: `export { REGRESS_TODAY } from './baseline';`. Replace the two loops with:

```ts
  const expected = readBaseline();
  const actual = emptyRunAll();
  try {
    await runAll(corpus, scenarioDefs, opts, {
      onCorpus: (done, total, _entry, record) => {
        checkClientError(record);
        if (live && done % PROGRESS_EVERY === 0) console.error(`  corpus ${done}/${total}`);
      },
      onScenario: (done, total, scenario, records) => {
        for (const record of records) checkClientError(record);
        if (live) console.error(`  scenario ${done}/${total} ${scenario.id}`);
      },
    }, actual);

    if (args.update) {
      writeExpected({ corpus: actual.corpus, scenarios: actual.scenarios });
      console.log(`recorded ${Object.keys(actual.corpus).length} corpus outcomes and ${Object.keys(actual.scenarios).length} scenario outcomes`);
      return;
    }
    ...
```

and use `expected.corpus` / `expected.scenarios` and `actual.records` where the old names were. Keep the `finally` block's semantics.

- [ ] **Step 6: Verify no behavior change**

Run: `pnpm vitest run src/harness-text`, `pnpm typecheck`, `pnpm test`, then `pnpm regress > /private/tmp/after.txt; git stash; pnpm regress > /private/tmp/before.txt; git stash pop; diff /private/tmp/before.txt /private/tmp/after.txt && echo identical`, and `pnpm regress --client recorded | tail -5` (same totals as before: 159/166, 44/45). If `git stash` is refused by the environment, compare against the committed output in your report instead and say so.

- [ ] **Step 7: Commit**

```bash
git add src/harness-text/baseline.ts src/harness-text/runAll.ts src/harness-text/runAll.test.ts src/harness-text/regress.ts
git commit -m "refactor(harness): share the regression loop and baseline loading

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The noise label change

**Files:**
- Modify: `fixtures/corpus.jsonl` (`ns-03`, `ns-04`), `fixtures/expected/corpus.json`, `fixtures/expected/scenarios.json`

- [ ] **Step 1: Relabel**

`ns-03`: `"answers":{"intelligible":{"noul":0.3},"addressedToSystem":{"noul":0.5}}`. `ns-04`: `"answers":{"intelligible":{"noul":0.2},"addressedToSystem":{"noul":0.5}}`. Nothing else on either line changes.

- [ ] **Step 2: Re-record and verify**

Run: `pnpm regress` and confirm the only diff lines are `ns-03` and `ns-04` moving to `decision: "ignore"`, `promptId: null`, `decidedGate: "addressedToSystem"`, `verdict: "ignore"`. Then `pnpm regress --update`, `pnpm regress` (no changes), `pnpm test` (green), and `pnpm regress --client recorded | tail -5` (expect corpus 161/166: the two noise entries now match).

- [ ] **Step 3: Commit**

```bash
git add fixtures/corpus.jsonl fixtures/expected/corpus.json fixtures/expected/scenarios.json
git commit -m "fixtures: background noise is ignored, not re-prompted

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Sweep space

**Files:**
- Create: `src/harness-text/sweepSpace.ts`, `src/harness-text/sweepSpace.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { CONSTRAINTS, gridFor, parseOnly, SWEEPABLE, violated } from './sweepSpace';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

describe('sweep space', () => {
  it('lists the twenty sweepable thresholds and no fixed ones', () => {
    expect(SWEEPABLE).toHaveLength(20);
    expect(SWEEPABLE).not.toContain('MAX_ATTEMPTS');
    expect(SWEEPABLE).not.toContain('STUB_SHARPNESS');
    expect(SWEEPABLE).not.toContain('JEV_TIMEOUT_MS');
  });

  it('grids probabilities 0.05..0.95 and margins 0.05..0.40 in 0.05 steps', () => {
    expect(gridFor('INTENT_ROUTE')).toHaveLength(19);
    expect(gridFor('INTENT_ROUTE')[0]).toBe(0.05);
    expect(gridFor('INTENT_ROUTE')[18]).toBe(0.95);
    expect(gridFor('GATE_INTENT_MARGIN')).toEqual([0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]);
  });

  it('accepts the defaults and names the first violated constraint', () => {
    expect(violated({ ...DEFAULT_THRESHOLDS })).toBeNull();
    expect(violated({ ...DEFAULT_THRESHOLDS, INTENT_IMPLICIT: 0.9 })).toBe('INTENT_IMPLICIT <= INTENT_ROUTE');
    expect(violated({ ...DEFAULT_THRESHOLDS, INTENT_EXPLICIT: 0.7 })).toBe('INTENT_EXPLICIT <= INTENT_IMPLICIT');
    expect(violated({ ...DEFAULT_THRESHOLDS, INTENT_SWITCH: 0.5 })).toBe('INTENT_IMPLICIT <= INTENT_SWITCH');
    expect(violated({ ...DEFAULT_THRESHOLDS, SLOT_CHOICE_FILL: 0.4 })).toBe('SLOT_CHOICE_CONFIRM <= SLOT_CHOICE_FILL');
    expect(CONSTRAINTS).toHaveLength(4);
  });

  it('parses --only and rejects unknown or fixed names', () => {
    expect(parseOnly(undefined)).toEqual(SWEEPABLE);
    expect(parseOnly('INTENT_ROUTE, SLOT_CHOICE_FILL')).toEqual(['INTENT_ROUTE', 'SLOT_CHOICE_FILL']);
    expect(() => parseOnly('MAX_ATTEMPTS')).toThrow(/not sweepable/);
    expect(() => parseOnly('NOPE')).toThrow(/not sweepable/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**, then implement:

```ts
import type { ThresholdName, Thresholds } from '../core/thresholds';

export const SWEEPABLE: readonly ThresholdName[] = [
  'GATE_ADDRESSED', 'GATE_INTELLIGIBLE', 'GATE_COMPLETE', 'GATE_WANTS_HUMAN',
  'INTENT_ROUTE', 'INTENT_IMPLICIT', 'INTENT_EXPLICIT', 'INTENT_SWITCH', 'GATE_INTENT_MARGIN', 'GATE_FRUSTRATION_HIGH',
  'INTENT_TENTATIVE', 'INTENT_CHANGE', 'PROVIDER_UNSURE',
  'SLOT_DETECT', 'SLOT_CHOICE_FILL', 'SLOT_CHOICE_CONFIRM', 'SLOT_CHOICE_MARGIN',
  'CONFIRM_YES', 'CONFIRM_NO', 'MENU_NUMBER',
];

const MARGINS: ReadonlySet<ThresholdName> = new Set(['GATE_INTENT_MARGIN', 'SLOT_CHOICE_MARGIN']);

function range(lo: number, hi: number, step: number): number[] {
  const n = Math.round((hi - lo) / step) + 1;
  return Array.from({ length: n }, (_, i) => Math.round((lo + i * step) * 100) / 100);
}

export const PROBABILITY_GRID: readonly number[] = range(0.05, 0.95, 0.05);
export const MARGIN_GRID: readonly number[] = range(0.05, 0.4, 0.05);

export function gridFor(name: ThresholdName): readonly number[] {
  return MARGINS.has(name) ? MARGIN_GRID : PROBABILITY_GRID;
}

/** lower <= upper, in the order the bands are read. */
export const CONSTRAINTS: ReadonlyArray<{ lower: ThresholdName; upper: ThresholdName }> = [
  { lower: 'INTENT_EXPLICIT', upper: 'INTENT_IMPLICIT' },
  { lower: 'INTENT_IMPLICIT', upper: 'INTENT_ROUTE' },
  { lower: 'INTENT_IMPLICIT', upper: 'INTENT_SWITCH' },
  { lower: 'SLOT_CHOICE_CONFIRM', upper: 'SLOT_CHOICE_FILL' },
];

/** The first violated constraint as "A <= B", or null when the set is allowed. */
export function violated(t: Thresholds): string | null {
  for (const c of CONSTRAINTS) if (t[c.lower] > t[c.upper]) return `${c.lower} <= ${c.upper}`;
  return null;
}

export function isSweepable(name: string): name is ThresholdName {
  return (SWEEPABLE as readonly string[]).includes(name);
}

export function parseOnly(spec: string | undefined): ThresholdName[] {
  if (spec === undefined || spec.trim() === '') return [...SWEEPABLE];
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((name) => {
    if (!isSweepable(name)) throw new Error(`${name} is not sweepable; choose from ${SWEEPABLE.join(', ')}`);
    return name;
  });
}
```

- [ ] **Step 3: Run, typecheck, commit**

```bash
git add src/harness-text/sweepSpace.ts src/harness-text/sweepSpace.test.ts
git commit -m "feat(harness): sweep space: sweepable thresholds, grids, constraints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Scoring

**Files:**
- Create: `src/harness-text/sweepScore.ts`, `src/harness-text/sweepScore.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { better, flips, scoreOutcomes, type ScoreInput } from './sweepScore';
import type { Outcome } from './runner';
import type { ScenarioOutcome } from './baseline';
import type { TraceRecord } from '../trace/types';
import { CASSETTE_MISS } from '../jev/cassette';

function outcome(id: string, over: Partial<Outcome> = {}): Outcome {
  return { id, decision: 'prompt', promptId: 'ask_memberId', acks: [], reason: null, decidedGate: 'intent', verdict: 'route', form: 'cancel', slots: { memberId: null, provider: null, date: null }, queued: [], ...over };
}
function scenario(id: string, pass: boolean, over: Partial<Outcome> = {}): ScenarioOutcome {
  return { ...outcome(id, over), pass, mismatches: pass ? [] : ['x'] };
}
function record(errorMessage: string | null, text = 'hello'): Pick<TraceRecord, 'error' | 'event' | 'source'> {
  return { error: errorMessage ? { name: 'JevClientError', message: errorMessage } : null, event: { type: 'prompt', voicePrompt: text, lang: 'en-US', last: true }, source: errorMessage ? 'error' : 'recorded' };
}

const base: ScoreInput = {
  expectedCorpus: { a: outcome('a'), b: outcome('b'), c: outcome('c', { form: 'reschedule', promptId: 'ask_memberId' }) },
  expectedScenarios: { s1: scenario('s1', true), s2: scenario('s2', true) },
  actualCorpus: { a: outcome('a'), b: outcome('b', { acks: ['ack_intent'] }), c: outcome('c', { form: 'cancel' }) },
  actualScenarios: { s1: scenario('s1', true, { decidedGate: 'confirmation' }), s2: scenario('s2', false) },
  scenarioRecords: { s1: [record(null)], s2: [record(null)] },
};

describe('scoreOutcomes', () => {
  it('counts decision matches, scenario passes, and cosmetic matches separately', () => {
    const s = scoreOutcomes(base);
    expect(s.corpusMatch).toBe(2);           // a and b (b differs only in acks)
    expect(s.scenarioPass).toBe(1);          // s1
    expect(s.cosmeticMatch).toBe(1);         // a only (b has an extra ack, s1 a different gate, s2 fails)
    expect(s.primary).toBe(3);
    expect(s.secondary).toBe(1);
    expect([...s.matched].sort()).toEqual(['a', 'b', 's1']);
    expect(s.misses).toEqual([]);
  });

  it('excludes a missed scenario from both scores and lists its utterance', () => {
    const s = scoreOutcomes({ ...base, scenarioRecords: { s1: [record(null), record(`${CASSETTE_MISS} abc four four`, 'four four')], s2: [record(null)] } });
    expect(s.scenarioPass).toBe(0);
    expect(s.cosmeticMatch).toBe(1);
    expect(s.misses).toEqual([{ id: 's1', text: 'four four' }]);
    expect(s.matched.has('s1')).toBe(false);
  });

  it('orders by primary then secondary', () => {
    const lo = scoreOutcomes(base);
    const hi = scoreOutcomes({ ...base, actualCorpus: { ...base.actualCorpus, c: outcome('c', { form: 'reschedule' }) } });
    expect(better(hi, lo)).toBe(true);
    expect(better(lo, hi)).toBe(false);
    const tidier = scoreOutcomes({ ...base, actualCorpus: { ...base.actualCorpus, b: outcome('b') } });
    expect(better(tidier, lo)).toBe(true);
    expect(better(lo, lo)).toBe(false);
  });

  it('reports flips as ids gained and lost', () => {
    const before = scoreOutcomes(base);
    const after = scoreOutcomes({ ...base, actualCorpus: { ...base.actualCorpus, a: outcome('a', { form: 'billing' }), c: outcome('c', { form: 'reschedule' }) } });
    expect(flips(before, after)).toEqual({ gained: ['c'], lost: ['a'] });
  });
});
```

- [ ] **Step 2: Run to verify they fail**, then implement:

```ts
import { CASSETTE_MISS } from '../jev/cassette';
import type { TraceRecord } from '../trace/types';
import type { Outcome } from './runner';
import type { ScenarioOutcome } from './baseline';

/** What the caller experiences; a mismatch here is a wrong decision. */
export const DECISION_FIELDS = ['decision', 'promptId', 'reason', 'form', 'slots'] as const;
/** How the decision was reached or dressed; a mismatch here is a tiebreak. */
export const COSMETIC_FIELDS = ['acks', 'decidedGate', 'verdict', 'queued'] as const;

type Row = Pick<TraceRecord, 'error' | 'event' | 'source'>;

export interface ScoreInput {
  expectedCorpus: Record<string, Outcome>;
  expectedScenarios: Record<string, ScenarioOutcome>;
  actualCorpus: Record<string, Outcome>;
  actualScenarios: Record<string, ScenarioOutcome>;
  scenarioRecords: Record<string, Row[]>;
}

export interface Score {
  primary: number;
  secondary: number;
  corpusMatch: number;
  scenarioPass: number;
  cosmeticMatch: number;
  /** ids counted in `primary`: corpus entries whose decision fields match, scenarios that pass */
  matched: Set<string>;
  misses: Array<{ id: string; text: string }>;
}

function same(a: object | undefined, b: object | undefined, fields: readonly string[]): boolean {
  if (!a || !b) return false;
  return fields.every((f) => JSON.stringify((a as Record<string, unknown>)[f]) === JSON.stringify((b as Record<string, unknown>)[f]));
}

/** The utterance of the first turn that missed the cassette, or null. */
export function missedUtterance(records: Row[]): string | null {
  for (const r of records) {
    if (r.error && r.error.message.startsWith(CASSETTE_MISS)) return r.event.type === 'prompt' ? r.event.voicePrompt : '';
  }
  return null;
}

export function scoreOutcomes(i: ScoreInput): Score {
  const matched = new Set<string>();
  let corpusMatch = 0;
  let cosmeticMatch = 0;
  for (const id of Object.keys(i.expectedCorpus)) {
    const e = i.expectedCorpus[id];
    const a = i.actualCorpus[id];
    if (same(e, a, DECISION_FIELDS)) {
      corpusMatch += 1;
      matched.add(id);
      if (same(e, a, COSMETIC_FIELDS)) cosmeticMatch += 1;
    }
  }
  let scenarioPass = 0;
  const misses: Score['misses'] = [];
  for (const id of Object.keys(i.expectedScenarios)) {
    const a = i.actualScenarios[id];
    const missed = missedUtterance(i.scenarioRecords[id] ?? []);
    if (missed !== null) { misses.push({ id, text: missed }); continue; }
    if (a?.pass) {
      scenarioPass += 1;
      matched.add(id);
      if (same(i.expectedScenarios[id], a, COSMETIC_FIELDS)) cosmeticMatch += 1;
    }
  }
  return { primary: corpusMatch + scenarioPass, secondary: cosmeticMatch, corpusMatch, scenarioPass, cosmeticMatch, matched, misses };
}

export function better(a: Score, b: Score): boolean {
  return a.primary > b.primary || (a.primary === b.primary && a.secondary > b.secondary);
}

export function equal(a: Score, b: Score): boolean {
  return a.primary === b.primary && a.secondary === b.secondary;
}

export function flips(before: Score, after: Score): { gained: string[]; lost: string[] } {
  return {
    gained: [...after.matched].filter((id) => !before.matched.has(id)).sort(),
    lost: [...before.matched].filter((id) => !after.matched.has(id)).sort(),
  };
}
```

Note `cosmeticMatch` for a scenario compares the scenario's own recorded outcome fields (`acks`, `decidedGate`, `verdict`, `queued`) to the baseline's; a passing scenario with a different deciding gate is a primary match and a cosmetic mismatch, as the test pins.

- [ ] **Step 3: Run, typecheck, commit**

```bash
git add src/harness-text/sweepScore.ts src/harness-text/sweepScore.test.ts
git commit -m "feat(harness): sweep scoring: decision fields, cosmetic tiebreak, cassette misses

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Search

**Files:**
- Create: `src/harness-text/sweepSearch.ts`, `src/harness-text/sweepSearch.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { bestPlateau, chooseMove, coordinateDescent, type GridPoint } from './sweepSearch';
import type { Score } from './sweepScore';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../core/thresholds';

function score(primary: number, secondary = 0, matched: string[] = []): Score {
  return { primary, secondary, corpusMatch: primary, scenarioPass: 0, cosmeticMatch: secondary, matched: new Set(matched), misses: [] };
}
function points(values: number[], primaries: Array<number | 'x' | '!'>, secondaries: number[] = []): GridPoint[] {
  return values.map((value, i) => {
    const p = primaries[i]!;
    if (p === 'x') return { value, status: 'skipped', score: null };
    if (p === '!') return { value, status: 'breaks_stub', score: null };
    return { value, status: 'scored', score: score(p, secondaries[i] ?? 0) };
  });
}
const grid = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];

describe('bestPlateau', () => {
  it('picks the longest run at the best score', () => {
    const p = points(grid, [1, 3, 3, 3, 2, 3, 1]);
    expect(bestPlateau(p, 0)).toEqual({ start: 1, end: 3 });
  });
  it('prefers the run containing the current index, then the nearest', () => {
    const p = points(grid, [3, 3, 1, 3, 3, 1, 1]);
    expect(bestPlateau(p, 4)).toEqual({ start: 3, end: 4 });
    expect(bestPlateau(p, 6)).toEqual({ start: 3, end: 4 });
    expect(bestPlateau(p, 0)).toEqual({ start: 0, end: 1 });
  });
  it('ignores skipped and stub-breaking points and breaks primary ties by secondary', () => {
    const p = points(grid, ['x', 3, 3, '!', 3, 3, 3], [0, 1, 1, 0, 0, 0, 0]);
    expect(bestPlateau(p, 1)).toEqual({ start: 1, end: 2 });
  });
  it('returns null when nothing scored', () => {
    expect(bestPlateau(points(grid, ['x', 'x', '!', 'x', 'x', 'x', 'x']), 0)).toBeNull();
  });
});

describe('chooseMove', () => {
  const current = score(2);
  it('moves to the plateau middle when primary improves, lower-middle on an even run', () => {
    const r = chooseMove('INTENT_ROUTE', 0.7, points(grid, [1, 3, 3, 3, 3, 2, 2]), current);
    expect(r.move).toMatchObject({ from: 0.7, to: 0.3, reason: 'primary' });
    expect(r.cliff).toBe(false);
  });
  it('moves on a secondary improvement at equal primary', () => {
    const r = chooseMove('INTENT_ROUTE', 0.7, points(grid, [2, 2, 2, 2, 2, 2, 2], [0, 1, 1, 1, 0, 0, 0]), current);
    expect(r.move).toMatchObject({ to: 0.3, reason: 'secondary' });
  });
  it('moves an edge value to the plateau center at equal scores', () => {
    const r = chooseMove('INTENT_ROUTE', 0.5, points(grid, [1, 1, 2, 2, 2, 1, 1]), current);
    expect(r.move).toMatchObject({ from: 0.5, to: 0.4, reason: 'center' });
  });
  it('does not move from a plateau center or a two-point plateau', () => {
    expect(chooseMove('INTENT_ROUTE', 0.4, points(grid, [1, 1, 2, 2, 2, 1, 1]), current).move).toBeNull();
    expect(chooseMove('INTENT_ROUTE', 0.4, points(grid, [1, 1, 2, 2, 1, 1, 1]), current).move).toBeNull();
  });
  it('never moves to a cliff and reports it', () => {
    const r = chooseMove('INTENT_ROUTE', 0.7, points(grid, [1, 1, 1, 5, 1, 2, 2]), current);
    expect(r.move).toBeNull();
    expect(r.cliff).toBe(true);
  });
  it('flags an insensitive threshold and does not move it', () => {
    const r = chooseMove('INTENT_ROUTE', 0.1, points(grid, [2, 2, 2, 2, 2, 2, 2]), current);
    expect(r.move).toBeNull();
    expect(r.insensitive).toBe(true);
  });
});

describe('coordinateDescent', () => {
  it('applies moves in order across passes until nothing changes', async () => {
    // Two unconstrained thresholds with optima at 0.5 and 0.6. Dividing the distance by 3 before
    // rounding makes each best score a five-point plateau, so the plateau-center rule lands
    // exactly on the optimum rather than refusing a one-point cliff.
    const evaluate = async (t: Thresholds) => {
      const primary = 10 - Math.round((Math.abs(t.GATE_ADDRESSED - 0.5) * 10) / 3) - Math.round((Math.abs(t.MENU_NUMBER - 0.6) * 10) / 3);
      return { score: score(primary), breaksStub: t.GATE_ADDRESSED > 0.9 };
    };
    const calls: string[] = [];
    const r = await coordinateDescent(evaluate, ['GATE_ADDRESSED', 'MENU_NUMBER'], { ...DEFAULT_THRESHOLDS }, 5, (name) => calls.push(name));
    expect(r.final.GATE_ADDRESSED).toBeCloseTo(0.5);
    expect(r.final.MENU_NUMBER).toBeCloseTo(0.6);
    expect(r.moves.map((m) => [m.name, m.reason])).toEqual([['GATE_ADDRESSED', 'primary'], ['MENU_NUMBER', 'center']]);
    expect(r.passes).toBe(2);
    expect(r.table.GATE_ADDRESSED?.points.some((p) => p.status === 'breaks_stub')).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});
```

Walk-through: at the start (0.7 / 0.7) the score is 9. `GATE_ADDRESSED` scores 10 on `[0.40, 0.60]`, so it moves to 0.50 on `primary`. `MENU_NUMBER` then scores 10 on `[0.50, 0.70]` with the current 0.70 on the plateau's edge, so it moves to the center 0.60 on `center`. The second pass finds nothing.

- [ ] **Step 2: Run to verify they fail**, then implement:

```ts
import type { ThresholdName, Thresholds } from '../core/thresholds';
import { better, equal, flips, type Score } from './sweepScore';
import { gridFor, violated } from './sweepSpace';

export interface GridPoint {
  value: number;
  status: 'scored' | 'skipped' | 'breaks_stub';
  score: Score | null;
}

export interface Plateau { start: number; end: number }

export type MoveReason = 'primary' | 'secondary' | 'center';

export interface Move {
  name: ThresholdName;
  from: number;
  to: number;
  reason: MoveReason;
  before: Score;
  after: Score;
  plateau: { from: number; to: number };
  flips: { gained: string[]; lost: string[] };
}

export interface ThresholdRow {
  current: number;
  recommended: number;
  points: GridPoint[];
  cliff: boolean;
  insensitive: boolean;
}

export interface SweepResult {
  start: Thresholds;
  final: Thresholds;
  before: Score;
  after: Score;
  moves: Move[];
  table: Partial<Record<ThresholdName, ThresholdRow>>;
  passes: number;
}

export type Evaluate = (candidate: Thresholds) => Promise<{ score: Score; breaksStub: boolean }>;

function scored(p: GridPoint): p is GridPoint & { score: Score } {
  return p.status === 'scored' && p.score !== null;
}

/** Longest contiguous run of scored points at the best score; ties prefer the run holding `currentIndex`, then the nearest. */
export function bestPlateau(points: GridPoint[], currentIndex: number): Plateau | null {
  let best: Score | null = null;
  for (const p of points) if (scored(p) && (best === null || better(p.score, best))) best = p.score;
  if (best === null) return null;
  const runs: Plateau[] = [];
  let start = -1;
  points.forEach((p, i) => {
    const at = scored(p) && equal(p.score, best!);
    if (at && start < 0) start = i;
    if (!at && start >= 0) { runs.push({ start, end: i - 1 }); start = -1; }
  });
  if (start >= 0) runs.push({ start, end: points.length - 1 });
  const longest = Math.max(...runs.map((r) => r.end - r.start));
  const candidates = runs.filter((r) => r.end - r.start === longest);
  const holding = candidates.find((r) => r.start <= currentIndex && currentIndex <= r.end);
  if (holding) return holding;
  const distance = (r: Plateau) => Math.min(Math.abs(r.start - currentIndex), Math.abs(r.end - currentIndex));
  return candidates.sort((a, b) => distance(a) - distance(b))[0]!;
}

function middle(p: Plateau): number {
  return p.start + Math.floor((p.end - p.start) / 2);
}

export function chooseMove(name: ThresholdName, current: number, points: GridPoint[], currentScore: Score): { move: Move | null; cliff: boolean; insensitive: boolean } {
  const currentIndex = points.findIndex((p) => Math.abs(p.value - current) < 1e-9);
  const plateau = bestPlateau(points, currentIndex);
  if (!plateau) return { move: null, cliff: false, insensitive: false };
  const scoredPoints = points.filter(scored);
  const insensitive = scoredPoints.every((p) => equal(p.score, scoredPoints[0]!.score));
  if (insensitive) return { move: null, cliff: false, insensitive: true };
  if (plateau.start === plateau.end) return { move: null, cliff: true, insensitive: false };
  const target = middle(plateau);
  const to = points[target]!;
  if (!scored(to) || Math.abs(to.value - current) < 1e-9) return { move: null, cliff: false, insensitive: false };
  let reason: MoveReason | null = null;
  if (to.score.primary > currentScore.primary) reason = 'primary';
  else if (to.score.primary === currentScore.primary && to.score.secondary > currentScore.secondary) reason = 'secondary';
  else if (equal(to.score, currentScore) && (currentIndex === plateau.start || currentIndex === plateau.end) && plateau.end - plateau.start >= 2) reason = 'center';
  if (!reason) return { move: null, cliff: false, insensitive: false };
  return {
    move: {
      name, from: current, to: to.value, reason, before: currentScore, after: to.score,
      plateau: { from: points[plateau.start]!.value, to: points[plateau.end]!.value },
      flips: flips(currentScore, to.score),
    },
    cliff: false, insensitive: false,
  };
}

export async function coordinateDescent(
  evaluate: Evaluate,
  names: readonly ThresholdName[],
  start: Thresholds,
  maxPasses: number,
  onProgress?: (name: ThresholdName, pass: number, index: number, total: number) => void,
): Promise<SweepResult> {
  const cache = new Map<string, { score: Score; breaksStub: boolean }>();
  const memo = async (t: Thresholds) => {
    const key = names.map((n) => `${n}=${t[n]}`).join(',') + '|' + JSON.stringify(t);
    let v = cache.get(key);
    if (!v) { v = await evaluate(t); cache.set(key, v); }
    return v;
  };
  let current: Thresholds = { ...start };
  const first = await memo(current);
  if (first.breaksStub) throw new Error('the starting thresholds break the stub baseline; run pnpm regress first');
  let currentScore = first.score;
  const moves: Move[] = [];
  const table: SweepResult['table'] = {};
  let passes = 0;
  for (let pass = 1; pass <= maxPasses; pass++) {
    passes = pass;
    let moved = false;
    for (const name of names) {
      const grid = gridFor(name);
      const points: GridPoint[] = [];
      for (const [i, value] of grid.entries()) {
        onProgress?.(name, pass, i + 1, grid.length);
        const candidate: Thresholds = { ...current, [name]: value };
        if (violated(candidate)) { points.push({ value, status: 'skipped', score: null }); continue; }
        const r = await memo(candidate);
        points.push(r.breaksStub ? { value, status: 'breaks_stub', score: null } : { value, status: 'scored', score: r.score });
      }
      const { move, cliff, insensitive } = chooseMove(name, current[name], points, currentScore);
      if (move) {
        moves.push(move);
        current = { ...current, [name]: move.to };
        currentScore = move.after;
        moved = true;
      }
      table[name] = { current: start[name], recommended: current[name], points, cliff, insensitive };
    }
    if (!moved) break;
  }
  return { start, final: current, before: first.score, after: currentScore, moves, table, passes };
}
```

Note the descent re-evaluates each threshold's grid on every pass against the then-current set; the table keeps the last pass's points so the strip shows the final neighborhood.

- [ ] **Step 3: Run, typecheck, commit**

```bash
git add src/harness-text/sweepSearch.ts src/harness-text/sweepSearch.test.ts
git commit -m "feat(harness): sweep search: plateaus, move rules, coordinate descent

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Apply and render

**Files:**
- Create: `src/harness-text/sweepApply.ts`, `src/harness-text/sweepApply.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderStrip, renderTable, renderMoves, renderReport, rewriteThresholds } from './sweepApply';
import type { GridPoint, SweepResult } from './sweepSearch';
import type { Score } from './sweepScore';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

function score(primary: number, secondary = 0): Score {
  return { primary, secondary, corpusMatch: primary, scenarioPass: 0, cosmeticMatch: secondary, matched: new Set(), misses: [] };
}

describe('rewriteThresholds', () => {
  const source = readFileSync('src/core/thresholds.ts', 'utf8');
  it('changes only the named values and leaves every other byte alone', () => {
    const out = rewriteThresholds(source, { INTENT_ROUTE: 0.8, SLOT_CHOICE_FILL: 0.65 });
    expect(out).toContain('  INTENT_ROUTE: 0.8,');
    expect(out).toContain('  SLOT_CHOICE_FILL: 0.65,');
    const strip = (s: string) => s.split('\n').filter((l) => !/^\s*(INTENT_ROUTE|SLOT_CHOICE_FILL):/.test(l)).join('\n');
    expect(strip(out)).toBe(strip(source));
    expect(out.split('\n').length).toBe(source.split('\n').length);
  });
  it('throws when a key is missing or duplicated', () => {
    expect(() => rewriteThresholds(source, { NOPE: 0.5 } as never)).toThrow(/NOPE/);
    expect(() => rewriteThresholds(source + '\n  INTENT_ROUTE: 0.1,', { INTENT_ROUTE: 0.5 })).toThrow(/once/);
  });
});

describe('render', () => {
  const points: GridPoint[] = [
    { value: 0.05, status: 'skipped', score: null },
    { value: 0.1, status: 'scored', score: score(3) },
    { value: 0.15, status: 'scored', score: score(4) },
    { value: 0.2, status: 'scored', score: score(5) },
    { value: 0.25, status: 'scored', score: score(5) },
    { value: 0.3, status: 'breaks_stub', score: null },
  ];
  it('renders the strip with one character per grid point', () => {
    expect(renderStrip(points)).toBe('x-+##!');
  });
  const result: SweepResult = {
    start: { ...DEFAULT_THRESHOLDS }, final: { ...DEFAULT_THRESHOLDS, INTENT_ROUTE: 0.2 },
    before: score(3), after: score(5),
    moves: [{ name: 'INTENT_ROUTE', from: 0.1, to: 0.2, reason: 'primary', before: score(3), after: score(5), plateau: { from: 0.2, to: 0.25 }, flips: { gained: ['lc-02', 's1'], lost: [] } }],
    table: { INTENT_ROUTE: { current: 0.1, recommended: 0.2, points, cliff: false, insensitive: false }, MENU_NUMBER: { current: 0.7, recommended: 0.7, points: points.map((p) => ({ ...p, status: 'scored', score: score(3) })), cliff: false, insensitive: true } },
    passes: 2,
  };
  it('renders the table, moves, and report', () => {
    const table = renderTable(result);
    expect(table).toMatch(/INTENT_ROUTE\s+0\.10\s+0\.20\s+5\s+x-\+##!/);
    expect(table).toMatch(/MENU_NUMBER.*insensitive/);
    const moves = renderMoves(result);
    expect(moves).toContain('INTENT_ROUTE 0.10 -> 0.20 (primary; plateau 0.20..0.25)');
    expect(moves).toContain('gained: lc-02, s1');
    const report = renderReport(result, { cassette: 'fixtures/recorded/jev-1.13.0.jsonl', requests: 223, date: '2026-09-19', misses: [{ id: 's9', text: 'four four' }] });
    expect(report).toContain('# Threshold sweep 2026-09-19');
    expect(report).toContain('before 3/0');
    expect(report).toContain('after 5/0');
    expect(report).toContain('s9: "four four"');
  });
});
```

- [ ] **Step 2: Run to verify they fail**, then implement:

```ts
import type { ThresholdName } from '../core/thresholds';
import { better, equal, type Score } from './sweepScore';
import type { GridPoint, SweepResult } from './sweepSearch';

/** Replace the numeric literal on each named key's line inside DEFAULT_THRESHOLDS; everything else is untouched. */
export function rewriteThresholds(source: string, values: Partial<Record<ThresholdName, number>>): string {
  let out = source;
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^(\\s*${key}:\\s*)([0-9.]+)(,)`, 'gm');
    const matches = out.match(re) ?? [];
    if (matches.length !== 1) throw new Error(`${key} must appear exactly once in DEFAULT_THRESHOLDS (found ${matches.length})`);
    out = out.replace(re, `$1${value}$3`);
  }
  return out;
}

function bestOf(points: GridPoint[]): Score | null {
  let best: Score | null = null;
  for (const p of points) if (p.status === 'scored' && p.score && (best === null || better(p.score, best))) best = p.score;
  return best;
}

/** One character per grid point: # best, + within one primary of best, - below, x constraint-skipped, ! breaks the stub. */
export function renderStrip(points: GridPoint[]): string {
  const best = bestOf(points);
  return points.map((p) => {
    if (p.status === 'skipped') return 'x';
    if (p.status === 'breaks_stub') return '!';
    if (!best || !p.score) return '?';
    if (equal(p.score, best)) return '#';
    return p.score.primary >= best.primary - 1 ? '+' : '-';
  }).join('');
}

const f = (n: number): string => n.toFixed(2);

export function renderTable(r: SweepResult): string {
  const names = Object.keys(r.table) as ThresholdName[];
  const w = Math.max(...names.map((n) => n.length), 9);
  const lines = [`${'threshold'.padEnd(w)}  current  recomm.  best  grid`];
  for (const name of names) {
    const row = r.table[name]!;
    const best = bestOf(row.points);
    const note = row.insensitive ? '  insensitive' : row.cliff ? '  cliff' : '';
    lines.push(`${name.padEnd(w)}  ${f(row.current).padStart(7)}  ${f(row.recommended).padStart(7)}  ${String(best?.primary ?? '-').padStart(4)}  ${renderStrip(row.points)}${note}`);
  }
  return lines.join('\n');
}

export function renderMoves(r: SweepResult): string {
  if (r.moves.length === 0) return 'no moves';
  return r.moves.map((m) => [
    `${m.name} ${f(m.from)} -> ${f(m.to)} (${m.reason}; plateau ${f(m.plateau.from)}..${f(m.plateau.to)}) ${m.before.primary}/${m.before.secondary} -> ${m.after.primary}/${m.after.secondary}`,
    m.flips.gained.length ? `  gained: ${m.flips.gained.join(', ')}` : null,
    m.flips.lost.length ? `  lost: ${m.flips.lost.join(', ')}` : null,
  ].filter(Boolean).join('\n')).join('\n');
}

export interface ReportMeta { cassette: string; requests: number; date: string; misses: Array<{ id: string; text: string }> }

export function renderReport(r: SweepResult, meta: ReportMeta): string {
  const cliffs = (Object.keys(r.table) as ThresholdName[]).filter((n) => r.table[n]!.cliff);
  const insensitive = (Object.keys(r.table) as ThresholdName[]).filter((n) => r.table[n]!.insensitive);
  return [
    `# Threshold sweep ${meta.date}`,
    '',
    `Cassette \`${meta.cassette}\` (${meta.requests} recorded requests). Scores are primary/secondary: corpus decisions matched plus scenarios passed / cosmetic matches.`,
    '',
    `before ${r.before.primary}/${r.before.secondary}`,
    `after ${r.after.primary}/${r.after.secondary}`,
    `passes ${r.passes}`,
    '',
    '## Moves', '', '```', renderMoves(r), '```', '',
    '## Sensitivity', '', '```', renderTable(r), '```', '',
    `Strip: # best, + within one of best, - below, x constraint-skipped, ! breaks the stub baseline.`, '',
    `## Cliffs (not applied)`, '', cliffs.length ? cliffs.map((n) => `- ${n}`).join('\n') : '- none', '',
    `## Insensitive on this corpus`, '', insensitive.length ? insensitive.map((n) => `- ${n}`).join('\n') : '- none', '',
    `## Cassette misses to record for the recommended set`, '',
    meta.misses.length ? meta.misses.map((m) => `- ${m.id}: "${m.text}"`).join('\n') : '- none', '',
  ].join('\n');
}
```

- [ ] **Step 3: Run, typecheck, commit**

```bash
git add src/harness-text/sweepApply.ts src/harness-text/sweepApply.test.ts
git commit -m "feat(harness): sweep apply: thresholds rewrite, sensitivity strip, report

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The sweep command and an end-to-end test

**Files:**
- Create: `src/harness-text/sweep.ts`, `src/harness-text/sweep.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing end-to-end test**

The test builds a tiny world in a temp dir: a three-entry corpus, no scenarios, a label baseline recorded from the stub at the default sharpness (0.9, so every intent routes silently), and a cassette recorded from the stub at sharpness 0.8 standing in for the real model (routes land in the implicit band, an extra ack). Sweeping `INTENT_ROUTE` alone must find that lowering it to the plateau `[0.60, 0.80]` removes the acks: a secondary-score move to 0.70, with all three ids gained on the cosmetic side but no primary flips.

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSweep } from './sweep';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { CassetteClient } from '../jev/cassette';
import { loadCorpus } from '../jev/corpus';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { runAll } from './runAll';
import { writeExpected, REGRESS_TODAY } from './baseline';

const CORPUS = [
  '{"id":"t-1","text":"please cancel my visit","intent":"cancel","context":"no_form"}',
  '{"id":"t-2","text":"I want to move my visit","intent":"reschedule","context":"no_form"}',
  '{"id":"t-3","text":"book me a new visit","intent":"schedule_new","context":"no_form"}',
].join('\n') + '\n';

describe('runSweep', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    writeFileSync(join(dir, 'corpus.jsonl'), CORPUS);
    mkdirSync(join(dir, 'scenarios'));
    writeFileSync(join(dir, 'scenarios', 'core.json'), '[]\n');
    const corpus = loadCorpus(join(dir, 'corpus.jsonl'));
    const thresholds = { ...DEFAULT_THRESHOLDS };
    const stub = new FixtureStubClient(corpus, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const base = await runAll(corpus, [], { client: stub, thresholds, todayIso: REGRESS_TODAY, now: () => 0 });
    writeExpected({ corpus: base.corpus, scenarios: base.scenarios }, join(dir, 'expected'));
    const soft = new FixtureStubClient(corpus, { sharpness: 0.8, fallback: new HeuristicStubClient() });
    const recorder = new CassetteClient({ path: join(dir, 'cassette.jsonl'), mode: 'record', inner: soft });
    await runAll(corpus, [], { client: recorder, thresholds, todayIso: REGRESS_TODAY, now: () => 0 });
    writeFileSync(join(dir, 'thresholds.ts'), readFileSync('src/core/thresholds.ts', 'utf8'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lowers INTENT_ROUTE to the plateau center and explains the move', async () => {
    const r = await runSweep({
      corpusFile: join(dir, 'corpus.jsonl'), scenariosDir: join(dir, 'scenarios'), expectedDir: join(dir, 'expected'),
      cassette: join(dir, 'cassette.jsonl'), only: ['INTENT_ROUTE'], passes: 3, apply: false, thresholdsFile: join(dir, 'thresholds.ts'), reportDir: join(dir, 'tuning'), json: null,
    });
    expect(r.result.before).toMatchObject({ primary: 3, secondary: 0 });
    expect(r.result.after).toMatchObject({ primary: 3, secondary: 3 });
    expect(r.result.moves).toHaveLength(1);
    expect(r.result.moves[0]).toMatchObject({ name: 'INTENT_ROUTE', from: 0.85, to: 0.7, reason: 'secondary', plateau: { from: 0.6, to: 0.8 } });
    expect(r.result.table.INTENT_ROUTE?.points.find((p) => p.value === 0.95)?.status).toBe('breaks_stub');
    expect(r.result.table.INTENT_ROUTE?.points.find((p) => p.value === 0.5)?.status).toBe('skipped');
    expect(r.misses).toEqual([]);
  });

  it('applies the result to the thresholds file and writes the report', async () => {
    const r = await runSweep({
      corpusFile: join(dir, 'corpus.jsonl'), scenariosDir: join(dir, 'scenarios'), expectedDir: join(dir, 'expected'),
      cassette: join(dir, 'cassette.jsonl'), only: ['INTENT_ROUTE'], passes: 3, apply: true, thresholdsFile: join(dir, 'thresholds.ts'), reportDir: join(dir, 'tuning'), json: join(dir, 'out.json'),
    });
    expect(readFileSync(join(dir, 'thresholds.ts'), 'utf8')).toContain('  INTENT_ROUTE: 0.7,');
    expect(readFileSync(r.reportPath!, 'utf8')).toContain('INTENT_ROUTE 0.85 -> 0.70');
    expect(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')).moves).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**, then implement `src/harness-text/sweep.ts`:

```ts
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorpus } from '../jev/corpus';
import { CassetteClient, loadCassette } from '../jev/cassette';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { JEV_MODEL } from '../jev/sdkClient';
import { DEFAULT_THRESHOLDS, type ThresholdName, type Thresholds } from '../core/thresholds';
import { cassettePath, DEFAULT_CORPUS_FILE } from '../run/client';
import { loadScenarios, type RunOptions } from './runner';
import { readBaseline, REGRESS_TODAY } from './baseline';
import { runAll } from './runAll';
import { diff } from './regressDiff';
import { parseOnly, SWEEPABLE } from './sweepSpace';
import { scoreOutcomes, type Score } from './sweepScore';
import { coordinateDescent, type SweepResult } from './sweepSearch';
import { renderMoves, renderReport, renderTable, rewriteThresholds } from './sweepApply';

export interface SweepConfig {
  corpusFile: string;
  scenariosDir: string;
  expectedDir: string;
  cassette: string;
  only: ThresholdName[];
  passes: number;
  apply: boolean;
  thresholdsFile: string;
  reportDir: string;
  json: string | null;
  onProgress?: (line: string) => void;
}

export interface SweepRun {
  result: SweepResult;
  misses: Score['misses'];
  reportPath: string | null;
}

export async function runSweep(cfg: SweepConfig): Promise<SweepRun> {
  if (!existsSync(cfg.cassette)) throw new Error(`no cassette at ${cfg.cassette}; run pnpm regress --client record first`);
  const corpus = loadCorpus(cfg.corpusFile);
  const scenarios = loadScenarios(cfg.scenariosDir);
  const expected = readBaseline(cfg.expectedDir);
  const recorded = new CassetteClient({ path: cfg.cassette, mode: 'replay', expectModel: JEV_MODEL });
  recorded.preload();
  const stubFor = (t: Thresholds) => new FixtureStubClient(corpus, { sharpness: t.STUB_SHARPNESS, fallback: new HeuristicStubClient() });
  const opts = (client: RunOptions['client'], thresholds: Thresholds): RunOptions => ({ client, thresholds, todayIso: REGRESS_TODAY, now: () => 0 });

  const evaluate = async (candidate: Thresholds) => {
    const stub = await runAll(corpus, scenarios, opts(stubFor(candidate), candidate));
    const breaksStub = diff('corpus', expected.corpus, stub.corpus).lines.length > 0 || diff('scenario', expected.scenarios, stub.scenarios).lines.length > 0;
    if (breaksStub) return { score: emptyScore(), breaksStub };
    const real = await runAll(corpus, scenarios, opts(recorded, candidate));
    const score = scoreOutcomes({ expectedCorpus: expected.corpus, expectedScenarios: expected.scenarios, actualCorpus: real.corpus, actualScenarios: real.scenarios, scenarioRecords: real.scenarioRecords });
    return { score, breaksStub: false };
  };

  const result = await coordinateDescent(evaluate, cfg.only, { ...DEFAULT_THRESHOLDS }, cfg.passes, (name, pass, i, total) => {
    if (i === 1) cfg.onProgress?.(`pass ${pass} ${name}`);
    void total;
  });
  const misses = (await evaluate(result.final)).score.misses;

  let reportPath: string | null = null;
  if (cfg.apply) {
    const changed: Partial<Record<ThresholdName, number>> = {};
    for (const m of result.moves) changed[m.name] = result.final[m.name];
    const source = readFileSync(cfg.thresholdsFile, 'utf8');
    writeFileSync(cfg.thresholdsFile, rewriteThresholds(source, changed));
    const date = new Date().toISOString().slice(0, 10);
    mkdirSync(cfg.reportDir, { recursive: true });
    reportPath = join(cfg.reportDir, `${date}-sweep.md`);
    writeFileSync(reportPath, renderReport(result, { cassette: cfg.cassette, requests: loadCassette(cfg.cassette).size, date, misses }));
  }
  if (cfg.json) {
    writeFileSync(cfg.json, JSON.stringify({ before: result.before, after: result.after, moves: result.moves, table: result.table, final: result.final, misses }, (_k, v) => (v instanceof Set ? [...v] : v), 2) + '\n');
  }
  return { result, misses, reportPath };
}

function emptyScore(): Score {
  return { primary: -1, secondary: -1, corpusMatch: 0, scenarioPass: 0, cosmeticMatch: 0, matched: new Set(), misses: [] };
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      json: { type: 'string' },
      only: { type: 'string' },
      passes: { type: 'string', default: '5' },
      'corpus-file': { type: 'string', default: DEFAULT_CORPUS_FILE },
      'scenarios-dir': { type: 'string', default: 'fixtures/scenarios' },
      'expected-dir': { type: 'string', default: 'fixtures/expected' },
      cassette: { type: 'string', default: cassettePath() },
      'thresholds-file': { type: 'string', default: 'src/core/thresholds.ts' },
      'report-dir': { type: 'string', default: 'docs/tuning' },
    },
  });
  const passes = Number(args.passes);
  if (!Number.isInteger(passes) || passes < 1) throw new Error('--passes must be a positive integer');
  const run = await runSweep({
    corpusFile: args['corpus-file']!, scenariosDir: args['scenarios-dir']!, expectedDir: args['expected-dir']!, cassette: args.cassette!,
    only: parseOnly(args.only), passes, apply: args.apply ?? false, thresholdsFile: args['thresholds-file']!, reportDir: args['report-dir']!, json: args.json ?? null,
    onProgress: (line) => console.error(`  ${line}`),
  });
  const r = run.result;
  console.log(`before ${r.before.primary}/${r.before.secondary}   after ${r.after.primary}/${r.after.secondary}   passes ${r.passes}`);
  console.log('');
  console.log(renderTable(r));
  console.log('');
  console.log(renderMoves(r));
  console.log('');
  console.log(run.misses.length ? `cassette misses for the recommended set:\n${run.misses.map((m) => `  ${m.id}: "${m.text}"`).join('\n')}` : 'no cassette misses for the recommended set');
  if (run.reportPath) console.log(`\napplied to ${args['thresholds-file']}; report ${run.reportPath}`);
}

if (process.argv[1] && /sweep\.ts$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
```

`SWEEPABLE` is imported for the `--only` error text via `parseOnly`; remove the import if unused. Add to `package.json` scripts: `"sweep": "tsx src/harness-text/sweep.ts"`.

The `main` guard keeps the module importable by the test without running the CLI; verify `pnpm sweep --only INTENT_ROUTE` runs from the shell and `pnpm vitest run src/harness-text/sweep.test.ts` does not.

- [ ] **Step 3: Run everything.** `pnpm vitest run src/harness-text`, `pnpm typecheck`, `pnpm test`. Then a real dry run: `pnpm sweep --only INTENT_ROUTE,SLOT_CHOICE_FILL` and paste its output (no `--apply`). Expected shape: a two-row table with strips, either moves or `no moves`, and a misses line.

- [ ] **Step 4: Commit**

```bash
git add src/harness-text/sweep.ts src/harness-text/sweep.test.ts package.json
git commit -m "feat(harness): pnpm sweep: coordinate descent over the cassette with report and apply

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: README

**Files:**
- Modify: `README.md` (Regression section)

- [ ] **Step 1: Add a Tuning subsection** after "### The answer cassette" and before "## Phone line":

```markdown
### Tuning

    pnpm sweep                     # sensitivity table, recommended thresholds, moves, misses
    pnpm sweep --apply             # also rewrite src/core/thresholds.ts and write docs/tuning/<date>-sweep.md
    pnpm sweep --only INTENT_ROUTE,SLOT_CHOICE_FILL
    pnpm sweep --json out.json

The sweep runs offline against the cassette. A candidate threshold set is
scored by how many corpus entries reproduce the label baseline's decision
(decision kind, prompt, form, slots, handoff reason) plus how many scenarios
pass their own expectation; acks and the deciding gate only break ties. A
candidate that changes the stub's own outcomes is rejected outright, since
the label baseline is only meaningful while the stub reproduces it.

Each threshold is swept over a 0.05 grid with the others held fixed; the
recommended value is the middle of the widest plateau at the best score, so
the result sits away from cliffs. A best score reached at a single grid
point is reported as a cliff and never applied; a threshold whose whole
grid scores the same is listed as insensitive, meaning this corpus does not
constrain it. Every applied move lists the entries it flipped.

A move can push a multi-turn scenario off the recorded path; such scenarios
are unscored for that candidate and listed as misses. Record them once with
`pnpm regress --client record`, run `pnpm sweep` again to confirm, and
commit the thresholds with the report.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: pnpm sweep

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Run the sweep and apply it

**Files:**
- Modify: `src/core/thresholds.ts`, tests that pin default numbers, `docs/tuning/<date>-sweep.md` (new)

- [ ] **Step 1: Sweep and read the table.** `pnpm sweep > /private/tmp/sweep.txt; cat /private/tmp/sweep.txt`. Paste the whole output in your report. Before applying, sanity-check every move against the recorded evidence in the question-redesign plan's deviation record (e.g. `INTENT_ROUTE` should move down toward 0.80 to absorb "My appointment with Dr. Chen"; `SLOT_CHOICE_FILL` down toward 0.59 for the date mode split; `GATE_COMPLETE` and `INTENT_IMPLICIT` may interact around "so my appointment"). A move that flips a scenario from pass to fail, or that lowers a gate below 0.5, deserves a sentence of justification in the report; if you cannot justify it, run with `--only` excluding that threshold and report the difference.

- [ ] **Step 2: Apply.** `pnpm sweep --apply --json docs/tuning/$(date +%F)-sweep.json`. Then `pnpm regress` (must be `no changes`: the stub invariant), `pnpm regress --client recorded | tail -6` (report the new totals; expect the primary score's gain to show as more corpus matches), `pnpm typecheck`, `pnpm test`.

- [ ] **Step 3: Fix tests that pinned default numbers.** Some unit tests assert threshold values as literals (e.g. `toMatchObject({ threshold: 0.7 })` in `gates.test.ts`, `threshold: 0.6` for `intentChange`, `SLOT_CHOICE_CONFIRM`-derived expectations in `date.test.ts`). Change those assertions to reference `DEFAULT_THRESHOLDS.<NAME>` rather than hard-coding the new number, so the next sweep does not break them. Do not change any test's input distributions to chase a moved threshold: if a test's *scenario* stops meaning what its name says (e.g. "fills silently above the fill band" with an input that is now below the band), adjust the input to stay clearly on the intended side and say so. `pnpm test` green.

- [ ] **Step 4: Commit**

```bash
git add src/core/thresholds.ts docs/tuning src/core src/domain
git commit -m "tune: apply the first threshold sweep against jev-1.13.0

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(with the moves and before/after scores in the body; `git add src/core src/domain` only picks up the test edits from Step 3 plus thresholds.ts, confirm with `git status --short`).

---

### Task 10 (Jason, not an agent): record the misses, confirm

From the repo root with the branch checked out. If Task 9's report listed cassette misses:

```bash
set -a; source .env; set +a; pnpm regress --client record --threshold JEV_TIMEOUT_MS=15000
```

Only the missed turns are live. Then `pnpm sweep` again: expect `no moves` (or a small move the newly recorded turns justify; if so, `--apply` again and re-run until stable). Commit the cassette and any second report:

```bash
git add fixtures/recorded/jev-1.13.0.jsonl docs/tuning src/core/thresholds.ts
git commit -m "fixtures: record the turns the tuned thresholds reach; confirm the sweep

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

If the report listed no misses, this step is only the confirmation run.

---

### Task 11: Deviation record

Append "Deviations recorded during execution" to this plan in the format of the previous plans, plus the final scores and the applied moves, then commit:

```bash
git add docs/superpowers/plans/2026-09-19-threshold-sweep.md
git commit -m "docs(plan): record threshold sweep deviations and result

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- §2 command and flags: Task 7. §3 scoring and the stub invariant: Task 4, wired in Task 7's `evaluate`. §4 misses: Task 4 (`missedUtterance`), reported in Task 7. §5 space: Task 3. §6 search: Task 5. §7 label: Task 2. §8 outputs: Tasks 6 and 7. §9 layout: as listed. §10 tests: Tasks 1, 3–7. §11 README: Task 8. Applying and confirming: Tasks 9–10.
- Names used across tasks: `runAll`, `emptyRunAll`, `RunAllResult`, `readBaseline`, `writeExpected`, `ScenarioOutcome`, `REGRESS_TODAY`, `SWEEPABLE`, `gridFor`, `violated`, `parseOnly`, `scoreOutcomes`, `better`, `equal`, `flips`, `Score`, `bestPlateau`, `chooseMove`, `coordinateDescent`, `GridPoint`, `Move`, `SweepResult`, `rewriteThresholds`, `renderStrip`, `renderTable`, `renderMoves`, `renderReport`, `runSweep`, `SweepConfig`. All defined before use.
- Deviation from spec §8: the JSON log adds `final`; the report adds a `passes` line.

---

## Deviations recorded during execution

- **Task 1.** `corpusRecords` was dropped from `RunAllResult` (corpus request keys never depend on thresholds, so per-entry corpus records are not needed; `records` keeps them in order). The `REGRESS_TODAY` re-export from `regress.ts` was not added: that module runs `main()` at import, so re-exporting from it is a trap. `readExpected` is module-private. Measured: a full offline pass is about 42 ms in process (stub invariant plus recorded run), so a complete sweep is well under a minute.
- **Task 3 (after review).** The constraint `INTENT_IMPLICIT <= INTENT_SWITCH` became `INTENT_ROUTE <= INTENT_SWITCH` (abandoning an in-progress form silently needs at least the confidence of starting one; the implicit bound follows). `--only` dedupes. Tests pin that the sweepable and fixed sets partition `DEFAULT_THRESHOLDS` and that every default lies on its grid.
- **Task 4 (after review).** `queued` is a decision field, not cosmetic (a queued intent is a promise to the caller and reaches the handoff data). Fewer cassette misses is the third sort key. Scenario ids in `matched` and `flips` are namespaced `scenario:<id>`. Field comparison uses `canonicalJson` and typed field lists. `isCassetteMiss` lives in `src/jev/cassette.ts` and is shared with `regress.ts`.
- **Task 5 (after review).** Center moves are capped at one per threshold per descent and never earn another pass; `SweepResult` gains `converged` and `evaluations`, `Move` gains `pass`; the descent refuses a start that violates a constraint; an off-grid current value snaps to the nearest grid index for tie-breaks only. **New rule, not in spec §6:** a best plateau that touches either grid endpoint is unbounded evidence and blocks every move reason, center included; the row is flagged `unbounded` and reported. Exactly one legal grid value is flagged `pinned`; `insensitive` needs at least two scored points.
- **Task 7 (after review).** A cassette miss on a corpus turn aborts the sweep as a stale cassette rather than costing the candidate a point. A synthetic cassette (tests) is replayed without `expectModel`; the real one is still pinned. The JSON log omits per-point matched sets (they made a full log ~116k lines).
- **Task 9.** The full sweep recommended four moves, and every proposed move is a secondary-score move: primary was already at its best, 208 of 211, at each threshold's starting value, though several thresholds do lose decisions away from it (the `~` and `-` cells in the report's strips). `GATE_WANTS_HUMAN` 0.70 → 0.30 was excluded by judgment: the only recorded utterance with a wants-human score between 0.10 and 0.70 is "Agent" (0.52), which hands off through the intent gate anyway, so the range has no negative evidence and lowering a handoff gate by 0.40 on it is a safety change. That exclusion is now mechanical rather than a note in the report: `EXCLUDED` in `sweepSpace.ts` holds the threshold with its reason, `parseOnly(undefined)` leaves it out of the default set, and every report prints it under "Excluded by judgment". Applied: `INTENT_ROUTE` 0.85 → 0.70, `PROVIDER_UNSURE` 0.50 → 0.45, and `SLOT_CHOICE_FILL` 0.70 → **0.55 by judgment, not the tool's 0.50**: the 0.45..0.55 plateau's lower edge is the ordering constraint against `SLOT_CHOICE_CONFIRM`, which is itself insensitive here, so it is not evidence; the only evidence is `dt-09` (weakest date component 0.59) losing a redundant ack, and 0.55 is the smallest move that earns that same point while keeping more of the confirmation margin on dates. A confirmation sweep therefore keeps proposing a scoreless centre move back to 0.50, which is the same judgment call rather than new evidence. Secondary 205 → 207; the recorded run's corpus agreement went from 161 to 163 of 166. Ten test files had inputs moved to stay on the side of the band their names describe, or literals replaced by `DEFAULT_THRESHOLDS` references. The post-apply confirmation sweep leaves the excluded gate out of the table altogether and recommends only the scoreless re-centre of `SLOT_CHOICE_FILL` described above. Insensitive on this corpus (unconstrained by data), eleven of them: `GATE_COMPLETE`, `INTENT_EXPLICIT`, `INTENT_SWITCH`, `GATE_INTENT_MARGIN`, `GATE_FRUSTRATION_HIGH`, `INTENT_TENTATIVE`, `INTENT_CHANGE`, `SLOT_CHOICE_CONFIRM`, `SLOT_CHOICE_MARGIN`, `CONFIRM_YES`, `MENU_NUMBER`. Unbounded: `GATE_INTELLIGIBLE` (no low-intelligibility utterance that is addressed to the system remains in the corpus after the noise relabel) and `SLOT_DETECT`.
- **Task 10.** No cassette misses were produced, so no live recording was needed; the confirmation run is `docs/tuning/2026-09-19-sweep-confirm.txt`.

Follow-ups, not in this branch: the corpus needs near-miss utterances for the two unbounded gates (garbled-but-addressed speech for `GATE_INTELLIGIBLE`; "get someone"/"is there a person" for `GATE_WANTS_HUMAN`) and for the eleven insensitive thresholds before a sweep can say anything about them; the one failing scenario (`hedged-two-providers-disambiguate`) is a model-behavior gap, not a threshold; `ns-06` ("so my appointment") routes on an incomplete utterance because `GATE_COMPLETE` never blocks a final, a gate-order question.
