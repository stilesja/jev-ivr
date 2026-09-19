# Real-Model Regression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `pnpm regress` run the corpus and scenarios against the real Jev model, record every answer into a committed cassette, replay it offline, and print a summary of label agreement, cost, and latency.

**Architecture:** A `CassetteClient` wraps any `JevClient` and keys requests by a SHA-256 of canonical `{state, questions}`. `buildClient` gains `record` and `recorded` kinds. `regress.ts` gains `--client`, refuses `--update` off the stub, and prints a summary built by a pure formatter.

**Tech Stack:** Node 20+, TypeScript strict ESM, `node:crypto`, `node:fs`, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-18-real-model-regression-design.md`. Read it first. The plan wins on small conflicts; each is marked "Deviation:".

**Conventions for every task:**

- Tests colocated as `*.test.ts`; run one with `pnpm vitest run <path>`, all with `pnpm test`; typecheck with `pnpm typecheck`.
- Extensionless imports; strict TS; `noUncheckedIndexedAccess` is on, so index results are `T | undefined`.
- Commit after every task with the message shown, one task per commit, exactly one writer at a time.
- Every commit message ends with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, on its own line after a blank line.
- `src/core`, `src/domain`, `src/prompts`, `src/trace`, `src/server` are not modified in this plan. `src/jev/types.ts` changes in Task 1 only.
- Temp files in tests go under `mkdtempSync(join(tmpdir(), 'cassette-'))` and are removed in `afterEach`.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/jev/types.ts` | `AnswerSource` gains `'recorded'` |
| `src/jev/cassette.ts` | `canonicalJson`, `requestKey`, `CassetteLine`, `loadCassette`, `appendCassette`, `CassetteClient` |
| `src/jev/cassette.test.ts` | key stability, file load/append, replay and record modes |
| `src/run/client.ts` | `CLIENT_KINDS`, `cassettePath`, `record` and `recorded` kinds, unknown kind throws |
| `src/harness-text/cli.test.ts` | new `buildClient` cases |
| `src/harness-text/regressSummary.ts` | `formatRegressSummary`, pure |
| `src/harness-text/regressSummary.test.ts` | four summary lines, tags, stub omission, misses |
| `src/harness-text/regress.ts` | `--client`, stub-only `--update`, per-id match counts, summary |
| `README.md` | Regression section: client kinds, baseline meaning, recording workflow |
| `fixtures/recorded/jev-1.13.0.jsonl` | the cassette, recorded by Jason in the final step |

---

### Task 1: Canonical JSON and request key

**Files:**
- Modify: `src/jev/types.ts:61`
- Create: `src/jev/cassette.ts`
- Test: `src/jev/cassette.test.ts`

- [ ] **Step 1: Add the answer source**

In `src/jev/types.ts` change line 61 to:

```ts
export type AnswerSource = 'jev' | 'stub:fixture' | 'stub:heuristic' | 'replay' | 'recorded';
```

`TraceSource` in `src/trace/types.ts` extends `AnswerSource` and needs no change.

- [ ] **Step 2: Write the failing tests**

Create `src/jev/cassette.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalJson, requestKey } from './cassette';
import type { JevRequest, QuestionMap } from './types';

const questions: QuestionMap = {
  intent: { type: 'choice', instructions: 'What does the caller want?', criteria: { cancel: null, none: null } },
  ok: { type: 'noul', instructions: 'Is it fine?' },
};

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('drops undefined-valued keys', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
  });

  it('escapes strings like JSON.stringify', () => {
    expect(canonicalJson({ t: 'a "quoted" line\n' })).toBe('{"t":"a \\"quoted\\" line\\n"}');
  });
});

describe('requestKey', () => {
  const state = { asr: { text: 'cancel my appointment', isFinal: true }, activeForm: null };

  it('is a 64-char hex sha256 that is stable under key order', () => {
    const a = requestKey({ state, questions });
    const b = requestKey({ state: { activeForm: null, asr: { isFinal: true, text: 'cancel my appointment' } }, questions });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('ignores timeoutMs and signal', () => {
    const base: JevRequest = { state, questions };
    expect(requestKey({ ...base, timeoutMs: 5, signal: new AbortController().signal })).toBe(requestKey(base));
  });

  it('changes when state or questions change', () => {
    const a = requestKey({ state, questions });
    expect(requestKey({ state: { ...state, activeForm: 'cancel' }, questions })).not.toBe(a);
    expect(requestKey({ state, questions: { ok: questions.ok! } })).not.toBe(a);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run src/jev/cassette.test.ts`
Expected: FAIL, cannot resolve `./cassette`.

- [ ] **Step 4: Implement**

Create `src/jev/cassette.ts`:

```ts
import { createHash } from 'node:crypto';
import type { JevRequest } from './types';

/** JSON with object keys sorted at every level, arrays in order, no whitespace, undefined keys dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  const parts = Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
  return `{${parts.join(',')}}`;
}

/** Identity of a request for the cassette: what is asked and about what, not how long we waited. */
export function requestKey(req: JevRequest): string {
  return createHash('sha256').update(canonicalJson({ state: req.state, questions: req.questions })).digest('hex');
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run src/jev/cassette.test.ts` then `pnpm typecheck`
Expected: 6 passing, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/jev/types.ts src/jev/cassette.ts src/jev/cassette.test.ts
git commit -m "feat(jev): canonical request key and recorded answer source

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Cassette file load and append

**Files:**
- Modify: `src/jev/cassette.ts`
- Test: `src/jev/cassette.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/jev/cassette.test.ts` (add the imports at the top of the file):

```ts
import { afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCassette, loadCassette, type CassetteLine } from './cassette';
import { choice, noul } from '../testing/answers';
```

```ts
function line(key: string, extra: Partial<CassetteLine> = {}): CassetteLine {
  return {
    v: 1,
    key,
    model: 'jev-1.13.0',
    text: 'cancel my appointment',
    answers: { intent: choice({ cancel: 0.9, none: 0.1 }), ok: noul(0.8) },
    usage: { inputTokens: 100, outputTokens: 10 },
    recordedAt: '2026-09-18T00:00:00.000Z',
    ...extra,
  };
}

describe('cassette file', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cassette-'));
    path = join(dir, 'nested', 'jev-1.13.0.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads an empty map when the file does not exist', () => {
    expect(loadCassette(path).size).toBe(0);
  });

  it('appends one JSON line per call, creating the directory', () => {
    appendCassette(path, line('a'.repeat(64)));
    appendCassette(path, line('b'.repeat(64)));
    const raw = readFileSync(path, 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
    expect(raw.endsWith('\n')).toBe(true);
    expect(loadCassette(path).get('b'.repeat(64))?.text).toBe('cancel my appointment');
  });

  it('lets a later line for the same key win', () => {
    appendCassette(path, line('a'.repeat(64), { model: 'old' }));
    appendCassette(path, line('a'.repeat(64), { model: 'new' }));
    const loaded = loadCassette(path);
    expect(loaded.size).toBe(1);
    expect(loaded.get('a'.repeat(64))?.model).toBe('new');
  });

  it('fails the load naming the bad line number', () => {
    writeFileSync(path.replace('nested/', ''), `${JSON.stringify(line('a'.repeat(64)))}\n{"v":2,"key":"x"}\nnot json\n`);
    const flat = path.replace('nested/', '');
    expect(() => loadCassette(flat)).toThrow(/line 2/);
  });

  it('fails the load on a line with no key', () => {
    const flat = path.replace('nested/', '');
    writeFileSync(flat, `{"v":1,"model":"m"}\n`);
    expect(() => loadCassette(flat)).toThrow(/line 1/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/jev/cassette.test.ts`
Expected: FAIL, `loadCassette` is not exported.

- [ ] **Step 3: Implement**

Add to `src/jev/cassette.ts` (extend the imports):

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnswerMap } from './types';

export interface CassetteLine {
  v: 1;
  key: string;
  model: string;
  /** state.asr.text, so a person can grep the file */
  text: string;
  answers: AnswerMap;
  usage: { inputTokens: number; outputTokens: number };
  recordedAt: string;
}

/** Later lines for the same key win. A missing file is an empty cassette. */
export function loadCassette(path: string): Map<string, CassetteLine> {
  const out = new Map<string, CassetteLine>();
  if (!existsSync(path)) return out;
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((raw, i) => {
    if (raw.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`cassette ${path} line ${i + 1}: not JSON`);
    }
    const l = parsed as Partial<CassetteLine> | null;
    if (!l || l.v !== 1 || typeof l.key !== 'string') throw new Error(`cassette ${path} line ${i + 1}: expected v:1 with a key`);
    out.set(l.key, l as CassetteLine);
  });
  return out;
}

/** Synchronous append so a crash mid-run keeps everything recorded so far. */
export function appendCassette(path: string, line: CassetteLine): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + '\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/jev/cassette.test.ts` then `pnpm typecheck`
Expected: 11 passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/jev/cassette.ts src/jev/cassette.test.ts
git commit -m "feat(jev): cassette file load and append

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: CassetteClient replay and record modes

**Files:**
- Modify: `src/jev/cassette.ts`
- Test: `src/jev/cassette.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/jev/cassette.test.ts` (extend the import from `./cassette` with `CassetteClient`, and from `./types` with `AnswerMap`, `JevClient`, `JevResponse`; import `JevClientError` from `./types` as a value):

```ts
function fakeInner(answers: AnswerMap): JevClient & { calls: number } {
  const inner = {
    calls: 0,
    async ask(): Promise<JevResponse> {
      inner.calls += 1;
      return { answers, model: 'jev-1.13.0', usage: { inputTokens: 42, outputTokens: 7, estimated: false }, latencyMs: 3, source: 'jev' };
    },
  };
  return inner;
}

describe('CassetteClient', () => {
  const state = { asr: { text: 'cancel my appointment', isFinal: true }, activeForm: null };
  const answers: AnswerMap = { intent: choice({ cancel: 0.9, none: 0.1 }), ok: noul(0.8) };
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cassette-'));
    path = join(dir, 'jev-1.13.0.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('replays a hit with source recorded and the recorded usage', async () => {
    appendCassette(path, line(requestKey({ state, questions }), { answers }));
    const r = await new CassetteClient({ path, mode: 'replay' }).ask({ state, questions });
    expect(r.source).toBe('recorded');
    expect(r.model).toBe('jev-1.13.0');
    expect(r.answers).toEqual(answers);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 10, estimated: false });
  });

  it('throws a JevClientError naming the key and text on a replay miss', async () => {
    const key = requestKey({ state, questions });
    await expect(new CassetteClient({ path, mode: 'replay' }).ask({ state, questions })).rejects.toThrow(JevClientError);
    await expect(new CassetteClient({ path, mode: 'replay' }).ask({ state, questions })).rejects.toThrow(new RegExp(`cassette miss: ${key} cancel my appointment`));
  });

  it('records a miss through the inner client once and replays it afterwards', async () => {
    const inner = fakeInner(answers);
    const client = new CassetteClient({ path, mode: 'record', inner, now: () => Date.UTC(2026, 8, 18) });
    const first = await client.ask({ state, questions });
    expect(first.source).toBe('jev');
    expect(inner.calls).toBe(1);
    const second = await client.ask({ state, questions });
    expect(second.source).toBe('recorded');
    expect(inner.calls).toBe(1);
    const saved = loadCassette(path).get(requestKey({ state, questions }));
    expect(saved).toMatchObject({ v: 1, model: 'jev-1.13.0', text: 'cancel my appointment', usage: { inputTokens: 42, outputTokens: 7 }, recordedAt: '2026-09-18T00:00:00.000Z' });
    expect(saved?.answers).toEqual(answers);
  });

  it('requires an inner client in record mode', () => {
    expect(() => new CassetteClient({ path, mode: 'record' })).toThrow(/inner/);
  });

  it('passes an inner client failure through without recording', async () => {
    const inner: JevClient = { ask: async () => { throw new JevClientError('boom'); } };
    await expect(new CassetteClient({ path, mode: 'record', inner }).ask({ state, questions })).rejects.toThrow('boom');
    expect(loadCassette(path).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/jev/cassette.test.ts`
Expected: FAIL, `CassetteClient` is not exported.

- [ ] **Step 3: Implement**

Add to `src/jev/cassette.ts` (extend the type import with `JevClient`, `JevResponse`, and import `JevClientError` as a value):

```ts
export type CassetteMode = 'replay' | 'record';

export interface CassetteOptions {
  path: string;
  mode: CassetteMode;
  /** required in record mode: answers a miss and is recorded */
  inner?: JevClient;
  now?: () => number;
}

function textOf(state: unknown): string {
  const s = state as { asr?: { text?: string } } | null;
  return s?.asr?.text ?? '';
}

/**
 * Replays recorded answers keyed by requestKey. In record mode a miss goes to the inner
 * client and is appended to the file; in replay mode a miss is a client error, so a stale
 * cassette shows up as a failed turn rather than a silently different answer.
 */
export class CassetteClient implements JevClient {
  private lines: Map<string, CassetteLine> | null = null;

  constructor(private readonly opts: CassetteOptions) {
    if (opts.mode === 'record' && !opts.inner) throw new Error('CassetteClient: record mode needs an inner client');
  }

  private load(): Map<string, CassetteLine> {
    this.lines ??= loadCassette(this.opts.path);
    return this.lines;
  }

  async ask(req: JevRequest): Promise<JevResponse> {
    const started = performance.now();
    const key = requestKey(req);
    const hit = this.load().get(key);
    if (hit) {
      return {
        answers: hit.answers,
        model: hit.model,
        usage: { ...hit.usage, estimated: false },
        latencyMs: performance.now() - started,
        source: 'recorded',
      };
    }
    if (this.opts.mode === 'replay') throw new JevClientError(`cassette miss: ${key} ${textOf(req.state)}`);
    const res = await this.opts.inner!.ask(req);
    const line: CassetteLine = {
      v: 1,
      key,
      model: res.model,
      text: textOf(req.state),
      answers: res.answers,
      usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens },
      recordedAt: new Date((this.opts.now ?? Date.now)()).toISOString(),
    };
    appendCassette(this.opts.path, line);
    this.load().set(key, line);
    return res;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/jev/cassette.test.ts` then `pnpm typecheck`
Expected: 16 passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/jev/cassette.ts src/jev/cassette.test.ts
git commit -m "feat(jev): CassetteClient with replay and record modes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Client kinds record and recorded

**Files:**
- Modify: `src/run/client.ts`
- Test: `src/harness-text/cli.test.ts` (the existing `buildClient` describe block)

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('buildClient', ...)` block of `src/harness-text/cli.test.ts`:

```ts
  it('builds a replay-only cassette client for recorded', async () => {
    const r = buildClient('recorded', DEFAULT_CORPUS_FILE, t).ask({ state, questions });
    await expect(r).rejects.toThrow(/cassette miss/);
  });

  it('fails fast for jev and record when no API key is set, and never needs one for recorded', () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(() => buildClient('jev', DEFAULT_CORPUS_FILE, t)).toThrow(/No API key/);
      expect(() => buildClient('record', DEFAULT_CORPUS_FILE, t)).toThrow(/No API key/);
      expect(() => buildClient('recorded', DEFAULT_CORPUS_FILE, t)).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it('throws on an unknown kind, listing the valid ones', () => {
    expect(() => buildClient('nope', DEFAULT_CORPUS_FILE, t)).toThrow(/stub, heuristic, jev, record, recorded/);
  });
```

Add to the file's imports: `import { cassettePath } from '../run/client';` and a test:

```ts
describe('cassettePath', () => {
  it('is one file per pinned model under fixtures/recorded', () => {
    expect(cassettePath()).toBe('fixtures/recorded/jev-1.13.0.jsonl');
    expect(cassettePath('jev-2.0.0')).toBe('fixtures/recorded/jev-2.0.0.jsonl');
  });
});
```

The `recorded` test relies on `fixtures/recorded/jev-1.13.0.jsonl` not containing the nonsense utterance `zzz qqq wwww`; the real recording never will.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/harness-text/cli.test.ts`
Expected: FAIL, `cassettePath` not exported; `nope` builds a stub instead of throwing.

- [ ] **Step 3: Implement**

Replace `buildClient` in `src/run/client.ts` and add the exports:

```ts
import { CassetteClient } from '../jev/cassette';
import { JEV_MODEL, SdkJevClient } from '../jev/sdkClient';

export const CLIENT_KINDS = ['stub', 'heuristic', 'jev', 'record', 'recorded'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export function cassettePath(model: string = JEV_MODEL): string {
  return `fixtures/recorded/${model}.jsonl`;
}

export function buildClient(kind: string, corpusFile: string, thresholds: Thresholds): JevClient {
  switch (kind as ClientKind) {
    case 'jev':
      return new SdkJevClient({ timeoutMs: thresholds.JEV_TIMEOUT_MS });
    case 'record':
      return new CassetteClient({ path: cassettePath(), mode: 'record', inner: new SdkJevClient({ timeoutMs: thresholds.JEV_TIMEOUT_MS }) });
    case 'recorded':
      return new CassetteClient({ path: cassettePath(), mode: 'replay' });
    case 'heuristic':
      return new HeuristicStubClient();
    case 'stub':
      return new FixtureStubClient(loadCorpus(corpusFile), { sharpness: thresholds.STUB_SHARPNESS, fallback: new HeuristicStubClient() });
    default:
      throw new Error(`unknown client kind "${kind}"; expected one of ${CLIENT_KINDS.join(', ')}`);
  }
}
```

Keep the existing imports for `SdkJevClient` merged with the new `JEV_MODEL` import (one import line from `../jev/sdkClient`).

- [ ] **Step 4: Run the full suite**

Run: `pnpm test` then `pnpm typecheck`
Expected: all passing (the CLI's `--client` default is `stub`, so nothing else changes), typecheck clean. If any existing test passes an unlisted kind, that test is wrong under the spec; fix the test to use a listed kind.

- [ ] **Step 5: Commit**

```bash
git add src/run/client.ts src/harness-text/cli.test.ts
git commit -m "feat(run): record and recorded client kinds; unknown kinds throw

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Regression summary formatter

**Files:**
- Create: `src/harness-text/regressSummary.ts`
- Test: `src/harness-text/regressSummary.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/harness-text/regressSummary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatRegressSummary, type RegressSummaryInput } from './regressSummary';
import type { TraceRecord } from '../trace/types';

type Row = Pick<TraceRecord, 'source' | 'timing' | 'usage' | 'error'>;

function row(source: TraceRecord['source'], askMs: number, inputTokens: number, error: TraceRecord['error'] = null): Row {
  return {
    source,
    error,
    timing: { planMs: 0, askMs, resolveMs: 0, totalMs: askMs },
    usage: { inputTokens, outputTokens: 0, estimated: false, costUsd: (inputTokens * 0.042) / 1_000_000 },
  };
}

const counts = { corpusTotal: 154, corpusMatching: 148, scenarioTotal: 35, scenarioPassing: 33, scenarioMatching: 31 };

function summary(input: Partial<RegressSummaryInput>): string {
  return formatRegressSummary({ ...counts, clientKind: 'jev', records: [], ...input });
}

describe('formatRegressSummary', () => {
  it('prints the two count lines for the stub and no cost line', () => {
    const text = summary({ clientKind: 'stub', records: [row('stub:fixture', 1, 500)] });
    expect(text).toContain('corpus     148/154 outcomes match expected');
    expect(text).toContain('scenarios   33/35 pass expectation,  31/35 match expected');
    expect(text).not.toContain('cost usd');
    expect(text).toContain('latency ms p50 1.0  p95 1.0');
  });

  it('prints cost with request and token counts for a live run', () => {
    const text = summary({ records: [row('jev', 500, 1_000_000), row('jev', 700, 200_000), row('none', 0, 0)] });
    expect(text).toContain('cost usd   0.0504  (2 requests, 1,200,000 input tokens)');
    expect(text).not.toMatch(/\[(replayed|mixed)\]/);
    expect(text).toContain('latency ms p50 500.0  p95 700.0');
  });

  it('tags an all-recorded run as replayed and a mix as mixed', () => {
    expect(summary({ records: [row('recorded', 1, 10), row('recorded', 1, 10)] })).toMatch(/cost usd.*\[replayed\]$/m);
    expect(summary({ records: [row('recorded', 1, 10), row('jev', 1, 10)] })).toMatch(/cost usd.*\[mixed\]$/m);
  });

  it('counts cassette misses and omits the line at zero', () => {
    const miss = row('error', 0, 0, { name: 'JevClientError', message: 'cassette miss: abc hello' });
    const other = row('error', 0, 0, { name: 'JevClientError', message: 'injected timeout' });
    expect(summary({ records: [miss, miss, other] })).toContain('cassette misses 2');
    expect(summary({ records: [other] })).not.toContain('cassette misses');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/harness-text/regressSummary.test.ts`
Expected: FAIL, cannot resolve `./regressSummary`.

- [ ] **Step 3: Implement**

Create `src/harness-text/regressSummary.ts`:

```ts
import type { TraceRecord } from '../trace/types';

export interface RegressSummaryInput {
  corpusTotal: number;
  corpusMatching: number;
  scenarioTotal: number;
  scenarioPassing: number;
  scenarioMatching: number;
  /** every turn the run made; only answered turns count toward cost and latency */
  records: Pick<TraceRecord, 'source' | 'timing' | 'usage' | 'error'>[];
  clientKind: string;
}

const ANSWERED = new Set(['jev', 'recorded', 'stub:fixture', 'stub:heuristic', 'replay']);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function formatRegressSummary(i: RegressSummaryInput): string {
  const answered = i.records.filter((r) => ANSWERED.has(r.source));
  const lines = [
    `corpus     ${i.corpusMatching}/${i.corpusTotal} outcomes match expected`,
    `scenarios  ${String(i.scenarioPassing).padStart(3)}/${i.scenarioTotal} pass expectation,  ${i.scenarioMatching}/${i.scenarioTotal} match expected`,
  ];
  if (i.clientKind !== 'stub') {
    const cost = answered.reduce((s, r) => s + r.usage.costUsd, 0);
    const tokens = answered.reduce((s, r) => s + r.usage.inputTokens, 0);
    const sources = new Set(answered.map((r) => r.source));
    const tag = answered.length && sources.size === 1 && sources.has('recorded') ? '   [replayed]' : sources.size > 1 ? '   [mixed]' : '';
    lines.push(`cost usd   ${cost.toFixed(4)}  (${answered.length} requests, ${tokens.toLocaleString('en-US')} input tokens)${tag}`);
  }
  const latencies = answered.map((r) => r.timing.askMs);
  lines.push(`latency ms p50 ${percentile(latencies, 50).toFixed(1)}  p95 ${percentile(latencies, 95).toFixed(1)}`);
  const misses = i.records.filter((r) => r.error?.message.startsWith('cassette miss')).length;
  if (misses > 0) lines.push(`cassette misses ${misses}`);
  return lines.join('\n');
}
```

Deviation: the spec's example shows `scenarios   33/35` with the count padded to width 3; this implementation pads that way. `sources.size > 1` also tags a stub-plus-heuristic mix, which cannot happen off the stub kind, so it is harmless.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/harness-text/regressSummary.test.ts` then `pnpm typecheck`
Expected: 4 passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/harness-text/regressSummary.ts src/harness-text/regressSummary.test.ts
git commit -m "feat(harness): pure regression summary formatter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: regress --client, stub-only --update, summary

**Files:**
- Modify: `src/harness-text/regress.ts`

`regress.ts` has no unit test; the runner and formatter it calls are tested. Verify with the manual runs in Step 3.

- [ ] **Step 1: Rewrite the argument parsing, client, diff, and output**

Apply these changes to `src/harness-text/regress.ts`:

Imports: drop `FixtureStubClient` and `HeuristicStubClient`; add

```ts
import { buildClient, CLIENT_KINDS, DEFAULT_CORPUS_FILE } from '../run/client';
import { formatRegressSummary } from './regressSummary';
import type { TraceRecord } from '../trace/types';
```

Options:

```ts
const { values: args } = parseArgs({
  options: {
    update: { type: 'boolean', default: false },
    threshold: { type: 'string', multiple: true, default: [] },
    client: { type: 'string', default: 'stub' },
  },
});
```

Replace `diff` with a per-id version that also reports which ids differ:

```ts
function diffOne<T extends object>(name: string, id: string, e: T | undefined, a: T | undefined): string[] {
  if (!e) return [`+ ${name} ${id}: new`];
  if (!a) return [`- ${name} ${id}: removed`];
  const out: string[] = [];
  for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) {
    const ev = JSON.stringify((e as Record<string, unknown>)[key]);
    const av = JSON.stringify((a as Record<string, unknown>)[key]);
    if (ev !== av) out.push(`~ ${name} ${id}.${key}: ${ev} -> ${av}`);
  }
  return out;
}

function diff<T extends object>(name: string, expected: Record<string, T>, actual: Record<string, T>): { lines: string[]; matching: number } {
  const lines: string[] = [];
  let matching = 0;
  for (const id of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const own = diffOne(name, id, expected[id], actual[id]);
    if (own.length === 0 && actual[id]) matching += 1;
    lines.push(...own);
  }
  return { lines, matching };
}
```

`main`:

```ts
async function main(): Promise<void> {
  const kind = args.client!;
  if (!(CLIENT_KINDS as readonly string[]).includes(kind)) throw new Error(`--client must be one of ${CLIENT_KINDS.join(', ')}`);
  if (args.update && kind !== 'stub') {
    console.error('--update is stub-only: fixtures/expected is the label-derived baseline and is re-recorded from the stub');
    process.exitCode = 1;
    return;
  }
  const thresholds = withOverrides(Object.assign({}, ...(args.threshold ?? []).map(parseOverride)));
  const corpus = loadCorpus(DEFAULT_CORPUS_FILE);
  const opts: RunOptions = {
    client: buildClient(kind, DEFAULT_CORPUS_FILE, thresholds),
    thresholds,
    todayIso: REGRESS_TODAY,
    now: () => 0,
  };

  const actual: Recorded = { corpus: {}, scenarios: {} };
  const records: TraceRecord[] = [];
  for (const entry of corpus) {
    const r = await runCorpusEntry(entry, opts);
    actual.corpus[entry.id] = r.outcome;
    records.push(r.run.record);
  }
  for (const scenario of loadScenarios('fixtures/scenarios')) {
    const r = await runScenario(scenario, opts);
    actual.scenarios[scenario.id] = { ...r.outcome, pass: r.pass, mismatches: r.mismatches };
    records.push(...r.runs.map((run) => run.record));
  }

  if (args.update) {
    mkdirSync(EXPECTED_DIR, { recursive: true });
    writeFileSync(`${EXPECTED_DIR}/corpus.json`, JSON.stringify(actual.corpus, null, 2) + '\n');
    writeFileSync(`${EXPECTED_DIR}/scenarios.json`, JSON.stringify(actual.scenarios, null, 2) + '\n');
    console.log(`recorded ${Object.keys(actual.corpus).length} corpus outcomes and ${Object.keys(actual.scenarios).length} scenario outcomes`);
    return;
  }

  const corpusDiff = diff('corpus', readExpected<Outcome>('corpus.json'), actual.corpus);
  const scenarioDiff = diff('scenario', readExpected<ScenarioOutcome>('scenarios.json'), actual.scenarios);
  const lines = [...corpusDiff.lines, ...scenarioDiff.lines];
  const scenarios = Object.values(actual.scenarios);
  const failing = scenarios.filter((s) => !s.pass);
  for (const s of failing) console.log(`FAIL scenario ${s.id}: ${s.mismatches.join('; ')}`);
  for (const l of lines) console.log(l);
  if (lines.length === 0 && failing.length === 0) console.log('no changes');
  else process.exitCode = 1;
  console.log('');
  console.log(formatRegressSummary({
    corpusTotal: corpus.length,
    corpusMatching: corpusDiff.matching,
    scenarioTotal: scenarios.length,
    scenarioPassing: scenarios.length - failing.length,
    scenarioMatching: scenarioDiff.matching,
    records,
    clientKind: kind,
  }));
}
```

`runCorpusEntry` returns `{ outcome, run, setup }`; only `run.record` (the utterance turn) is collected, per the spec. Scenario records cover every step turn including the setup turn, whose source is `none` and does not count as answered.

Deviation: the corpus path is `DEFAULT_CORPUS_FILE` from `src/run/client.ts` (same literal as before) instead of a second copy of the string.

- [ ] **Step 2: Typecheck and test**

Run: `pnpm typecheck` then `pnpm test`
Expected: clean, all passing.

- [ ] **Step 3: Manual verification**

Run: `pnpm regress`
Expected: `no changes`, a blank line, then the summary with `corpus     154/154`, `scenarios   35/35 pass expectation,  35/35 match expected`, no cost line, a latency line. Exit code 0.

Run: `pnpm regress --client recorded`
Expected (no cassette committed yet): every corpus line diffs, the summary ends with `cassette misses N` where N is the number of answered turns attempted, exit code 1. This proves a stale cassette is loud.

Run: `pnpm regress --client nope`
Expected: error naming the five kinds, non-zero exit.

Run: `pnpm regress --client recorded --update`
Expected: the stub-only message on stderr, exit code 1, `fixtures/expected/` unchanged (`git status --short fixtures/` is empty).

- [ ] **Step 4: Commit**

```bash
git add src/harness-text/regress.ts
git commit -m "feat(harness): regress --client with stub-only --update and a run summary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: README

**Files:**
- Modify: `README.md:40-45`

- [ ] **Step 1: Replace the Regression section**

Replace lines 40–45 of `README.md` with:

```markdown
## Regression

    pnpm regress                       # stub: diff outcomes against fixtures/expected
    pnpm regress --update              # re-record the baseline after an intended change (stub only)
    pnpm regress --client record       # real model; records every answer into fixtures/recorded
    pnpm regress --client recorded     # replay the recording offline; a miss is a failed turn
    pnpm regress --client jev          # real model, nothing recorded

Outcomes include the final decision, prompt id, deciding gate, filled slots, and implicit-confirm acks, so a threshold change that only alters spoken confirmations still shows up in the diff.

The baseline in `fixtures/expected/` is what the decision core does given
label-perfect answers from the fixture stub. Real-model runs diff against
that same baseline, so every line is either Jev disagreeing with a corpus
label or a threshold mapping a real distribution wrongly. `--update` is
therefore refused for any client but the stub.

Every run ends with a summary: corpus outcomes matching, scenarios passing
their own expectation and matching the baseline, cost and request count for
real or replayed runs, and ask latency p50/p95.

`fixtures/recorded/<model>.jsonl` is the answer cassette, one file per pinned
model version, keyed by a hash of the request state and questions. It holds
corpus text and model output only, no caller data, and is committed. Record
once with the key in the shell (`set -a; source .env; set +a`), commit the
file, and tune thresholds against `--client recorded` for free. A threshold
change that alters an earlier turn changes the next turn's state and misses
the cassette; run `--client record` again to fill the gaps.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: regression client kinds and the answer cassette

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8 (Jason, not an agent): record the cassette

The key never enters an agent's context. With the branch checked out:

```bash
set -a; source .env; set +a; pnpm regress --client record
```

Expected: about 260 live requests over roughly three minutes, a diff against the label baseline, and a summary with a cost line and no tag. Then:

```bash
pnpm regress --client recorded
```

Expected: the same diff lines, the summary tagged `[replayed]`, no `cassette misses` line. Commit `fixtures/recorded/jev-1.13.0.jsonl` on the branch:

```bash
git add fixtures/recorded/jev-1.13.0.jsonl
git commit -m "fixtures: record jev-1.13.0 answers for the corpus and scenarios

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

The diff output from either run is the input to the threshold-tuning sub-project.

---

## Self-review

- Spec §2 key, file, modes, lazy load, synchronous append: Tasks 1–3.
- Spec §3 kinds, `cassettePath` from `JEV_MODEL`, unknown kind throws, CLI unchanged: Task 4. Deviation: the SDK client throws at construction without `TYPESAFE_API_KEY`, so `jev` and `record` fail fast at build time rather than on the first request; the spec's "no key needed" applies to `recorded` only, as tested.
- Spec §4 `--client`, stub-only `--update`, summary lines, tags, exit codes, misses line: Tasks 5–6.
- Spec §5 no runner change, sequential order: Task 6 loops as before.
- Spec §6 tests: Tasks 1–5; manual: Task 6 Step 3 and Task 8.
- Spec §7 README: Task 7.
- Names used across tasks: `requestKey`, `loadCassette`, `appendCassette`, `CassetteLine`, `CassetteClient`, `cassettePath`, `CLIENT_KINDS`, `formatRegressSummary`, `RegressSummaryInput` are defined before use.

---

## Deviations recorded during execution

Each was raised by a spec or quality review, accepted by the controller, and applied by the task's implementer before the task was marked complete.

- **Task 1.** `canonicalJson` maps array elements JSON.stringify cannot represent (undefined, functions, symbols, holes) to `null` instead of producing invalid JSON; a golden-digest test pins the canonical form so a future change fails here rather than as cassette misses. Doc comment states that `toJSON` is not honored.
- **Task 2.** Load errors carry a 60-char excerpt and the recovery hint ("append-only, delete this line and re-record"); a line must also have `answers`, `model`, and numeric `usage` fields, so a hand-edited line cannot replay as a silent no-answer or zero-cost turn.
- **Task 3.** `CassetteOptions.expectModel`: a loaded line or a live answer whose model differs from the pin aborts with a plain `Error` naming the fix (bump `JEV_MODEL`, record a fresh file). `preload()` lets the builder fail at startup on a corrupt file while the class stays lazy. The replay-miss message names the cassette path; its `cassette miss:` prefix is exported as `CASSETTE_MISS` and shared with the summary. Class doc notes it is not safe for concurrent identical asks.
- **Task 4.** `isClientKind` type guard plus an exhaustive switch (no default) replace the cast-and-default; `record` also preloads; the builder tests moved from `cli.test.ts` to `src/run/client.test.ts`. The SDK client throws at construction without a key, so `jev` and `record` fail fast at build time; only `recorded` runs without a key.
- **Task 5.** The cost line is gated on priced answers (`usage.estimated === false`) rather than on the client kind, so the keyword stub's estimated tokens are never printed as dollars; `clientKind` was dropped from the formatter's input. The latency line is labelled `ask latency ms` (the CLI prints a different `decision latency ms`) and is omitted when nothing was answered; the `[replayed]`/`[mixed]` tag appears on the cost line only. Sources are filtered by an inverted `UNANSWERED` set so a new `AnswerSource` is counted in. Token grouping is ICU-free.
- **Task 6.** `diffOne`/`diff` live in `regressDiff.ts` with four tests. The loops and diff run inside `try`/`finally` so an aborted live run still prints the summary (and the money spent); the `--update` path is excluded from that. The top-level catch prints the message only and sets `process.exitCode`. Live kinds print progress to stderr (every 25 corpus entries, each scenario) so stdout stays a clean diff artifact. Before a cassette run the runner prints the cassette path and whether it exists.
- **Task 7.** `.gitattributes` marks the cassette `linguist-generated` so GitHub collapses it in PR diffs. README records the operational notes from review: record at default thresholds, Ctrl-C is safe and resumable, the free lower-bound request count from an empty-cassette replay, corrupt-line recovery, the CLI appending to the same file, and the unit suite validating the committed cassette.

Deferred, not in this branch: `src/server/config.ts` declares its own narrower `ClientKind` under the same name as `src/run/client.ts`; derive it from `CLIENT_KINDS` in a server-side change. The absent-cassette case is silent from the CLI (only the regression runner prints the notice).
