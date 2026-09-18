# Decision Core and Text Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 0–1 deliverable from the spec: a pure decision core for the healthcare scheduling IVR, a stub Jev client, a labeled corpus, and a text harness CLI that prints probability and gate tables and writes JSONL traces.

**Architecture:** The core is two pure functions, `plan()` and `resolve()`, with the model call between them. Slot specs contribute their own questions and fill logic. Every threshold is a named constant in one file. The Jev client is an interface with fixture, heuristic, and SDK implementations.

**Tech Stack:** TypeScript 5 (strict, ESM), Node 20+, pnpm, vitest, tsx, `@typesafe-ai/sdk` 0.6.

**Spec:** `docs/superpowers/specs/2026-09-18-text-harness-design.md`. Read it first. Where this plan and the spec differ on small points, the plan wins; each such point is called out with "Deviation:".

**Conventions for every task:**

- Tests are colocated: `src/foo/bar.ts` has `src/foo/bar.test.ts`.
- Run a single test file with `pnpm vitest run <path>`. Run everything with `pnpm test`.
- Imports are extensionless (`moduleResolution: Bundler`).
- Commit after every task with the message shown. Do not bundle tasks.
- Never import `@typesafe-ai/sdk` outside `src/jev/sdkClient.ts`.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/jev/types.ts` | Our own Question, Answer, JevClient types and probability helpers |
| `src/jev/heuristicStub.ts` | Keyword stub for ad-hoc REPL input |
| `src/jev/fixtureStub.ts` | Corpus-keyed deterministic stub with overrides and failure injection |
| `src/jev/sdkClient.ts` | Real client wrapping the SDK, type mapping only |
| `src/channel/frames.ts` | ConversationRelay inbound and outbound frame types |
| `src/domain/intents.ts` | Intent set and labels |
| `src/domain/forms.ts` | Forms, required slots, completion behavior |
| `src/domain/providers.json` | Provider roster |
| `src/domain/dtmf-baseline.json` | DTMF turns-to-completion per form |
| `src/domain/slots/types.ts` | SlotSpec interface and SlotOutcome union |
| `src/domain/slots/memberId.ts` | Extracted slot: questions, fill, DTMF rule |
| `src/domain/slots/provider.ts` | Choice slot |
| `src/domain/slots/date.ts` | Date component slot |
| `src/domain/slots/index.ts` | Slot registry |
| `src/core/thresholds.ts` | Every threshold, with override support |
| `src/core/extract/spokenNumber.ts` | Number words to digits |
| `src/core/extract/mask.ts` | Regex validation |
| `src/core/extract/date.ts` | Component resolver |
| `src/core/extract/llmNormalizer.ts` | Tier 3b interface and unavailable stub |
| `src/core/spans.ts` | Candidate span generation |
| `src/core/session.ts` | Session type, constructor, buckets |
| `src/core/state.ts` | TurnState assembly |
| `src/core/questions.ts` | Turn schema builder |
| `src/core/gates.ts` | Gate ladder |
| `src/core/fia.ts` | Slot filling, next prompt, retry policy |
| `src/core/decision.ts` | Decision union |
| `src/core/turn.ts` | `plan()` and `resolve()` |
| `src/prompts/manifest.json` | Prompt ids, text templates, flags |
| `src/prompts/render.ts` | Template rendering and decision to frames |
| `src/trace/types.ts` | TraceRecord |
| `src/trace/writer.ts` | JSONL append |
| `src/harness-text/runner.ts` | `runTurn()` with client and error handling, corpus and scenario runners |
| `src/harness-text/metrics.ts` | Run summary |
| `src/harness-text/print.ts` | Tables |
| `src/harness-text/cli.ts` | Entry point |
| `src/harness-text/regress.ts` | Expected-outcome diffing |
| `fixtures/corpus.jsonl` | Labeled utterances |
| `fixtures/scenarios/core.json` | Multi-turn scripts |
| `fixtures/expected/*.json` | Recorded regression outcomes |

Deviation: scenarios live in one file `fixtures/scenarios/core.json` (an array) rather than one file per scenario. The runner still accepts a directory of `*.json` files, each holding an array.

---

### Task 1: Scaffold the package

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.nvmrc`, `src/smoke.test.ts`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "jev-ivr",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "cli": "tsx src/harness-text/cli.ts",
    "regress": "tsx src/harness-text/regress.ts"
  },
  "dependencies": {
    "@typesafe-ai/sdk": "^0.6.0"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Write vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Write .gitignore and .nvmrc**

`.gitignore`:

```
node_modules/
traces/
.env
*.log
```

`.nvmrc`:

```
20
```

- [ ] **Step 5: Write a smoke test**

`src/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Install and run**

Run: `pnpm install && pnpm test && pnpm typecheck`
Expected: 1 test passed; typecheck exits 0. If `@typesafe-ai/sdk@^0.6.0` cannot be resolved, run `pnpm view @typesafe-ai/sdk versions` and pin the newest 0.x listed, then note the version in the commit message.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore .nvmrc src/smoke.test.ts
git commit -m "chore: scaffold TypeScript package with vitest and tsx"
```

---

### Task 2: Jev client types and probability helpers

**Files:**
- Create: `src/jev/types.ts`, `src/jev/types.test.ts`

- [ ] **Step 1: Write the failing test**

`src/jev/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rankProbabilities, topMargin, type ChoiceAnswer } from './types';

describe('rankProbabilities', () => {
  it('sorts labels by probability descending', () => {
    const ranked = rankProbabilities({ a: 0.2, b: 0.7, c: 0.1 });
    expect(ranked).toEqual([
      { label: 'b', p: 0.7 },
      { label: 'a', p: 0.2 },
      { label: 'c', p: 0.1 },
    ]);
  });
});

describe('topMargin', () => {
  it('returns top1 minus top2', () => {
    const answer: ChoiceAnswer = {
      type: 'choice',
      choice: 'b',
      probabilities: { a: 0.2, b: 0.7, c: 0.1 },
      confidence: 0.7,
    };
    expect(topMargin(answer.probabilities)).toBeCloseTo(0.5);
  });

  it('returns 1 when there is only one label', () => {
    expect(topMargin({ only: 1 })).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/jev/types.test.ts`
Expected: FAIL, cannot find module './types'.

- [ ] **Step 3: Write the types**

`src/jev/types.ts`:

```ts
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** label -> short description, or null for self-describing labels */
  criteria: Record<string, string | null>;
}

export interface ScoreLevel {
  label: string;
  description: string;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** ordered from lowest to highest; index 0 is level 1 */
  levels: ScoreLevel[];
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type QuestionMap = Record<string, Question>;

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** expected level, 1-based, may be fractional */
  score: number;
  /** keyed by level label, not level number */
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export type AnswerMap = Record<string, Answer>;

export type AnswerSource = 'jev' | 'stub:fixture' | 'stub:heuristic' | 'replay';

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

export interface JevRequest {
  state: JsonValue;
  questions: QuestionMap;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface JevResponse {
  answers: AnswerMap;
  model: string;
  usage: JevUsage;
  latencyMs: number;
  source: AnswerSource;
}

export interface JevClient {
  ask(req: JevRequest): Promise<JevResponse>;
}

export class JevClientError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'JevClientError';
  }
}

export interface Ranked {
  label: string;
  p: number;
}

export function rankProbabilities(probabilities: Record<string, number>): Ranked[] {
  return Object.entries(probabilities)
    .map(([label, p]) => ({ label, p }))
    .sort((a, b) => b.p - a.p);
}

export function topMargin(probabilities: Record<string, number>): number {
  const ranked = rankProbabilities(probabilities);
  const first = ranked[0]?.p ?? 0;
  const second = ranked[1]?.p;
  return second === undefined ? 1 : first - second;
}

export function isChoice(a: Answer | undefined): a is ChoiceAnswer {
  return a?.type === 'choice';
}
export function isScore(a: Answer | undefined): a is ScoreAnswer {
  return a?.type === 'score';
}
export function isNoul(a: Answer | undefined): a is NoulAnswer {
  return a?.type === 'noul';
}

/** Read a noul value or return 0 when the answer is missing or the wrong type. */
export function noulValue(answers: AnswerMap, id: string): number {
  const a = answers[id];
  return isNoul(a) ? a.noul : 0;
}

/** Estimate tokens for stubs: JSON length over four. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/jev/types.test.ts`
Expected: 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/jev/types.ts src/jev/types.test.ts
git commit -m "feat(jev): add client interface, question and answer types"
```

---

### Task 3: ConversationRelay frame types

**Files:**
- Create: `src/channel/frames.ts`, `src/channel/frames.test.ts`

- [ ] **Step 1: Write the failing test**

`src/channel/frames.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { promptFrame, dtmfFrames, endFrame, type OutboundFrame } from './frames';

describe('frame constructors', () => {
  it('builds a final prompt frame', () => {
    expect(promptFrame('hello')).toEqual({
      type: 'prompt',
      voicePrompt: 'hello',
      lang: 'en-US',
      last: true,
    });
  });

  it('builds one dtmf frame per digit', () => {
    expect(dtmfFrames('12#')).toEqual([
      { type: 'dtmf', digit: '1' },
      { type: 'dtmf', digit: '2' },
      { type: 'dtmf', digit: '#' },
    ]);
  });

  it('json-encodes handoff data on end frames', () => {
    const frame: OutboundFrame = endFrame('live-agent');
    expect(frame).toEqual({
      type: 'end',
      handoffData: '{"reasonCode":"live-agent"}',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channel/frames.test.ts`
Expected: FAIL, cannot find module './frames'.

- [ ] **Step 3: Write the frame types**

`src/channel/frames.ts`:

```ts
// Twilio ConversationRelay message protocol. This IS the internal protocol.
// Field names match the Twilio docs exactly; do not rename.

export interface SetupFrame {
  type: 'setup';
  sessionId: string;
  callSid: string;
  from: string;
  to: string;
  customParameters: Record<string, string>;
}

export interface PromptFrame {
  type: 'prompt';
  voicePrompt: string;
  lang: string;
  last: boolean;
}

export interface DtmfFrame {
  type: 'dtmf';
  digit: string;
}

export interface InterruptFrame {
  type: 'interrupt';
  utteranceUntilInterrupt: string;
  durationUntilInterruptMs: number;
}

export interface ErrorFrame {
  type: 'error';
  description: string;
}

export type InboundFrame = SetupFrame | PromptFrame | DtmfFrame | InterruptFrame | ErrorFrame;

export interface TextFrame {
  type: 'text';
  token: string;
  last: boolean;
  lang: string;
  interruptible: boolean;
  preemptible: boolean;
}

export interface PlayFrame {
  type: 'play';
  source: string;
  loop: number;
  preemptible: boolean;
  interruptible: boolean;
}

export interface SendDigitsFrame {
  type: 'sendDigits';
  digits: string;
}

export interface LanguageFrame {
  type: 'language';
  ttsLanguage: string;
  transcriptionLanguage: string;
}

export interface EndFrame {
  type: 'end';
  handoffData: string;
}

export type OutboundFrame = TextFrame | PlayFrame | SendDigitsFrame | LanguageFrame | EndFrame;

export const DEFAULT_LANG = 'en-US';

export function promptFrame(text: string, last = true): PromptFrame {
  return { type: 'prompt', voicePrompt: text, lang: DEFAULT_LANG, last };
}

export function dtmfFrames(digits: string): DtmfFrame[] {
  return [...digits].map((digit) => ({ type: 'dtmf', digit }));
}

export function setupFrame(sessionId: string): SetupFrame {
  return {
    type: 'setup',
    sessionId,
    callSid: `CA-${sessionId}`,
    from: '+15550000001',
    to: '+15550000002',
    customParameters: {},
  };
}

export function textFrame(token: string, interruptible: boolean): TextFrame {
  return { type: 'text', token, last: true, lang: DEFAULT_LANG, interruptible, preemptible: false };
}

export function endFrame(reasonCode: string): EndFrame {
  return { type: 'end', handoffData: JSON.stringify({ reasonCode }) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channel/frames.test.ts`
Expected: 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/channel/frames.ts src/channel/frames.test.ts
git commit -m "feat(channel): add ConversationRelay frame types"
```

---

### Task 4: Thresholds

**Files:**
- Create: `src/core/thresholds.ts`, `src/core/thresholds.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/thresholds.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, withOverrides, parseOverride } from './thresholds';

describe('thresholds', () => {
  it('applies a single override without mutating defaults', () => {
    const t = withOverrides({ INTENT_ROUTE: 0.9 });
    expect(t.INTENT_ROUTE).toBe(0.9);
    expect(DEFAULT_THRESHOLDS.INTENT_ROUTE).toBe(0.85);
  });

  it('parses NAME=VALUE strings', () => {
    expect(parseOverride('GATE_ADDRESSED=0.5')).toEqual({ GATE_ADDRESSED: 0.5 });
  });

  it('rejects unknown names', () => {
    expect(() => parseOverride('NOPE=1')).toThrow(/unknown threshold/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/thresholds.test.ts`
Expected: FAIL, cannot find module './thresholds'.

- [ ] **Step 3: Write thresholds**

`src/core/thresholds.ts`:

```ts
// Every value here is a PLACEHOLDER until tuned against real Jev fixtures
// (handoff §6, §12). Change values here or via `--threshold NAME=VALUE`.

export const DEFAULT_THRESHOLDS = {
  // gate ladder
  GATE_ADDRESSED: 0.7,
  GATE_INTELLIGIBLE: 0.5,
  GATE_COMPLETE: 0.6,
  GATE_WANTS_HUMAN: 0.7,
  INTENT_ROUTE: 0.85,
  INTENT_IMPLICIT: 0.6,
  INTENT_EXPLICIT: 0.4,
  INTENT_SWITCH: 0.85,
  GATE_INTENT_MARGIN: 0.15,
  GATE_FRUSTRATION_HIGH: 0.6,
  // slots
  SLOT_DETECT: 0.6,
  SLOT_CHOICE_FILL: 0.7,
  SLOT_CHOICE_CONFIRM: 0.45,
  SLOT_CHOICE_MARGIN: 0.15,
  // confirmations and menus
  CONFIRM_YES: 0.7,
  CONFIRM_NO: 0.7,
  MENU_NUMBER: 0.7,
  // retry policy
  MAX_ATTEMPTS: 3,
  // stub and client
  STUB_SHARPNESS: 0.9,
  JEV_TIMEOUT_MS: 1500,
  JEV_PRICE_PER_MTOK: 0.042,
} as const;

export type ThresholdName = keyof typeof DEFAULT_THRESHOLDS;
export type Thresholds = { -readonly [K in ThresholdName]: number };

export function withOverrides(overrides: Partial<Thresholds>): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...overrides };
}

export function parseOverride(spec: string): Partial<Thresholds> {
  const [name, raw] = spec.split('=');
  if (!name || raw === undefined) throw new Error(`bad threshold override: ${spec}`);
  if (!(name in DEFAULT_THRESHOLDS)) throw new Error(`unknown threshold: ${name}`);
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`bad threshold value: ${spec}`);
  return { [name]: value } as Partial<Thresholds>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/thresholds.test.ts`
Expected: 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/thresholds.ts src/core/thresholds.test.ts
git commit -m "feat(core): add placeholder thresholds with override parsing"
```

---

### Task 5: Spoken number normalizer

**Files:**
- Create: `src/core/extract/spokenNumber.ts`, `src/core/extract/spokenNumber.test.ts`

Deviation: "hundred" and larger place values are not supported. Member IDs are spoken as digit strings or pairs; hundreds would need a real accumulator and no v1 slot needs it.

- [ ] **Step 1: Write the failing test**

`src/core/extract/spokenNumber.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { spokenToDigits } from './spokenNumber';

describe('spokenToDigits', () => {
  it.each([
    ['four four seven one eight two nine three', '44718293'],
    ['forty four seventy one eighty two ninety three', '44718293'],
    ['double four 71 82 93', '44718293'],
    ['my member id is 4471 8293', '44718293'],
    ['eight oh seven', '807'],
    ['twelve fifteen', '1215'],
    ['twenty', '20'],
    ['triple seven', '777'],
    ['four-four-seven', '447'],
    ['hello there', ''],
  ])('%s -> %s', (input, expected) => {
    expect(spokenToDigits(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/extract/spokenNumber.test.ts`
Expected: FAIL, cannot find module './spokenNumber'.

- [ ] **Step 3: Write the normalizer**

`src/core/extract/spokenNumber.ts`:

```ts
const UNITS: Record<string, number> = {
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const REPEATS: Record<string, number> = { double: 2, triple: 3 };

export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...Object.keys(UNITS), ...Object.keys(TEENS), ...Object.keys(TENS), ...Object.keys(REPEATS),
]);

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Convert spoken number words to a digit string. Non-number tokens are
 * ignored so a loosely chosen span still yields digits; the slot mask
 * decides whether the result is acceptable.
 */
export function spokenToDigits(text: string): string {
  let out = '';
  let pendingTens: number | null = null;
  let repeat = 1;

  const emit = (n: number): void => {
    out += String(n).repeat(repeat);
    repeat = 1;
  };
  const flush = (): void => {
    if (pendingTens !== null) {
      emit(pendingTens);
      pendingTens = null;
    }
  };

  for (const tok of tokenize(text)) {
    if (/^\d+$/.test(tok)) {
      flush();
      out += tok.repeat(repeat);
      repeat = 1;
    } else if (tok in REPEATS) {
      flush();
      repeat = REPEATS[tok]!;
    } else if (tok in UNITS) {
      const unit = UNITS[tok]!;
      if (pendingTens !== null && unit !== 0) {
        emit(pendingTens + unit);
        pendingTens = null;
      } else {
        flush();
        emit(unit);
      }
    } else if (tok in TEENS) {
      flush();
      emit(TEENS[tok]!);
    } else if (tok in TENS) {
      flush();
      pendingTens = TENS[tok]!;
    }
    // any other token is ignored
  }
  flush();
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/extract/spokenNumber.test.ts`
Expected: 10 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/extract/spokenNumber.ts src/core/extract/spokenNumber.test.ts
git commit -m "feat(extract): add spoken number to digits normalizer"
```

---

### Task 6: Mask validation

**Files:**
- Create: `src/core/extract/mask.ts`, `src/core/extract/mask.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/extract/mask.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MEMBER_ID_MASK, matchesMask } from './mask';

describe('matchesMask', () => {
  it('accepts eight digits as a member id', () => {
    expect(matchesMask('44718293', MEMBER_ID_MASK)).toBe(true);
  });
  it('rejects seven digits', () => {
    expect(matchesMask('4471829', MEMBER_ID_MASK)).toBe(false);
  });
  it('rejects letters', () => {
    expect(matchesMask('4471829A', MEMBER_ID_MASK)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/extract/mask.test.ts`
Expected: FAIL, cannot find module './mask'.

- [ ] **Step 3: Write mask.ts**

`src/core/extract/mask.ts`:

```ts
export const MEMBER_ID_MASK = /^\d{8}$/;

export function matchesMask(value: string, mask: RegExp): boolean {
  return mask.test(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/extract/mask.test.ts`
Expected: 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/extract/mask.ts src/core/extract/mask.test.ts
git commit -m "feat(extract): add mask validation"
```

---

### Task 7: Date component resolver

**Files:**
- Create: `src/core/extract/date.ts`, `src/core/extract/date.test.ts`

All arithmetic is in UTC on ISO `YYYY-MM-DD` strings. Weeks start Monday.

- [ ] **Step 1: Write the failing test**

`src/core/extract/date.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveDate, type DateComponents } from './date';

// 2026-09-18 is a Friday.
const TODAY = '2026-09-18';

function comps(partial: Partial<Record<keyof DateComponents, string>>): DateComponents {
  const pick = (k: keyof DateComponents) => ({ choice: partial[k] ?? 'none', p: 0.9 });
  return {
    mode: pick('mode'),
    month: pick('month'),
    day: pick('day'),
    weekday: pick('weekday'),
    weekdayQualifier: pick('weekdayQualifier'),
    relativeDay: pick('relativeDay'),
    window: pick('window'),
  };
}

describe('resolveDate', () => {
  it('returns none when no date is mentioned', () => {
    expect(resolveDate(comps({}), TODAY)).toEqual({ kind: 'none' });
  });

  it('resolves tomorrow', () => {
    expect(resolveDate(comps({ mode: 'relative_day', relativeDay: 'tomorrow' }), TODAY))
      .toEqual({ kind: 'day', iso: '2026-09-19', confidence: 0.9 });
  });

  it('resolves a bare weekday to the next occurrence after today', () => {
    expect(resolveDate(comps({ mode: 'weekday', weekday: 'tuesday' }), TODAY))
      .toMatchObject({ kind: 'day', iso: '2026-09-22' });
  });

  it('resolves the same weekday as today to a week ahead', () => {
    expect(resolveDate(comps({ mode: 'weekday', weekday: 'friday' }), TODAY))
      .toMatchObject({ kind: 'day', iso: '2026-09-25' });
  });

  it('resolves "next friday" to the friday of next week', () => {
    expect(resolveDate(comps({ mode: 'weekday', weekday: 'friday', weekdayQualifier: 'next' }), TODAY))
      .toMatchObject({ kind: 'day', iso: '2026-09-25' });
  });

  it('resolves next week to a window', () => {
    expect(resolveDate(comps({ mode: 'window', window: 'next_week' }), TODAY))
      .toEqual({ kind: 'window', start: '2026-09-21', end: '2026-09-27', label: 'next_week', confidence: 0.9 });
  });

  it('resolves this week from today to sunday', () => {
    expect(resolveDate(comps({ mode: 'window', window: 'this_week' }), TODAY))
      .toMatchObject({ kind: 'window', start: '2026-09-18', end: '2026-09-20' });
  });

  it('places a past absolute date in the next year', () => {
    expect(resolveDate(comps({ mode: 'absolute', month: 'march', day: '3' }), TODAY))
      .toMatchObject({ kind: 'day', iso: '2027-03-03' });
  });

  it('keeps an upcoming absolute date in this year', () => {
    expect(resolveDate(comps({ mode: 'absolute', month: 'october', day: '5' }), TODAY))
      .toMatchObject({ kind: 'day', iso: '2026-10-05' });
  });

  it('rejects impossible dates', () => {
    expect(resolveDate(comps({ mode: 'absolute', month: 'february', day: '30' }), TODAY))
      .toEqual({ kind: 'none' });
  });

  it('treats a month without a day as a window', () => {
    expect(resolveDate(comps({ mode: 'absolute', month: 'december' }), TODAY))
      .toMatchObject({ kind: 'window', start: '2026-12-01', end: '2026-12-31', label: 'december' });
  });

  it('uses the weakest component as confidence', () => {
    const c = comps({ mode: 'absolute', month: 'october', day: '5' });
    c.day.p = 0.55;
    expect(resolveDate(c, TODAY)).toMatchObject({ confidence: 0.55 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/extract/date.test.ts`
Expected: FAIL, cannot find module './date'.

- [ ] **Step 3: Write the resolver**

`src/core/extract/date.ts`:

```ts
export interface Pick {
  choice: string;
  p: number;
}

export interface DateComponents {
  mode: Pick;            // absolute | relative_day | weekday | window | none
  month: Pick;           // january..december | none
  day: Pick;             // 1..31 | none
  weekday: Pick;         // monday..sunday | none
  weekdayQualifier: Pick; // this | next | none
  relativeDay: Pick;     // today | tomorrow | day_after_tomorrow | none
  window: Pick;          // this_week | next_week | this_month | next_month | none
}

export interface DateWindow {
  start: string;
  end: string;
  label: string;
}

export type DateResolution =
  | { kind: 'day'; iso: string; confidence: number }
  | ({ kind: 'window'; confidence: number } & DateWindow)
  | { kind: 'none' };

export const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export const DATE_MODES = ['absolute', 'relative_day', 'weekday', 'window', 'none'] as const;
export const RELATIVE_DAYS = ['today', 'tomorrow', 'day_after_tomorrow', 'none'] as const;
export const WINDOWS = ['this_week', 'next_week', 'this_month', 'next_month', 'none'] as const;
export const QUALIFIERS = ['this', 'next', 'none'] as const;

const DAY_MS = 86_400_000;

export function parseIso(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toIso(parseIso(iso) + days * DAY_MS);
}

/** Monday = 0 ... Sunday = 6 */
function weekdayIndex(iso: string): number {
  return (new Date(parseIso(iso)).getUTCDay() + 6) % 7;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function endOfMonth(year: number, monthIndex: number): string {
  return toIso(Date.UTC(year, monthIndex, daysInMonth(year, monthIndex)));
}

function minP(...picks: Pick[]): number {
  return Math.min(...picks.map((p) => p.p));
}

export function resolveDate(c: DateComponents, todayIso: string): DateResolution {
  const today = new Date(parseIso(todayIso));
  const year = today.getUTCFullYear();

  switch (c.mode.choice) {
    case 'relative_day': {
      const offset = { today: 0, tomorrow: 1, day_after_tomorrow: 2 }[c.relativeDay.choice];
      if (offset === undefined) return { kind: 'none' };
      return { kind: 'day', iso: addDays(todayIso, offset), confidence: minP(c.mode, c.relativeDay) };
    }

    case 'weekday': {
      const target = WEEKDAYS.indexOf(c.weekday.choice as (typeof WEEKDAYS)[number]);
      if (target < 0) return { kind: 'none' };
      const todayIdx = weekdayIndex(todayIso);
      let iso: string;
      if (c.weekdayQualifier.choice === 'next') {
        const nextMonday = addDays(todayIso, 7 - todayIdx);
        iso = addDays(nextMonday, target);
      } else {
        const ahead = ((target - todayIdx + 7) % 7) || 7;
        iso = addDays(todayIso, ahead);
      }
      const picks = [c.mode, c.weekday];
      if (c.weekdayQualifier.choice !== 'none') picks.push(c.weekdayQualifier);
      return { kind: 'day', iso, confidence: minP(...picks) };
    }

    case 'window': {
      const todayIdx = weekdayIndex(todayIso);
      const monthIdx = today.getUTCMonth();
      const confidence = minP(c.mode, c.window);
      const label = c.window.choice;
      switch (label) {
        case 'this_week':
          return { kind: 'window', start: todayIso, end: addDays(todayIso, 6 - todayIdx), label, confidence };
        case 'next_week': {
          const start = addDays(todayIso, 7 - todayIdx);
          return { kind: 'window', start, end: addDays(start, 6), label, confidence };
        }
        case 'this_month':
          return { kind: 'window', start: todayIso, end: endOfMonth(year, monthIdx), label, confidence };
        case 'next_month': {
          const y = monthIdx === 11 ? year + 1 : year;
          const m = (monthIdx + 1) % 12;
          return { kind: 'window', start: toIso(Date.UTC(y, m, 1)), end: endOfMonth(y, m), label, confidence };
        }
        default:
          return { kind: 'none' };
      }
    }

    case 'absolute': {
      const monthIdx = MONTHS.indexOf(c.month.choice as (typeof MONTHS)[number]);
      if (monthIdx < 0) return { kind: 'none' };
      if (c.day.choice === 'none') {
        const y = monthIdx < today.getUTCMonth() ? year + 1 : year;
        return {
          kind: 'window',
          start: toIso(Date.UTC(y, monthIdx, 1)),
          end: endOfMonth(y, monthIdx),
          label: c.month.choice,
          confidence: minP(c.mode, c.month),
        };
      }
      const day = Number(c.day.choice);
      if (!Number.isInteger(day) || day < 1) return { kind: 'none' };
      let y = year;
      if (day > daysInMonth(y, monthIdx)) return { kind: 'none' };
      let iso = toIso(Date.UTC(y, monthIdx, day));
      if (parseIso(iso) < parseIso(todayIso) - 31 * DAY_MS) {
        y += 1;
        if (day > daysInMonth(y, monthIdx)) return { kind: 'none' };
        iso = toIso(Date.UTC(y, monthIdx, day));
      }
      return { kind: 'day', iso, confidence: minP(c.mode, c.month, c.day) };
    }

    default:
      return { kind: 'none' };
  }
}

/** Human-readable form for prompts, e.g. "Tuesday, September 22". */
export function describeDay(iso: string): string {
  const d = new Date(parseIso(iso));
  const wd = WEEKDAYS[weekdayIndex(iso)]!;
  const mo = MONTHS[d.getUTCMonth()]!;
  const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
  return `${cap(wd)}, ${cap(mo)} ${d.getUTCDate()}`;
}

export function describeWindow(w: DateWindow): string {
  return w.label.replace(/_/g, ' ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/extract/date.test.ts`
Expected: 12 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/extract/date.ts src/core/extract/date.test.ts
git commit -m "feat(extract): add date component resolver"
```

---

### Task 8: Tier 3b normalizer interface

**Files:**
- Create: `src/core/extract/llmNormalizer.ts`, `src/core/extract/llmNormalizer.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/extract/llmNormalizer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { unavailableNormalizer } from './llmNormalizer';

describe('unavailableNormalizer', () => {
  it('always reports unavailable', async () => {
    const result = await unavailableNormalizer.normalize({
      slotType: 'memberId',
      spanText: 'four four',
      fullTranscript: 'it is four four',
      expectedMask: '^\\d{8}$',
      attempt: 1,
    });
    expect(result).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/extract/llmNormalizer.test.ts`
Expected: FAIL, cannot find module './llmNormalizer'.

- [ ] **Step 3: Write the interface**

`src/core/extract/llmNormalizer.ts`:

```ts
// Tier 3b (handoff §9). Interface only in this sub-project; the stub
// always reports unavailable so the retry policy reaches DTMF collection.

export interface ExtractionRequest {
  slotType: string;
  spanText: string;
  fullTranscript: string;
  expectedMask: string;
  attempt: number;
}

export interface ExtractionResult {
  value: string;
  confidence: number;
  needsConfirmation: boolean;
}

export interface LlmNormalizer {
  normalize(req: ExtractionRequest): Promise<ExtractionResult | 'unavailable'>;
}

export const unavailableNormalizer: LlmNormalizer = {
  async normalize() {
    return 'unavailable';
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/extract/llmNormalizer.test.ts`
Expected: 1 test passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/extract/llmNormalizer.ts src/core/extract/llmNormalizer.test.ts
git commit -m "feat(extract): add tier 3b normalizer interface with unavailable stub"
```

---

### Task 9: Candidate spans

**Files:**
- Create: `src/core/spans.ts`, `src/core/spans.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/spans.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { candidateSpans, MAX_SPANS } from './spans';

describe('candidateSpans', () => {
  it('includes n-grams containing a number word', () => {
    const spans = candidateSpans('my member id is four four seven');
    expect(spans).toContain('four four seven');
    expect(spans).toContain('is four four seven');
    expect(spans).toContain('my member id is four four seven');
  });

  it('excludes spans with no digits or number words', () => {
    expect(candidateSpans('my member id is four four seven')).not.toContain('my member id');
  });

  it('includes digit tokens', () => {
    expect(candidateSpans('it is 4471 8293')).toContain('4471 8293');
  });

  it('returns nothing for text without numbers', () => {
    expect(candidateSpans('I want to cancel')).toEqual([]);
  });

  it('caps the list', () => {
    const long = Array.from({ length: 60 }, (_, i) => (i % 2 ? 'four' : 'x')).join(' ');
    expect(candidateSpans(long).length).toBeLessThanOrEqual(MAX_SPANS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/spans.test.ts`
Expected: FAIL, cannot find module './spans'.

- [ ] **Step 3: Write spans.ts**

`src/core/spans.ts`:

```ts
import { NUMBER_WORDS, tokenize } from './extract/spokenNumber';

export const MAX_SPANS = 120;
export const MAX_NGRAM = 10;

function isNumberish(tok: string): boolean {
  return /\d/.test(tok) || NUMBER_WORDS.has(tok);
}

/**
 * All n-grams (1..MAX_NGRAM tokens) that contain at least one digit or
 * number word, deduplicated in document order, capped at MAX_SPANS.
 * Shorter spans come first so the cap keeps the tight candidates.
 */
export function candidateSpans(text: string): string[] {
  const tokens = tokenize(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let n = 1; n <= MAX_NGRAM && out.length < MAX_SPANS; n++) {
    for (let i = 0; i + n <= tokens.length && out.length < MAX_SPANS; i++) {
      const slice = tokens.slice(i, i + n);
      if (!slice.some(isNumberish)) continue;
      const span = slice.join(' ');
      if (seen.has(span)) continue;
      seen.add(span);
      out.push(span);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/spans.test.ts`
Expected: 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/spans.ts src/core/spans.test.ts
git commit -m "feat(core): add candidate span generation"
```

---

### Task 10: Domain: intents, forms, providers, DTMF baseline

**Files:**
- Create: `src/domain/intents.ts`, `src/domain/forms.ts`, `src/domain/providers.json`, `src/domain/dtmf-baseline.json`, `src/domain/domain.test.ts`

- [ ] **Step 1: Write the failing test**

`src/domain/domain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { INTENTS, INTENT_MENU, isFormIntent } from './intents';
import { FORMS, ALL_SLOTS } from './forms';
import providers from './providers.json';
import baseline from './dtmf-baseline.json';

describe('domain tables', () => {
  it('has the nine intents from the spec', () => {
    expect(INTENTS).toEqual([
      'schedule_new', 'reschedule', 'cancel', 'confirm_appointment', 'billing',
      'agent', 'repeat_prompt', 'other', 'none',
    ]);
  });

  it('every form slot is a known slot', () => {
    for (const form of Object.values(FORMS)) {
      for (const slot of form.slots) expect(ALL_SLOTS).toContain(slot);
    }
  });

  it('every form has a dtmf baseline', () => {
    for (const id of Object.keys(FORMS)) expect(baseline).toHaveProperty(id);
  });

  it('provider keys are unique and include the collision pair', () => {
    const keys = providers.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('chen');
    expect(keys).toContain('cheng');
  });

  it('menu digits map to form intents or agent', () => {
    for (const { intent } of INTENT_MENU) expect(isFormIntent(intent) || intent === 'agent').toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/domain/domain.test.ts`
Expected: FAIL, cannot find module './intents'.

- [ ] **Step 3: Write intents.ts**

`src/domain/intents.ts`:

```ts
export const INTENTS = [
  'schedule_new',
  'reschedule',
  'cancel',
  'confirm_appointment',
  'billing',
  'agent',
  'repeat_prompt',
  'other',
  'none',
] as const;
export type Intent = (typeof INTENTS)[number];

export const FORM_INTENTS = ['schedule_new', 'reschedule', 'cancel', 'confirm_appointment', 'billing'] as const;
export type FormId = (typeof FORM_INTENTS)[number];

export function isFormIntent(intent: string): intent is FormId {
  return (FORM_INTENTS as readonly string[]).includes(intent);
}

/** Criteria descriptions sent to the model. */
export const INTENT_CRITERIA: Record<Intent, string> = {
  schedule_new: 'Wants to book a new appointment that does not exist yet',
  reschedule: 'Wants to move an existing appointment to a different day',
  cancel: 'Wants to cancel an existing appointment',
  confirm_appointment: 'Wants to check or confirm the details of an existing appointment',
  billing: 'Asks about a bill, charge, payment, or insurance coverage',
  agent: 'Asks to speak with a person, representative, or operator',
  repeat_prompt: 'Asks the system to repeat what it just said',
  other: 'A request the clinic line does not handle',
  none: 'No request is expressed; the caller is only answering a question or saying something incidental',
};

/** Spoken labels for confirmation prompts. */
export const INTENT_LABELS: Record<Intent, string> = {
  schedule_new: 'schedule a new appointment',
  reschedule: 'reschedule an appointment',
  cancel: 'cancel an appointment',
  confirm_appointment: 'confirm an appointment',
  billing: 'ask about billing',
  agent: 'speak with someone',
  repeat_prompt: 'hear that again',
  other: 'something else',
  none: 'nothing',
};

export const INTENT_MENU: ReadonlyArray<{ digit: string; intent: Intent }> = [
  { digit: '1', intent: 'schedule_new' },
  { digit: '2', intent: 'reschedule' },
  { digit: '3', intent: 'cancel' },
  { digit: '4', intent: 'confirm_appointment' },
  { digit: '5', intent: 'billing' },
  { digit: '0', intent: 'agent' },
];
```

- [ ] **Step 4: Write forms.ts**

`src/domain/forms.ts`:

```ts
import type { FormId } from './intents';

export type SlotId = 'memberId' | 'provider' | 'date';
export const ALL_SLOTS: readonly SlotId[] = ['memberId', 'provider', 'date'];

export type FormCompletion =
  | { kind: 'prompt'; promptId: string }
  | { kind: 'handoff'; reason: string };

export interface FormSpec {
  /** in prompt priority order */
  slots: SlotId[];
  completion: FormCompletion;
}

export const FORMS: Record<FormId, FormSpec> = {
  schedule_new: {
    slots: ['memberId', 'provider', 'date'],
    completion: { kind: 'prompt', promptId: 'schedule_confirmed' },
  },
  reschedule: {
    slots: ['memberId', 'provider', 'date'],
    completion: { kind: 'prompt', promptId: 'reschedule_confirmed' },
  },
  cancel: {
    slots: ['memberId', 'provider'],
    completion: { kind: 'prompt', promptId: 'cancel_confirmed' },
  },
  confirm_appointment: {
    slots: ['memberId', 'provider'],
    completion: { kind: 'prompt', promptId: 'appointment_details' },
  },
  billing: {
    slots: ['memberId'],
    completion: { kind: 'handoff', reason: 'billing' },
  },
};
```

- [ ] **Step 5: Write providers.json and dtmf-baseline.json**

`src/domain/providers.json`:

```json
[
  { "key": "chen", "name": "Chen" },
  { "key": "cheng", "name": "Cheng" },
  { "key": "patel", "name": "Patel" },
  { "key": "okafor", "name": "Okafor" },
  { "key": "nguyen", "name": "Nguyen" },
  { "key": "rossi", "name": "Rossi" },
  { "key": "kim", "name": "Kim" },
  { "key": "alvarez", "name": "Alvarez" }
]
```

`src/domain/dtmf-baseline.json` (turns under a conventional tree: main menu, ID entry, ID confirm, provider menu, date entry, date confirm, final confirm):

```json
{
  "schedule_new": 7,
  "reschedule": 7,
  "cancel": 5,
  "confirm_appointment": 5,
  "billing": 3
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run src/domain/domain.test.ts`
Expected: 5 tests passed.

- [ ] **Step 7: Commit**

```bash
git add src/domain
git commit -m "feat(domain): add intents, forms, provider roster and dtmf baseline"
```

---

### Task 11: Slot spec contract and memberId slot

**Files:**
- Create: `src/domain/slots/types.ts`, `src/domain/slots/memberId.ts`, `src/domain/slots/memberId.test.ts`, `src/testing/answers.ts`

- [ ] **Step 1: Write the shared test helper**

`src/testing/answers.ts` (not a test file; imported by tests):

```ts
import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from '../jev/types';

export function choice(probabilities: Record<string, number>): ChoiceAnswer {
  const [top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return { type: 'choice', choice: top![0], probabilities, confidence: top![1] };
}

export function noul(value: number): NoulAnswer {
  return { type: 'noul', noul: value };
}

export function score(probabilities: Record<string, number>): ScoreAnswer {
  const labels = Object.keys(probabilities);
  const expected = labels.reduce((acc, label, i) => acc + (i + 1) * probabilities[label]!, 0);
  const top = Math.max(...Object.values(probabilities));
  return { type: 'score', score: expected, probabilities, confidence: top };
}
```

- [ ] **Step 2: Write the failing test**

`src/domain/slots/memberId.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { memberIdSlot } from './memberId';
import type { SlotContext } from './types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { candidateSpans } from '../../core/spans';
import { choice, noul } from '../../testing/answers';

function ctx(text: string): SlotContext {
  return { text, candidateSpans: candidateSpans(text), todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS } };
}

describe('memberIdSlot', () => {
  it('asks three questions with the spans as choice criteria', () => {
    const q = memberIdSlot.questions(ctx('it is four four seven'));
    expect(Object.keys(q)).toEqual(['containsMemberId', 'memberIdSpan', 'memberIdComplete']);
    const span = q.memberIdSpan!;
    expect(span.type).toBe('choice');
    if (span.type === 'choice') {
      expect(Object.keys(span.criteria)).toContain('four four seven');
      expect(Object.keys(span.criteria)).toContain('none');
    }
  });

  it('fills when detected, complete, and the span normalizes to eight digits', () => {
    const c = ctx('my id is four four seven one eight two nine three');
    const out = memberIdSlot.fill(
      {
        containsMemberId: noul(0.95),
        memberIdSpan: choice({ 'four four seven one eight two nine three': 0.9, none: 0.1 }),
        memberIdComplete: noul(0.9),
      },
      c,
    );
    expect(out).toEqual({
      kind: 'filled', value: '44718293', display: '4471 8293', confidence: 0.9, confirm: 'implicit',
    });
  });

  it('is absent when not detected', () => {
    const out = memberIdSlot.fill(
      { containsMemberId: noul(0.1), memberIdSpan: choice({ none: 1 }), memberIdComplete: noul(0.5) },
      ctx('I want to cancel'),
    );
    expect(out).toEqual({ kind: 'absent' });
  });

  it('is invalid when detected but the digits do not match the mask', () => {
    const out = memberIdSlot.fill(
      { containsMemberId: noul(0.9), memberIdSpan: choice({ 'four four seven': 0.9, none: 0.1 }), memberIdComplete: noul(0.9) },
      ctx('it is four four seven'),
    );
    expect(out).toMatchObject({ kind: 'invalid', reason: 'mask', raw: '447' });
  });

  it('is invalid when detected but incomplete', () => {
    const out = memberIdSlot.fill(
      { containsMemberId: noul(0.9), memberIdSpan: choice({ 'four four': 0.9, none: 0.1 }), memberIdComplete: noul(0.2) },
      ctx('it is four four'),
    );
    expect(out).toMatchObject({ kind: 'invalid', reason: 'incomplete' });
  });

  it('parses eight dtmf digits', () => {
    expect(memberIdSlot.dtmf.parse('44718293', ctx(''))).toEqual({ value: '44718293', display: '4471 8293' });
    expect(memberIdSlot.dtmf.parse('4471829#', ctx(''))).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/domain/slots/memberId.test.ts`
Expected: FAIL, cannot find module './memberId'.

- [ ] **Step 4: Write the slot contract**

`src/domain/slots/types.ts`:

```ts
import type { AnswerMap, QuestionMap } from '../../jev/types';
import type { Thresholds } from '../../core/thresholds';
import type { DateWindow } from '../../core/extract/date';
import type { SlotId } from '../forms';

export interface SlotContext {
  text: string;
  candidateSpans: string[];
  todayIso: string;
  thresholds: Thresholds;
}

export interface SlotCandidate {
  value: string;
  display: string;
}

export type SlotOutcome =
  | { kind: 'absent' }
  | { kind: 'filled'; value: string; display: string; confidence: number; confirm: 'none' | 'implicit' }
  | { kind: 'disambiguate'; a: SlotCandidate; b: SlotCandidate }
  | { kind: 'window'; window: DateWindow; confidence: number }
  | { kind: 'invalid'; reason: string; raw: string };

export interface SlotSpec {
  id: SlotId;
  /** Questions this slot adds to the turn schema. */
  questions(ctx: SlotContext): QuestionMap;
  /** Interpret the answers to those questions. */
  fill(answers: AnswerMap, ctx: SlotContext): SlotOutcome;
  /** DTMF fallback: how many digits to collect and how to parse them. */
  dtmf: {
    length: number;
    parse(digits: string, ctx: SlotContext): SlotCandidate | null;
  };
  display(value: string): string;
}
```

- [ ] **Step 5: Write memberId.ts**

`src/domain/slots/memberId.ts`:

```ts
import type { SlotSpec, SlotOutcome } from './types';
import { isChoice, noulValue } from '../../jev/types';
import { spokenToDigits } from '../../core/extract/spokenNumber';
import { MEMBER_ID_MASK, matchesMask } from '../../core/extract/mask';

export function formatMemberId(value: string): string {
  return `${value.slice(0, 4)} ${value.slice(4)}`;
}

export const memberIdSlot: SlotSpec = {
  id: 'memberId',

  questions(ctx) {
    const criteria: Record<string, string | null> = {};
    for (const span of ctx.candidateSpans) criteria[span] = null;
    criteria.none = 'No span of asr.text is a member ID';
    return {
      containsMemberId: {
        type: 'noul',
        instructions: 'Read asr.text. Does the caller state a member ID number, either as digits or as spoken number words?',
      },
      memberIdSpan: {
        type: 'choice',
        instructions: 'Read asr.text. Which of these spans is the member ID the caller states? Pick the tightest span that contains all of its digits.',
        criteria,
      },
      memberIdComplete: {
        type: 'noul',
        instructions: 'Read asr.text. If the caller states a member ID, do they finish saying the whole number rather than trailing off?',
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    if (noulValue(answers, 'containsMemberId') < t.SLOT_DETECT) return { kind: 'absent' };
    if (noulValue(answers, 'memberIdComplete') < t.SLOT_DETECT) {
      return { kind: 'invalid', reason: 'incomplete', raw: '' };
    }
    const span = answers.memberIdSpan;
    if (!isChoice(span) || span.choice === 'none') return { kind: 'invalid', reason: 'no_span', raw: '' };
    const digits = spokenToDigits(span.choice);
    if (!matchesMask(digits, MEMBER_ID_MASK)) return { kind: 'invalid', reason: 'mask', raw: digits };
    return {
      kind: 'filled',
      value: digits,
      display: formatMemberId(digits),
      confidence: span.probabilities[span.choice] ?? span.confidence,
      confirm: 'implicit',
    };
  },

  dtmf: {
    length: 8,
    parse(digits) {
      if (!matchesMask(digits, MEMBER_ID_MASK)) return null;
      return { value: digits, display: formatMemberId(digits) };
    },
  },

  display: formatMemberId,
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run src/domain/slots/memberId.test.ts`
Expected: 6 tests passed.

- [ ] **Step 7: Commit**

```bash
git add src/domain/slots/types.ts src/domain/slots/memberId.ts src/domain/slots/memberId.test.ts src/testing/answers.ts
git commit -m "feat(slots): add slot spec contract and memberId extracted slot"
```

---

### Task 12: Provider choice slot

**Files:**
- Create: `src/domain/slots/provider.ts`, `src/domain/slots/provider.test.ts`

- [ ] **Step 1: Write the failing test**

`src/domain/slots/provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { providerSlot } from './provider';
import type { SlotContext } from './types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { choice } from '../../testing/answers';

const ctx: SlotContext = { text: '', candidateSpans: [], todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS } };

describe('providerSlot', () => {
  it('asks one choice question over the roster plus none', () => {
    const q = providerSlot.questions(ctx).provider!;
    expect(q.type).toBe('choice');
    if (q.type === 'choice') {
      expect(Object.keys(q.criteria)).toEqual(['chen', 'cheng', 'patel', 'okafor', 'nguyen', 'rossi', 'kim', 'alvarez', 'none']);
    }
  });

  it('fills silently above the fill band', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.91, cheng: 0.05, none: 0.04 }) }, ctx))
      .toEqual({ kind: 'filled', value: 'chen', display: 'Dr. Chen', confidence: 0.91, confirm: 'none' });
  });

  it('fills with implicit confirm in the confirm band', () => {
    expect(providerSlot.fill({ provider: choice({ patel: 0.55, none: 0.45 }) }, ctx))
      .toMatchObject({ kind: 'filled', value: 'patel', confirm: 'implicit' });
  });

  it('disambiguates a narrow margin between two providers', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.48, cheng: 0.42, none: 0.1 }) }, ctx))
      .toEqual({ kind: 'disambiguate', a: { value: 'chen', display: 'Dr. Chen' }, b: { value: 'cheng', display: 'Dr. Cheng' } });
  });

  it('is absent when none wins or the top is below the confirm band', () => {
    expect(providerSlot.fill({ provider: choice({ none: 0.8, chen: 0.2 }) }, ctx)).toEqual({ kind: 'absent' });
    expect(providerSlot.fill({ provider: choice({ chen: 0.3, kim: 0.1, none: 0.6 }) }, ctx)).toEqual({ kind: 'absent' });
  });

  it('parses a dtmf menu digit', () => {
    expect(providerSlot.dtmf.parse('3', ctx)).toEqual({ value: 'patel', display: 'Dr. Patel' });
    expect(providerSlot.dtmf.parse('9', ctx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/domain/slots/provider.test.ts`
Expected: FAIL, cannot find module './provider'.

- [ ] **Step 3: Write provider.ts**

`src/domain/slots/provider.ts`:

```ts
import type { SlotSpec, SlotOutcome } from './types';
import { isChoice, rankProbabilities } from '../../jev/types';
import providers from '../providers.json';

export interface Provider {
  key: string;
  name: string;
}

export const PROVIDERS: readonly Provider[] = providers;

export function providerDisplay(key: string): string {
  const p = PROVIDERS.find((x) => x.key === key);
  return p ? `Dr. ${p.name}` : key;
}

export const providerSlot: SlotSpec = {
  id: 'provider',

  questions() {
    const criteria: Record<string, string | null> = {};
    for (const p of PROVIDERS) criteria[p.key] = `Dr. ${p.name}`;
    criteria.none = 'No provider is named';
    return {
      provider: {
        type: 'choice',
        instructions: 'Read asr.text. Which provider, if any, does the caller name?',
        criteria,
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    const a = answers.provider;
    if (!isChoice(a)) return { kind: 'absent' };
    const [top, second] = rankProbabilities(a.probabilities);
    if (!top || top.label === 'none' || top.p < t.SLOT_CHOICE_CONFIRM) return { kind: 'absent' };
    if (second && second.label !== 'none' && top.p - second.p < t.SLOT_CHOICE_MARGIN) {
      return {
        kind: 'disambiguate',
        a: { value: top.label, display: providerDisplay(top.label) },
        b: { value: second.label, display: providerDisplay(second.label) },
      };
    }
    return {
      kind: 'filled',
      value: top.label,
      display: providerDisplay(top.label),
      confidence: top.p,
      confirm: top.p >= t.SLOT_CHOICE_FILL ? 'none' : 'implicit',
    };
  },

  dtmf: {
    length: 1,
    parse(digits) {
      const idx = Number(digits) - 1;
      const p = PROVIDERS[idx];
      return p ? { value: p.key, display: `Dr. ${p.name}` } : null;
    },
  },

  display: providerDisplay,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/domain/slots/provider.test.ts`
Expected: 6 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/domain/slots/provider.ts src/domain/slots/provider.test.ts
git commit -m "feat(slots): add provider choice slot"
```

---

### Task 13: Date slot and slot registry

**Files:**
- Create: `src/domain/slots/date.ts`, `src/domain/slots/date.test.ts`, `src/domain/slots/index.ts`

- [ ] **Step 1: Write the failing test**

`src/domain/slots/date.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dateSlot } from './date';
import { SLOTS, slotsFor } from './index';
import type { SlotContext } from './types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { choice } from '../../testing/answers';
import type { AnswerMap } from '../../jev/types';

const ctx: SlotContext = { text: '', candidateSpans: [], todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS } };

function dateAnswers(picks: Record<string, [string, number]>): AnswerMap {
  const ids = ['dateMode', 'dateMonth', 'dateDay', 'dateWeekday', 'dateWeekdayQualifier', 'dateRelativeDay', 'dateWindow'];
  const out: AnswerMap = {};
  for (const id of ids) {
    const [label, p] = picks[id] ?? ['none', 0.95];
    out[id] = choice({ [label]: p, ...(label === 'none' ? {} : { none: 1 - p }) });
  }
  return out;
}

describe('dateSlot', () => {
  it('asks the seven component questions', () => {
    expect(Object.keys(dateSlot.questions(ctx))).toEqual([
      'dateMode', 'dateMonth', 'dateDay', 'dateWeekday', 'dateWeekdayQualifier', 'dateRelativeDay', 'dateWindow',
    ]);
  });

  it('fills a specific day silently when confident', () => {
    const out = dateSlot.fill(dateAnswers({ dateMode: ['relative_day', 0.9], dateRelativeDay: ['tomorrow', 0.9] }), ctx);
    expect(out).toEqual({ kind: 'filled', value: '2026-09-19', display: 'Saturday, September 19', confidence: 0.9, confirm: 'none' });
  });

  it('fills with implicit confirm when the weakest component is in the confirm band', () => {
    const out = dateSlot.fill(dateAnswers({ dateMode: ['absolute', 0.9], dateMonth: ['october', 0.9], dateDay: ['5', 0.6] }), ctx);
    expect(out).toMatchObject({ kind: 'filled', value: '2026-10-05', confirm: 'implicit' });
  });

  it('returns a window for next week', () => {
    const out = dateSlot.fill(dateAnswers({ dateMode: ['window', 0.9], dateWindow: ['next_week', 0.88] }), ctx);
    expect(out).toEqual({ kind: 'window', window: { start: '2026-09-21', end: '2026-09-27', label: 'next_week' }, confidence: 0.88 });
  });

  it('is absent when no date is mentioned', () => {
    expect(dateSlot.fill(dateAnswers({}), ctx)).toEqual({ kind: 'absent' });
  });

  it('is absent when the mode is below the confirm band', () => {
    expect(dateSlot.fill(dateAnswers({ dateMode: ['relative_day', 0.3], dateRelativeDay: ['tomorrow', 0.9] }), ctx)).toEqual({ kind: 'absent' });
  });

  it('parses MMDD dtmf', () => {
    expect(dateSlot.dtmf.parse('1005', ctx)).toEqual({ value: '2026-10-05', display: 'Monday, October 5' });
    expect(dateSlot.dtmf.parse('1305', ctx)).toBeNull();
  });
});

describe('slot registry', () => {
  it('exposes all three slots', () => {
    expect(Object.keys(SLOTS)).toEqual(['memberId', 'provider', 'date']);
  });
  it('returns the slot specs for a form in priority order', () => {
    expect(slotsFor('cancel').map((s) => s.id)).toEqual(['memberId', 'provider']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/domain/slots/date.test.ts`
Expected: FAIL, cannot find module './date'.

- [ ] **Step 3: Write date.ts**

`src/domain/slots/date.ts`:

```ts
import type { SlotSpec, SlotOutcome } from './types';
import { isChoice, type AnswerMap, type QuestionMap } from '../../jev/types';
import {
  DATE_MODES, MONTHS, WEEKDAYS, QUALIFIERS, RELATIVE_DAYS, WINDOWS,
  resolveDate, describeDay, type DateComponents, type Pick,
} from '../../core/extract/date';

const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));

function criteriaOf(labels: readonly string[]): Record<string, null> {
  return Object.fromEntries(labels.map((l) => [l, null]));
}

export const DATE_QUESTION_IDS = [
  'dateMode', 'dateMonth', 'dateDay', 'dateWeekday', 'dateWeekdayQualifier', 'dateRelativeDay', 'dateWindow',
] as const;

function pick(answers: AnswerMap, id: string): Pick {
  const a = answers[id];
  if (!isChoice(a)) return { choice: 'none', p: 0 };
  return { choice: a.choice, p: a.probabilities[a.choice] ?? a.confidence };
}

export function dateComponentsFrom(answers: AnswerMap): DateComponents {
  return {
    mode: pick(answers, 'dateMode'),
    month: pick(answers, 'dateMonth'),
    day: pick(answers, 'dateDay'),
    weekday: pick(answers, 'dateWeekday'),
    weekdayQualifier: pick(answers, 'dateWeekdayQualifier'),
    relativeDay: pick(answers, 'dateRelativeDay'),
    window: pick(answers, 'dateWindow'),
  };
}

export const dateSlot: SlotSpec = {
  id: 'date',

  questions(): QuestionMap {
    return {
      dateMode: {
        type: 'choice',
        instructions: 'Read asr.text. How does the caller refer to a day for the appointment? "absolute" names a month or a month and day. "relative_day" is today, tomorrow, or the day after tomorrow. "weekday" names a day of the week. "window" is a span like this week or next month. "none" if no day is mentioned.',
        criteria: criteriaOf(DATE_MODES),
      },
      dateMonth: {
        type: 'choice',
        instructions: 'Read asr.text. Which month does the caller name, if any?',
        criteria: criteriaOf([...MONTHS, 'none']),
      },
      dateDay: {
        type: 'choice',
        instructions: 'Read asr.text. Which day of the month does the caller name, if any?',
        criteria: criteriaOf([...DAYS, 'none']),
      },
      dateWeekday: {
        type: 'choice',
        instructions: 'Read asr.text. Which day of the week does the caller name, if any?',
        criteria: criteriaOf([...WEEKDAYS, 'none']),
      },
      dateWeekdayQualifier: {
        type: 'choice',
        instructions: 'Read asr.text. If the caller names a day of the week, do they say "this" or "next" before it?',
        criteria: criteriaOf(QUALIFIERS),
      },
      dateRelativeDay: {
        type: 'choice',
        instructions: 'Read asr.text. Does the caller say today, tomorrow, or the day after tomorrow?',
        criteria: criteriaOf(RELATIVE_DAYS),
      },
      dateWindow: {
        type: 'choice',
        instructions: 'Read asr.text. Does the caller name a span of days such as this week, next week, this month, or next month?',
        criteria: criteriaOf(WINDOWS),
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    const components = dateComponentsFrom(answers);
    if (components.mode.choice === 'none' || components.mode.p < t.SLOT_CHOICE_CONFIRM) return { kind: 'absent' };
    const resolved = resolveDate(components, ctx.todayIso);
    switch (resolved.kind) {
      case 'none':
        return { kind: 'absent' };
      case 'window':
        return {
          kind: 'window',
          window: { start: resolved.start, end: resolved.end, label: resolved.label },
          confidence: resolved.confidence,
        };
      case 'day':
        if (resolved.confidence < t.SLOT_CHOICE_CONFIRM) return { kind: 'absent' };
        return {
          kind: 'filled',
          value: resolved.iso,
          display: describeDay(resolved.iso),
          confidence: resolved.confidence,
          confirm: resolved.confidence >= t.SLOT_CHOICE_FILL ? 'none' : 'implicit',
        };
    }
  },

  dtmf: {
    length: 4,
    parse(digits, ctx) {
      const month = Number(digits.slice(0, 2));
      const day = Number(digits.slice(2, 4));
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const one: Pick = { choice: '', p: 1 };
      const resolved = resolveDate(
        {
          mode: { choice: 'absolute', p: 1 },
          month: { choice: MONTHS[month - 1]!, p: 1 },
          day: { choice: String(day), p: 1 },
          weekday: one, weekdayQualifier: one, relativeDay: one, window: one,
        },
        ctx.todayIso,
      );
      if (resolved.kind !== 'day') return null;
      return { value: resolved.iso, display: describeDay(resolved.iso) };
    },
  },

  display: describeDay,
};
```

- [ ] **Step 4: Write the registry**

`src/domain/slots/index.ts`:

```ts
import type { SlotSpec } from './types';
import type { SlotId } from '../forms';
import { FORMS } from '../forms';
import type { FormId } from '../intents';
import { memberIdSlot } from './memberId';
import { providerSlot } from './provider';
import { dateSlot } from './date';

export const SLOTS: Record<SlotId, SlotSpec> = {
  memberId: memberIdSlot,
  provider: providerSlot,
  date: dateSlot,
};

export function slotsFor(form: FormId): SlotSpec[] {
  return FORMS[form].slots.map((id) => SLOTS[id]);
}

export function allSlots(): SlotSpec[] {
  return Object.values(SLOTS);
}

export type { SlotSpec, SlotOutcome, SlotContext, SlotCandidate } from './types';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/domain/slots/date.test.ts`
Expected: 9 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/domain/slots
git commit -m "feat(slots): add date component slot and slot registry"
```

---

### Task 14: Session

**Files:**
- Create: `src/core/session.ts`, `src/core/session.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { newSession, bucketAttempt, bucketElapsed, bucketPriorCalls, missingSlots, currentAttempts, setForm } from './session';

describe('session', () => {
  it('starts with no form and empty slots', () => {
    const s = newSession('s1', 1000);
    expect(s.form).toBeNull();
    expect(s.slots.memberId).toEqual({ value: null, display: null, confirmed: false, attempts: 0, window: null });
    expect(s.turnIndex).toBe(0);
  });

  it('buckets attempts, elapsed time and prior calls', () => {
    expect(bucketAttempt(0)).toBe('first');
    expect(bucketAttempt(1)).toBe('second');
    expect(bucketAttempt(5)).toBe('third_or_more');
    expect(bucketElapsed(10_000)).toBe('under_30s');
    expect(bucketElapsed(90_000)).toBe('under_2m');
    expect(bucketElapsed(200_000)).toBe('over_2m');
    expect(bucketPriorCalls(0)).toBe('none');
    expect(bucketPriorCalls(1)).toBe('one');
    expect(bucketPriorCalls(3)).toBe('several');
  });

  it('lists missing slots for the active form in priority order', () => {
    const s = setForm(newSession('s1', 0), 'reschedule');
    s.slots.provider.value = 'chen';
    expect(missingSlots(s)).toEqual(['memberId', 'date']);
  });

  it('reports the attempts of whatever was last prompted', () => {
    const s = setForm(newSession('s1', 0), 'cancel');
    s.promptedFor = 'memberId';
    s.slots.memberId.attempts = 2;
    expect(currentAttempts(s)).toBe(2);
    s.promptedFor = 'intent';
    s.intentAttempts = 1;
    expect(currentAttempts(s)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/session.test.ts`
Expected: FAIL, cannot find module './session'.

- [ ] **Step 3: Write session.ts**

`src/core/session.ts`:

```ts
import type { FormId, Intent } from '../domain/intents';
import { FORMS, type SlotId } from '../domain/forms';
import type { DateWindow } from './extract/date';

export interface SlotState {
  value: string | null;
  display: string | null;
  confirmed: boolean;
  attempts: number;
  window: DateWindow | null;
}

export interface HistoryEntry {
  node: string;
  intent: string;
  outcome: string;
}

export interface CallerRecord {
  verified: boolean;
  openAppointment: boolean;
  priorCalls7d: number;
}

export interface PendingConfirmation {
  target: 'intent';
  intent: Intent;
}

export interface Session {
  sessionId: string;
  turnIndex: number;
  startedAtMs: number;
  form: FormId | null;
  slots: Record<SlotId, SlotState>;
  intentAttempts: number;
  /** what the last prompt asked for */
  promptedFor: 'intent' | SlotId | null;
  lastPromptId: string | null;
  lastPromptText: string;
  lastPromptOptions: string[];
  /** the intent DTMF menu was just played */
  menuActive: boolean;
  pendingConfirmation: PendingConfirmation | null;
  history: HistoryEntry[];
  caller: CallerRecord;
  dtmfBuffer: string;
  consecutiveFailures: number;
  ended: boolean;
}

export const DEFAULT_CALLER: CallerRecord = { verified: false, openAppointment: true, priorCalls7d: 0 };

export function emptySlot(): SlotState {
  return { value: null, display: null, confirmed: false, attempts: 0, window: null };
}

export function emptySlots(): Record<SlotId, SlotState> {
  return { memberId: emptySlot(), provider: emptySlot(), date: emptySlot() };
}

export function newSession(sessionId: string, nowMs: number, caller: CallerRecord = DEFAULT_CALLER): Session {
  return {
    sessionId,
    turnIndex: 0,
    startedAtMs: nowMs,
    form: null,
    slots: emptySlots(),
    intentAttempts: 0,
    promptedFor: null,
    lastPromptId: null,
    lastPromptText: '',
    lastPromptOptions: [],
    menuActive: false,
    pendingConfirmation: null,
    history: [],
    caller: { ...caller },
    dtmfBuffer: '',
    consecutiveFailures: 0,
    ended: false,
  };
}

/** Deep enough copy that resolve() can mutate freely without touching the caller's object. */
export function cloneSession(s: Session): Session {
  return {
    ...s,
    slots: {
      memberId: { ...s.slots.memberId },
      provider: { ...s.slots.provider },
      date: { ...s.slots.date },
    },
    lastPromptOptions: [...s.lastPromptOptions],
    history: s.history.map((h) => ({ ...h })),
    caller: { ...s.caller },
    pendingConfirmation: s.pendingConfirmation ? { ...s.pendingConfirmation } : null,
  };
}

export type AttemptBucket = 'first' | 'second' | 'third_or_more';
export function bucketAttempt(attempts: number): AttemptBucket {
  if (attempts <= 0) return 'first';
  if (attempts === 1) return 'second';
  return 'third_or_more';
}

export type ElapsedBucket = 'under_30s' | 'under_2m' | 'over_2m';
export function bucketElapsed(ms: number): ElapsedBucket {
  if (ms < 30_000) return 'under_30s';
  if (ms < 120_000) return 'under_2m';
  return 'over_2m';
}

export type PriorCallsBucket = 'none' | 'one' | 'several';
export function bucketPriorCalls(n: number): PriorCallsBucket {
  if (n <= 0) return 'none';
  if (n === 1) return 'one';
  return 'several';
}

export function setForm(session: Session, form: FormId): Session {
  session.form = form;
  session.intentAttempts = 0;
  session.pendingConfirmation = null;
  session.menuActive = false;
  return session;
}

export function requiredSlots(session: Session): SlotId[] {
  return session.form ? FORMS[session.form].slots : [];
}

export function missingSlots(session: Session): SlotId[] {
  return requiredSlots(session).filter((id) => session.slots[id].value === null);
}

export function currentAttempts(session: Session): number {
  if (session.promptedFor === 'intent' || session.promptedFor === null) return session.intentAttempts;
  return session.slots[session.promptedFor].attempts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/session.test.ts`
Expected: 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/session.ts src/core/session.test.ts
git commit -m "feat(core): add session state and bucketing helpers"
```

---

### Task 15: Turn state assembly

**Files:**
- Create: `src/core/state.ts`, `src/core/state.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildTurnState } from './state';
import { newSession, setForm } from './session';

describe('buildTurnState', () => {
  it('buckets numbers, trims history and exposes candidate spans', () => {
    const s = setForm(newSession('s1', 0), 'cancel');
    s.promptedFor = 'memberId';
    s.slots.memberId.attempts = 1;
    s.lastPromptId = 'ask_memberId';
    s.lastPromptText = "What's your member ID?";
    s.history = [1, 2, 3, 4].map((i) => ({ node: `n${i}`, intent: 'none', outcome: 'prompt' }));
    s.caller.priorCalls7d = 2;

    const ts = buildTurnState(s, { text: 'it is four four seven', isFinal: true, dtmf: null }, 45_000);

    expect(ts.turn).toEqual({ attempt: 'second', elapsed: 'under_2m' });
    expect(ts.node).toEqual({ id: 'ask_memberId', promptJustPlayed: "What's your member ID?", options: [] });
    expect(ts.history.map((h) => h.node)).toEqual(['n2', 'n3', 'n4']);
    expect(ts.caller.priorCalls).toBe('several');
    expect(ts.asr).toEqual({ text: 'it is four four seven', isFinal: true, bargeIn: false, dtmf: null });
    expect(ts.candidateSpans).toContain('four four seven');
    expect(ts.slots.memberId).toEqual({ value: null, confirmed: false });
    expect(ts.activeForm).toBe('cancel');
    expect(ts.pendingConfirmation).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/state.test.ts`
Expected: FAIL, cannot find module './state'.

- [ ] **Step 3: Write state.ts**

`src/core/state.ts`:

```ts
import type { SlotId } from '../domain/forms';
import { INTENT_LABELS } from '../domain/intents';
import { candidateSpans } from './spans';
import {
  bucketAttempt, bucketElapsed, bucketPriorCalls, currentAttempts,
  type AttemptBucket, type ElapsedBucket, type PriorCallsBucket, type Session,
} from './session';

export const HISTORY_WINDOW = 3;

export interface TurnInput {
  text: string;
  isFinal: boolean;
  dtmf: string | null;
}

/** What the model sees. Numbers are bucketed; see spec §5 and jev-1.13 jaggedness notes. */
export interface TurnState {
  node: { id: string; promptJustPlayed: string; options: string[] };
  turn: { attempt: AttemptBucket; elapsed: ElapsedBucket };
  activeForm: string | null;
  slots: Record<SlotId, { value: string | null; confirmed: boolean }>;
  history: Array<{ node: string; intent: string; outcome: string }>;
  caller: { verified: boolean; openAppointment: boolean; priorCalls: PriorCallsBucket };
  asr: { text: string; isFinal: boolean; bargeIn: boolean; dtmf: string | null };
  candidateSpans: string[];
  pendingConfirmation: { target: string; value: string } | null;
}

export function buildTurnState(session: Session, input: TurnInput, nowMs: number): TurnState {
  const slots = {} as TurnState['slots'];
  for (const id of Object.keys(session.slots) as SlotId[]) {
    slots[id] = { value: session.slots[id].display, confirmed: session.slots[id].confirmed };
  }
  return {
    node: {
      id: session.lastPromptId ?? 'start',
      promptJustPlayed: session.lastPromptText,
      options: [...session.lastPromptOptions],
    },
    turn: {
      attempt: bucketAttempt(currentAttempts(session)),
      elapsed: bucketElapsed(nowMs - session.startedAtMs),
    },
    activeForm: session.form,
    slots,
    history: session.history.slice(-HISTORY_WINDOW).map((h) => ({ ...h })),
    caller: {
      verified: session.caller.verified,
      openAppointment: session.caller.openAppointment,
      priorCalls: bucketPriorCalls(session.caller.priorCalls7d),
    },
    asr: { text: input.text, isFinal: input.isFinal, bargeIn: false, dtmf: input.dtmf },
    candidateSpans: candidateSpans(input.text),
    pendingConfirmation: session.pendingConfirmation
      ? { target: 'intent', value: INTENT_LABELS[session.pendingConfirmation.intent] }
      : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/state.test.ts`
Expected: 1 test passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/state.ts src/core/state.test.ts
git commit -m "feat(core): assemble bucketed turn state for the model"
```

---

### Task 16: Question builder

**Files:**
- Create: `src/core/questions.ts`, `src/core/questions.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/questions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildQuestions, ALWAYS_ON_IDS } from './questions';
import { newSession, setForm } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { SlotContext } from '../domain/slots';

const ctx: SlotContext = { text: 'hi', candidateSpans: [], todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS } };

describe('buildQuestions', () => {
  it('always includes the routing, control, caller and guard questions', () => {
    const q = buildQuestions(newSession('s', 0), ctx);
    for (const id of ALWAYS_ON_IDS) expect(q).toHaveProperty(id);
    expect(q.intent!.type).toBe('choice');
    expect(q.frustration!.type).toBe('score');
    expect(q.intelligible!.type).toBe('noul');
  });

  it('includes every slot fragment when no form is active', () => {
    const q = buildQuestions(newSession('s', 0), ctx);
    expect(q).toHaveProperty('containsMemberId');
    expect(q).toHaveProperty('provider');
    expect(q).toHaveProperty('dateMode');
  });

  it('includes only the active form slots', () => {
    const q = buildQuestions(setForm(newSession('s', 0), 'cancel'), ctx);
    expect(q).toHaveProperty('provider');
    expect(q).not.toHaveProperty('dateMode');
  });

  it('adds confirmation questions when a confirmation is pending', () => {
    const s = newSession('s', 0);
    s.pendingConfirmation = { target: 'intent', intent: 'cancel' };
    const q = buildQuestions(s, ctx);
    expect(q).toHaveProperty('confirmsYes');
    expect(q).toHaveProperty('confirmsNo');
  });

  it('adds the menu question when the dtmf menu is active', () => {
    const s = newSession('s', 0);
    s.menuActive = true;
    const q = buildQuestions(s, ctx).menuNumberSaid!;
    expect(q.type).toBe('choice');
    if (q.type === 'choice') expect(Object.keys(q.criteria)).toEqual(['1', '2', '3', '4', '5', '0', 'none']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/questions.test.ts`
Expected: FAIL, cannot find module './questions'.

- [ ] **Step 3: Write questions.ts**

`src/core/questions.ts`:

```ts
import type { QuestionMap } from '../jev/types';
import { INTENTS, INTENT_CRITERIA, INTENT_MENU } from '../domain/intents';
import { allSlots, slotsFor, type SlotContext } from '../domain/slots';
import type { Session } from './session';

export const ALWAYS_ON_IDS = [
  'intent', 'intentSecondary',
  'addressedToSystem', 'utteranceComplete', 'wantsHuman', 'rephrasingLastTurn', 'confusedByPrompt', 'spokeAMenuNumber',
  'frustration', 'urgency', 'triedSelfService', 'languageSwitch',
  'intelligible',
] as const;

const INTENT_CRITERIA_MAP: Record<string, string> = Object.fromEntries(INTENTS.map((i) => [i, INTENT_CRITERIA[i]]));

function alwaysOn(): QuestionMap {
  return {
    intent: {
      type: 'choice',
      instructions: 'Read asr.text. What is the caller asking the clinic phone line to do? If they are only answering the question in node.promptJustPlayed, choose none.',
      criteria: INTENT_CRITERIA_MAP,
    },
    intentSecondary: {
      type: 'choice',
      instructions: 'Read asr.text. Besides the main request, does the caller ask for a second, different thing? Choose none if there is only one request.',
      criteria: INTENT_CRITERIA_MAP,
    },
    addressedToSystem: {
      type: 'noul',
      instructions: 'Read asr.text. Is the caller speaking to the phone system, as opposed to someone else in the room, a television, or themselves?',
    },
    utteranceComplete: {
      type: 'noul',
      instructions: 'Read asr.text. Has the caller finished their thought, rather than trailing off or being cut short?',
    },
    wantsHuman: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller explicitly ask to talk to a person, an agent, a representative, or an operator?',
    },
    rephrasingLastTurn: {
      type: 'noul',
      instructions: 'Read asr.text and history. Is the caller repeating or rewording something they already said because the system did not understand?',
    },
    confusedByPrompt: {
      type: 'noul',
      instructions: 'Read asr.text and node.promptJustPlayed. Does the caller sound confused by what the system just asked?',
    },
    spokeAMenuNumber: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller say a single number as if choosing a menu option, such as "one" or "press two"?',
    },
    frustration: {
      type: 'score',
      instructions: 'Read asr.text. How frustrated does the caller sound?',
      levels: [
        { label: 'none', description: 'Calm or neutral' },
        { label: 'mild', description: 'Impatient, sighing, or mildly annoyed' },
        { label: 'high', description: 'Angry, raising their voice, swearing, or threatening to hang up' },
      ],
    },
    urgency: {
      type: 'score',
      instructions: 'Read asr.text. How urgent is the caller\'s need?',
      levels: [
        { label: 'low', description: 'No time pressure mentioned' },
        { label: 'normal', description: 'Wants it handled soon' },
        { label: 'high', description: 'Says it is urgent, an emergency, or must happen today' },
      ],
    },
    triedSelfService: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller say they already tried the website, the app, or an earlier call?',
    },
    languageSwitch: {
      type: 'choice',
      instructions: 'Read asr.text. Does the caller ask for, or speak in, a language other than English?',
      criteria: { none: 'English', es: 'Spanish', fr: 'French' },
    },
    intelligible: {
      type: 'noul',
      instructions: 'Read asr.text. Is the text a coherent English utterance rather than garbled fragments or noise?',
    },
  };
}

function confirmation(): QuestionMap {
  return {
    confirmsYes: {
      type: 'noul',
      instructions: 'Read asr.text and node.promptJustPlayed. Does the caller answer yes to the confirmation question?',
    },
    confirmsNo: {
      type: 'noul',
      instructions: 'Read asr.text and node.promptJustPlayed. Does the caller answer no to the confirmation question?',
    },
  };
}

function menu(): QuestionMap {
  const criteria: Record<string, string | null> = {};
  for (const { digit } of INTENT_MENU) criteria[digit] = null;
  criteria.none = 'No menu number said';
  return {
    menuNumberSaid: {
      type: 'choice',
      instructions: 'Read asr.text. Which menu number from node.options does the caller say, if any?',
      criteria,
    },
  };
}

export function buildQuestions(session: Session, ctx: SlotContext): QuestionMap {
  const q: QuestionMap = { ...alwaysOn() };
  const specs = session.form ? slotsFor(session.form) : allSlots();
  for (const spec of specs) Object.assign(q, spec.questions(ctx));
  if (session.pendingConfirmation) Object.assign(q, confirmation());
  if (session.menuActive) Object.assign(q, menu());
  return q;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/questions.test.ts`
Expected: 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/questions.ts src/core/questions.test.ts
git commit -m "feat(core): build the parallel turn schema"
```

---

### Task 17: Gate ladder

**Files:**
- Create: `src/core/gates.ts`, `src/core/gates.test.ts`

Deviation: the frustration escalation gate runs before the intent gate. With it last, an intent failure would decide first and a frustrated repeat failure would never escalate.

- [ ] **Step 1: Write the failing test**

`src/core/gates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateGates } from './gates';
import { newSession, setForm, type Session } from './session';
import { buildTurnState } from './state';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap } from '../jev/types';

const T = { ...DEFAULT_THRESHOLDS };

function baseAnswers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95),
    intelligible: noul(0.95),
    utteranceComplete: noul(0.9),
    wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1),
    confusedByPrompt: noul(0.1),
    spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ reschedule: 0.9, cancel: 0.05, none: 0.05 }),
    ...over,
  };
}

function run(session: Session, answers: AnswerMap, isFinal = true) {
  const ts = buildTurnState(session, { text: 'x', isFinal, dtmf: null }, 0);
  return evaluateGates(session, ts, answers, T);
}

describe('evaluateGates', () => {
  it('ignores side speech', () => {
    const r = run(newSession('s', 0), baseAnswers({ addressedToSystem: noul(0.2) }));
    expect(r.verdict).toEqual({ kind: 'ignore' });
    expect(r.rows.find((g) => g.gate === 'addressedToSystem')).toMatchObject({ passed: false, decided: true, threshold: 0.7 });
  });

  it('reprompts on unintelligible text', () => {
    expect(run(newSession('s', 0), baseAnswers({ intelligible: noul(0.2) })).verdict).toEqual({ kind: 'nomatch' });
  });

  it('holds an incomplete partial but only notes an incomplete final', () => {
    expect(run(newSession('s', 0), baseAnswers({ utteranceComplete: noul(0.2) }), false).verdict).toEqual({ kind: 'hold' });
    const r = run(newSession('s', 0), baseAnswers({ utteranceComplete: noul(0.2) }), true);
    expect(r.verdict.kind).toBe('route');
    expect(r.rows.find((g) => g.gate === 'utteranceComplete')?.outcome).toBe('noted');
  });

  it('hands off when the caller wants a human', () => {
    expect(run(newSession('s', 0), baseAnswers({ wantsHuman: noul(0.9) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
  });

  it('escalates high frustration on a repeat attempt but not on the first', () => {
    const angry = baseAnswers({ frustration: score({ none: 0.1, mild: 0.2, high: 0.7 }) });
    expect(run(newSession('s', 0), angry).verdict.kind).toBe('route');
    const s = newSession('s', 0);
    s.promptedFor = 'intent';
    s.intentAttempts = 1;
    expect(run(s, angry).verdict).toEqual({ kind: 'handoff', reason: 'frustrated' });
  });

  it('routes silently, with implicit confirm, or with explicit confirm by band', () => {
    expect(run(newSession('s', 0), baseAnswers()).verdict).toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none' });
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.7, none: 0.3 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'reschedule', confirm: 'implicit' });
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.5, none: 0.5 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'reschedule', confirm: 'explicit' });
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.3, none: 0.7 }) })).verdict)
      .toEqual({ kind: 'intent_failed' });
  });

  it('disambiguates a narrow margin between two form intents', () => {
    const r = run(newSession('s', 0), baseAnswers({ intent: choice({ reschedule: 0.5, cancel: 0.45, none: 0.05 }) }));
    expect(r.verdict).toEqual({ kind: 'disambiguate_intent', a: 'reschedule', b: 'cancel' });
  });

  it('proceeds to slot filling when a form is active and no new intent is expressed', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    expect(run(s, baseAnswers({ intent: choice({ none: 0.9, cancel: 0.1 }) })).verdict).toEqual({ kind: 'proceed' });
  });

  it('switches forms on a confident new intent', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    expect(run(s, baseAnswers({ intent: choice({ reschedule: 0.9, none: 0.1 }) })).verdict)
      .toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none' });
  });

  it('resolves a pending explicit confirmation', () => {
    const s = newSession('s', 0);
    s.pendingConfirmation = { target: 'intent', intent: 'cancel' };
    expect(run(s, baseAnswers({ confirmsYes: noul(0.9), confirmsNo: noul(0.1) })).verdict).toEqual({ kind: 'confirmed' });
    expect(run(s, baseAnswers({ confirmsYes: noul(0.1), confirmsNo: noul(0.9) })).verdict).toEqual({ kind: 'rejected' });
  });

  it('routes a spoken menu number when the menu is active', () => {
    const s = newSession('s', 0);
    s.menuActive = true;
    const r = run(s, baseAnswers({ intent: choice({ none: 0.9, other: 0.1 }), menuNumberSaid: choice({ '3': 0.9, none: 0.1 }) }));
    expect(r.verdict).toEqual({ kind: 'route', intent: 'cancel', confirm: 'none' });
  });

  it('handles agent and repeat intents', () => {
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ agent: 0.8, none: 0.2 }) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ repeat_prompt: 0.8, none: 0.2 }) })).verdict).toEqual({ kind: 'replay' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/gates.test.ts`
Expected: FAIL, cannot find module './gates'.

- [ ] **Step 3: Write gates.ts**

`src/core/gates.ts`:

```ts
import { isChoice, isScore, noulValue, rankProbabilities, type AnswerMap } from '../jev/types';
import { INTENT_MENU, isFormIntent, type FormId, type Intent } from '../domain/intents';
import type { Session } from './session';
import type { TurnState } from './state';
import type { Thresholds } from './thresholds';

export interface GateRow {
  gate: string;
  value: number | null;
  threshold: number | null;
  passed: boolean;
  outcome: string;
  decided: boolean;
}

export type Verdict =
  | { kind: 'ignore' }
  | { kind: 'hold' }
  | { kind: 'nomatch' }
  | { kind: 'handoff'; reason: string }
  | { kind: 'confirmed' }
  | { kind: 'rejected' }
  | { kind: 'replay' }
  | { kind: 'route'; intent: FormId; confirm: 'none' | 'implicit' | 'explicit' }
  | { kind: 'disambiguate_intent'; a: Intent; b: Intent }
  | { kind: 'intent_failed' }
  | { kind: 'proceed' };

export interface GateResult {
  rows: GateRow[];
  verdict: Verdict;
}

export function evaluateGates(session: Session, ts: TurnState, answers: AnswerMap, t: Thresholds): GateResult {
  const rows: GateRow[] = [];
  let verdict: Verdict | null = null;

  const decide = (row: GateRow, v: Verdict): void => {
    if (verdict === null) {
      verdict = v;
      row.decided = true;
    }
    rows.push(row);
  };
  const info = (gate: string, value: number | null, outcome = 'info'): void => {
    rows.push({ gate, value, threshold: null, passed: true, outcome, decided: false });
  };

  // 1. addressed to system
  {
    const v = noulValue(answers, 'addressedToSystem');
    const passed = v >= t.GATE_ADDRESSED;
    const row = { gate: 'addressedToSystem', value: v, threshold: t.GATE_ADDRESSED, passed, outcome: passed ? 'pass' : 'ignore', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'ignore' });
  }

  // 2. intelligible
  {
    const v = noulValue(answers, 'intelligible');
    const passed = v >= t.GATE_INTELLIGIBLE;
    const row = { gate: 'intelligible', value: v, threshold: t.GATE_INTELLIGIBLE, passed, outcome: passed ? 'pass' : 'nomatch', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'nomatch' });
  }

  // 3. utterance complete
  {
    const v = noulValue(answers, 'utteranceComplete');
    const passed = v >= t.GATE_COMPLETE;
    if (passed) rows.push({ gate: 'utteranceComplete', value: v, threshold: t.GATE_COMPLETE, passed, outcome: 'pass', decided: false });
    else if (!ts.asr.isFinal) decide({ gate: 'utteranceComplete', value: v, threshold: t.GATE_COMPLETE, passed, outcome: 'hold', decided: false }, { kind: 'hold' });
    else rows.push({ gate: 'utteranceComplete', value: v, threshold: t.GATE_COMPLETE, passed, outcome: 'noted', decided: false });
  }

  // 4. wants human
  {
    const v = noulValue(answers, 'wantsHuman');
    const passed = v < t.GATE_WANTS_HUMAN;
    const row = { gate: 'wantsHuman', value: v, threshold: t.GATE_WANTS_HUMAN, passed, outcome: passed ? 'pass' : 'handoff', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'handoff', reason: 'live-agent' });
  }

  // 5. frustration escalation (before intent; see Deviation note)
  {
    const f = answers.frustration;
    const high = isScore(f) ? (f.probabilities.high ?? 0) : 0;
    const repeat = ts.turn.attempt !== 'first';
    const passed = !(high >= t.GATE_FRUSTRATION_HIGH && repeat);
    const row = { gate: 'frustration', value: high, threshold: t.GATE_FRUSTRATION_HIGH, passed, outcome: passed ? (repeat ? 'pass' : 'first_attempt') : 'handoff', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'handoff', reason: 'frustrated' });
  }

  // 6. pending explicit confirmation
  if (session.pendingConfirmation) {
    const yes = noulValue(answers, 'confirmsYes');
    const no = noulValue(answers, 'confirmsNo');
    if (yes >= t.CONFIRM_YES && yes >= no) {
      decide({ gate: 'confirmation', value: yes, threshold: t.CONFIRM_YES, passed: true, outcome: 'confirmed', decided: false }, { kind: 'confirmed' });
    } else if (no >= t.CONFIRM_NO) {
      decide({ gate: 'confirmation', value: no, threshold: t.CONFIRM_NO, passed: true, outcome: 'rejected', decided: false }, { kind: 'rejected' });
    } else {
      rows.push({ gate: 'confirmation', value: Math.max(yes, no), threshold: t.CONFIRM_YES, passed: false, outcome: 'unanswered', decided: false });
    }
  }

  // 7. spoken menu number
  if (session.menuActive) {
    const m = answers.menuNumberSaid;
    const [top] = isChoice(m) ? rankProbabilities(m.probabilities) : [];
    const mapped = top && top.label !== 'none' ? INTENT_MENU.find((o) => o.digit === top.label) : undefined;
    if (top && mapped && top.p >= t.MENU_NUMBER) {
      const row = { gate: 'menuNumber', value: top.p, threshold: t.MENU_NUMBER, passed: true, outcome: `menu:${mapped.intent}`, decided: false };
      if (mapped.intent === 'agent') decide(row, { kind: 'handoff', reason: 'live-agent' });
      else if (isFormIntent(mapped.intent)) decide(row, { kind: 'route', intent: mapped.intent, confirm: 'none' });
    } else {
      rows.push({ gate: 'menuNumber', value: top?.p ?? null, threshold: t.MENU_NUMBER, passed: false, outcome: 'no_menu_number', decided: false });
    }
  }

  // informational rows for the debug table
  info('rephrasingLastTurn', noulValue(answers, 'rephrasingLastTurn'));
  info('confusedByPrompt', noulValue(answers, 'confusedByPrompt'));
  info('spokeAMenuNumber', noulValue(answers, 'spokeAMenuNumber'));

  // 8. intent
  const intentAnswer = answers.intent;
  const ranked = isChoice(intentAnswer) ? rankProbabilities(intentAnswer.probabilities) : [];
  const top = ranked[0] ?? { label: 'none', p: 0 };
  const second = ranked[1];
  const label = top.label as Intent;
  const activeForm = session.form;

  let routeVerdict: Verdict | null = null;
  let outcome: string;

  if (activeForm === null) {
    if (label === 'agent' && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'handoff', reason: 'live-agent' }; outcome = 'agent'; }
    else if (label === 'repeat_prompt' && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'replay' }; outcome = 'replay'; }
    else if (isFormIntent(label) && top.p >= t.INTENT_ROUTE) { routeVerdict = { kind: 'route', intent: label, confirm: 'none' }; outcome = 'route'; }
    else if (isFormIntent(label) && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'route', intent: label, confirm: 'implicit' }; outcome = 'route_implicit'; }
    else if (isFormIntent(label) && top.p >= t.INTENT_EXPLICIT) { routeVerdict = { kind: 'route', intent: label, confirm: 'explicit' }; outcome = 'route_explicit'; }
    else { routeVerdict = { kind: 'intent_failed' }; outcome = 'failed'; }
  } else {
    if (label === 'agent' && top.p >= t.INTENT_SWITCH) { routeVerdict = { kind: 'handoff', reason: 'live-agent' }; outcome = 'agent'; }
    else if (label === 'repeat_prompt' && top.p >= t.INTENT_SWITCH) { routeVerdict = { kind: 'replay' }; outcome = 'replay'; }
    else if (isFormIntent(label) && label !== activeForm && top.p >= t.INTENT_SWITCH) { routeVerdict = { kind: 'route', intent: label, confirm: 'none' }; outcome = 'switch'; }
    else { routeVerdict = { kind: 'proceed' }; outcome = 'proceed'; }
  }

  const intentRow: GateRow = {
    gate: 'intent', value: top.p, threshold: activeForm === null ? t.INTENT_EXPLICIT : t.INTENT_SWITCH,
    passed: routeVerdict.kind !== 'intent_failed', outcome: `${outcome}:${label}`, decided: false,
  };

  // 9. margin, whenever routing on a form intent. With normalized probabilities a
  // top-1 >= 0.60 always has margin >= 0.20, so in practice this fires inside the
  // explicit-confirm band and turns "confirm the top one" into "ask which of two".
  let marginRow: GateRow | null = null;
  if (routeVerdict.kind === 'route' && second && isFormIntent(second.label)) {
    const margin = top.p - second.p;
    const passed = margin >= t.GATE_INTENT_MARGIN;
    marginRow = { gate: 'intentMargin', value: margin, threshold: t.GATE_INTENT_MARGIN, passed, outcome: passed ? 'pass' : 'disambiguate', decided: false };
    if (!passed) routeVerdict = { kind: 'disambiguate_intent', a: label, b: second.label as Intent };
  }

  if (routeVerdict.kind === 'proceed') rows.push(intentRow);
  else decide(intentRow, routeVerdict);
  if (marginRow) {
    if (!marginRow.passed && intentRow.decided) { intentRow.decided = false; marginRow.decided = true; }
    rows.push(marginRow);
  }

  return { rows, verdict: verdict ?? routeVerdict };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/gates.test.ts`
Expected: 12 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/gates.ts src/core/gates.test.ts
git commit -m "feat(core): add the gate ladder with per-gate trace rows"
```

---

### Task 18: Form interpretation loop

**Files:**
- Create: `src/core/fia.ts`, `src/core/fia.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/fia.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fillSlots, nextPrompt, retryStep, applyDtmf } from './fia';
import { newSession, setForm } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { slotsFor, type SlotContext } from '../domain/slots';
import { choice, noul } from '../testing/answers';
import { candidateSpans } from './spans';

const T = { ...DEFAULT_THRESHOLDS };
function ctx(text = ''): SlotContext {
  return { text, candidateSpans: candidateSpans(text), todayIso: '2026-09-18', thresholds: T };
}

describe('retryStep', () => {
  it('goes open, dtmf, agent', () => {
    expect(retryStep(1, T)).toBe('open');
    expect(retryStep(2, T)).toBe('dtmf');
    expect(retryStep(3, T)).toBe('agent');
  });
});

describe('fillSlots', () => {
  it('fills over-answered slots and collects implicit acks', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    const r = fillSlots(s, {
      provider: choice({ chen: 0.65, none: 0.35 }),
      dateMode: choice({ window: 0.9, none: 0.1 }),
      dateWindow: choice({ next_week: 0.88, none: 0.12 }),
      containsMemberId: noul(0.05),
    }, ctx('reschedule with dr chen next week'), slotsFor('reschedule'));
    expect(r.session.slots.provider).toMatchObject({ value: 'chen', confirmed: false });
    expect(r.session.slots.date.window).toEqual({ start: '2026-09-21', end: '2026-09-27', label: 'next_week' });
    expect(r.acks).toEqual([{ promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }]);
    expect(r.progress).toBe(true);
    expect(r.disambiguate).toBeNull();
  });

  it('reports no progress when nothing fills', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    const r = fillSlots(s, { provider: choice({ none: 0.9 }), containsMemberId: noul(0.1) }, ctx('um'), slotsFor('cancel'));
    expect(r.progress).toBe(false);
  });

  it('surfaces a disambiguation', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    const r = fillSlots(s, { provider: choice({ chen: 0.48, cheng: 0.42, none: 0.1 }), containsMemberId: noul(0.1) }, ctx('chen'), slotsFor('cancel'));
    expect(r.disambiguate).toMatchObject({ slot: 'provider', a: { value: 'chen' }, b: { value: 'cheng' } });
    expect(r.progress).toBe(true);
  });

  it('records invalid extraction as no progress with the reason', () => {
    const s = setForm(newSession('s', 0), 'billing');
    const text = 'four four seven';
    const r = fillSlots(s, {
      containsMemberId: noul(0.9), memberIdSpan: choice({ 'four four seven': 0.9, none: 0.1 }), memberIdComplete: noul(0.9),
    }, ctx(text), slotsFor('billing'));
    expect(r.progress).toBe(false);
    expect(r.events).toEqual([{ slot: 'memberId', outcome: { kind: 'invalid', reason: 'mask', raw: '447' } }]);
  });
});

describe('nextPrompt', () => {
  it('asks for the highest-priority missing slot, narrowing a window', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    expect(nextPrompt(s)).toEqual({ kind: 'ask', slot: 'memberId', window: null });
    s.slots.memberId.value = '44718293';
    s.slots.provider.value = 'chen';
    s.slots.date.window = { start: '2026-09-21', end: '2026-09-27', label: 'next_week' };
    expect(nextPrompt(s)).toEqual({ kind: 'ask', slot: 'date', window: s.slots.date.window });
    s.slots.date.value = '2026-09-22';
    expect(nextPrompt(s)).toEqual({ kind: 'complete' });
  });
});

describe('applyDtmf', () => {
  it('fills the prompted slot once enough digits arrive', () => {
    const s = setForm(newSession('s', 0), 'billing');
    s.promptedFor = 'memberId';
    expect(applyDtmf(s, '4471829', ctx())).toEqual({ kind: 'collecting' });
    expect(applyDtmf(s, '44718293', ctx())).toEqual({ kind: 'filled', slot: 'memberId', display: '4471 8293' });
    expect(s.slots.memberId).toMatchObject({ value: '44718293', confirmed: true });
  });

  it('rejects invalid digits as an attempt', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    s.promptedFor = 'provider';
    expect(applyDtmf(s, '9', ctx())).toEqual({ kind: 'invalid', slot: 'provider' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/fia.test.ts`
Expected: FAIL, cannot find module './fia'.

- [ ] **Step 3: Write fia.ts**

`src/core/fia.ts`:

```ts
import type { AnswerMap } from '../jev/types';
import type { SlotId } from '../domain/forms';
import { SLOTS, type SlotCandidate, type SlotContext, type SlotOutcome, type SlotSpec } from '../domain/slots';
import type { DateWindow } from './extract/date';
import { missingSlots, type Session } from './session';
import type { Thresholds } from './thresholds';

export type RetryStep = 'open' | 'dtmf' | 'agent';

/** attempts = failures so far including the one just counted. */
export function retryStep(attempts: number, t: Thresholds): RetryStep {
  if (attempts >= t.MAX_ATTEMPTS) return 'agent';
  if (attempts === 2) return 'dtmf';
  return 'open';
}

export interface Ack {
  promptId: string;
  vars: Record<string, string>;
}

export interface FillEvent {
  slot: SlotId;
  outcome: SlotOutcome;
}

export interface FillResult {
  session: Session;
  events: FillEvent[];
  acks: Ack[];
  disambiguate: { slot: SlotId; a: SlotCandidate; b: SlotCandidate } | null;
  /** true if any slot was filled, narrowed to a window, or needs disambiguation */
  progress: boolean;
}

export function fillSlots(session: Session, answers: AnswerMap, ctx: SlotContext, specs: SlotSpec[]): FillResult {
  const events: FillEvent[] = [];
  const acks: Ack[] = [];
  let disambiguate: FillResult['disambiguate'] = null;
  let progress = false;

  for (const spec of specs) {
    const outcome = spec.fill(answers, ctx);
    if (outcome.kind === 'absent') continue;
    events.push({ slot: spec.id, outcome });
    const slot = session.slots[spec.id];
    switch (outcome.kind) {
      case 'filled':
        slot.value = outcome.value;
        slot.display = outcome.display;
        slot.confirmed = outcome.confirm === 'none';
        slot.window = null;
        if (outcome.confirm === 'implicit') acks.push({ promptId: `ack_${spec.id}`, vars: { [spec.id]: outcome.display } });
        progress = true;
        break;
      case 'window':
        if (slot.value === null) {
          slot.window = outcome.window;
          progress = true;
        }
        break;
      case 'disambiguate':
        if (!disambiguate) disambiguate = { slot: spec.id, a: outcome.a, b: outcome.b };
        progress = true;
        break;
      case 'invalid':
        break;
    }
  }
  return { session, events, acks, disambiguate, progress };
}

export type NextPrompt =
  | { kind: 'ask'; slot: SlotId; window: DateWindow | null }
  | { kind: 'complete' };

export function nextPrompt(session: Session): NextPrompt {
  const [slot] = missingSlots(session);
  if (!slot) return { kind: 'complete' };
  return { kind: 'ask', slot, window: session.slots[slot].window };
}

export type DtmfResult =
  | { kind: 'collecting' }
  | { kind: 'filled'; slot: SlotId; display: string }
  | { kind: 'invalid'; slot: SlotId }
  | { kind: 'no_target' };

/** Apply a DTMF digit buffer to the slot that was last prompted. */
export function applyDtmf(session: Session, buffer: string, ctx: SlotContext): DtmfResult {
  const target = session.promptedFor;
  if (target === null || target === 'intent') return { kind: 'no_target' };
  const spec = SLOTS[target];
  if (buffer.length < spec.dtmf.length) return { kind: 'collecting' };
  const parsed = spec.dtmf.parse(buffer.slice(0, spec.dtmf.length), ctx);
  if (!parsed) return { kind: 'invalid', slot: target };
  const slot = session.slots[target];
  slot.value = parsed.value;
  slot.display = parsed.display;
  slot.confirmed = true;
  slot.window = null;
  return { kind: 'filled', slot: target, display: parsed.display };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/fia.test.ts`
Expected: 8 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/fia.ts src/core/fia.test.ts
git commit -m "feat(core): add form interpretation loop, retry policy and dtmf fill"
```

---

### Task 19: Decisions, prompt manifest and rendering

**Files:**
- Create: `src/core/decision.ts`, `src/prompts/manifest.json`, `src/prompts/render.ts`, `src/prompts/render.test.ts`

- [ ] **Step 1: Write the failing test**

`src/prompts/render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderTemplate, promptText, decisionToFrames, handoffPromptId } from './render';
import manifest from './manifest.json';

describe('renderTemplate', () => {
  it('substitutes variables', () => {
    expect(renderTemplate('With {provider}.', { provider: 'Dr. Chen' })).toBe('With Dr. Chen.');
  });
  it('throws on a missing variable', () => {
    expect(() => renderTemplate('On {date}.', {})).toThrow(/date/);
  });
});

describe('manifest', () => {
  it('has text and an interruptible flag for every prompt', () => {
    for (const [id, p] of Object.entries(manifest)) {
      expect(typeof p.text, id).toBe('string');
      expect(typeof p.interruptible, id).toBe('boolean');
    }
  });
  it('maps handoff reasons to prompt ids', () => {
    expect(handoffPromptId('live-agent')).toBe('handoff_live_agent');
    expect(manifest).toHaveProperty(handoffPromptId('max-attempts'));
    expect(manifest).toHaveProperty(handoffPromptId('system-failure'));
  });
});

describe('decisionToFrames', () => {
  it('emits ack frames then the prompt frame', () => {
    const frames = decisionToFrames({
      kind: 'prompt', promptId: 'ask_memberId', vars: {}, target: 'memberId', options: [],
      acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }],
    });
    expect(frames).toEqual([
      { type: 'text', token: 'With Dr. Chen.', last: true, lang: 'en-US', interruptible: false, preemptible: false },
      { type: 'text', token: promptText('ask_memberId', {}), last: true, lang: 'en-US', interruptible: true, preemptible: false },
    ]);
  });

  it('ends the call after a handoff prompt', () => {
    const frames = decisionToFrames({ kind: 'handoff', reason: 'billing', promptId: 'handoff_billing' });
    expect(frames[1]).toEqual({ type: 'end', handoffData: '{"reasonCode":"billing"}' });
  });

  it('emits nothing for ignore and hold', () => {
    expect(decisionToFrames({ kind: 'ignore' })).toEqual([]);
    expect(decisionToFrames({ kind: 'hold' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/prompts/render.test.ts`
Expected: FAIL, cannot find module './render'.

- [ ] **Step 3: Write decision.ts**

`src/core/decision.ts`:

```ts
import type { SlotId } from '../domain/forms';
import type { FormId } from '../domain/intents';
import type { Ack } from './fia';

export interface PromptDecision {
  kind: 'prompt';
  promptId: string;
  vars: Record<string, string>;
  /** implicit-confirm phrases spoken before the prompt */
  acks: Ack[];
  /** what the prompt asks for; drives DTMF and attempt accounting */
  target: 'intent' | SlotId | null;
  /** spoken options, for disambiguation and menus */
  options: string[];
}

export type Decision =
  | { kind: 'ignore' }
  | { kind: 'hold' }
  | PromptDecision
  | { kind: 'complete'; form: FormId; promptId: string; vars: Record<string, string> }
  | { kind: 'handoff'; reason: string; promptId: string }
  | { kind: 'replay'; text: string };
```

- [ ] **Step 4: Write the manifest**

`src/prompts/manifest.json`:

```json
{
  "greeting": { "text": "Thanks for calling the clinic. How can I help you today?", "interruptible": true },
  "nomatch_open": { "text": "Sorry, I didn't catch that. You can say things like reschedule, cancel, or check an appointment. How can I help?", "interruptible": true },
  "nomatch_dtmf_menu": { "text": "Let's try the keypad. For a new appointment press 1. To reschedule press 2. To cancel press 3. To confirm an appointment press 4. For billing press 5. For an agent press 0.", "interruptible": true },
  "ask_memberId": { "text": "What's your member ID?", "interruptible": true },
  "ask_memberId_retry": { "text": "Sorry, I need your eight digit member ID. Please say it one digit at a time.", "interruptible": true },
  "ask_memberId_dtmf": { "text": "Please enter your eight digit member ID on the keypad.", "interruptible": true },
  "ask_provider": { "text": "Which provider is the appointment with?", "interruptible": true },
  "ask_provider_retry": { "text": "Sorry, which doctor is it with? For example, Dr. Patel.", "interruptible": true },
  "ask_provider_dtmf": { "text": "Using the keypad: for Dr. Chen press 1, Dr. Cheng 2, Dr. Patel 3, Dr. Okafor 4, Dr. Nguyen 5, Dr. Rossi 6, Dr. Kim 7, Dr. Alvarez 8.", "interruptible": true },
  "ask_date": { "text": "What day works for you?", "interruptible": true },
  "ask_date_retry": { "text": "Sorry, what day would you like? You can say a date, a weekday, or tomorrow.", "interruptible": true },
  "ask_date_dtmf": { "text": "Please enter the date as four digits, month then day.", "interruptible": true },
  "date_narrow_window": { "text": "Which day {window} works for you?", "interruptible": true },
  "ack_intent": { "text": "Sure, I can help you {intentLabel}.", "interruptible": false },
  "ack_provider": { "text": "With {provider}.", "interruptible": false },
  "ack_memberId": { "text": "Member ID {memberId}.", "interruptible": false },
  "ack_date": { "text": "On {date}.", "interruptible": false },
  "confirm_intent_explicit": { "text": "Just to check, do you want to {intentLabel}? Yes or no.", "interruptible": false },
  "disambiguate_intent": { "text": "Do you want to {a}, or {b}?", "interruptible": true },
  "disambiguate_provider": { "text": "Was that {a}, or {b}?", "interruptible": true },
  "schedule_confirmed": { "text": "You're booked with {provider} on {date}, member ID {memberId}. Goodbye.", "interruptible": false },
  "reschedule_confirmed": { "text": "Your appointment with {provider} is moved to {date}. Goodbye.", "interruptible": false },
  "cancel_confirmed": { "text": "Your appointment with {provider} is cancelled. Goodbye.", "interruptible": false },
  "appointment_details": { "text": "Your next appointment with {provider} is confirmed. Goodbye.", "interruptible": false },
  "handoff_live_agent": { "text": "One moment while I connect you to someone who can help.", "interruptible": false },
  "handoff_billing": { "text": "Connecting you to billing now.", "interruptible": false },
  "handoff_frustrated": { "text": "I'm sorry for the trouble. Let me get you to a person.", "interruptible": false },
  "handoff_max_attempts": { "text": "Let me get someone to help you with that.", "interruptible": false },
  "handoff_system_failure": { "text": "I'm having trouble right now. Let me connect you to someone.", "interruptible": false },
  "system_slow_dtmf_hint": { "text": "Sorry for the delay. You can also use your keypad.", "interruptible": true }
}
```

- [ ] **Step 5: Write render.ts**

`src/prompts/render.ts`:

```ts
import manifest from './manifest.json';
import type { Decision } from '../core/decision';
import { endFrame, textFrame, type OutboundFrame } from '../channel/frames';

export type PromptId = keyof typeof manifest;

export interface PromptEntry {
  text: string;
  interruptible: boolean;
  /** audio asset url; null until the Twilio sub-project records assets */
  audio?: string | null;
}

export const PROMPTS: Record<string, PromptEntry> = manifest;

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`prompt variable missing: ${name}`);
    return v;
  });
}

export function promptEntry(id: string): PromptEntry {
  const entry = PROMPTS[id];
  if (!entry) throw new Error(`unknown prompt id: ${id}`);
  return entry;
}

export function promptText(id: string, vars: Record<string, string>): string {
  return renderTemplate(promptEntry(id).text, vars);
}

export function handoffPromptId(reason: string): string {
  return `handoff_${reason.replace(/-/g, '_')}`;
}

export function decisionToFrames(decision: Decision): OutboundFrame[] {
  switch (decision.kind) {
    case 'ignore':
    case 'hold':
      return [];
    case 'replay':
      return [textFrame(decision.text, true)];
    case 'prompt': {
      const frames: OutboundFrame[] = decision.acks.map((a) => textFrame(promptText(a.promptId, a.vars), false));
      frames.push(textFrame(promptText(decision.promptId, decision.vars), promptEntry(decision.promptId).interruptible));
      return frames;
    }
    case 'complete':
      return [textFrame(promptText(decision.promptId, decision.vars), false), endFrame('completed')];
    case 'handoff':
      return [textFrame(promptText(decision.promptId, {}), false), endFrame(decision.reason)];
  }
}

/** The spoken text of a decision, for lastPromptText and the CLI. */
export function decisionText(decision: Decision): string {
  return decisionToFrames(decision)
    .filter((f): f is Extract<OutboundFrame, { type: 'text' }> => f.type === 'text')
    .map((f) => f.token)
    .join(' ');
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run src/prompts/render.test.ts`
Expected: 7 tests passed.

- [ ] **Step 7: Commit**

```bash
git add src/core/decision.ts src/prompts
git commit -m "feat(prompts): add decision type, prompt manifest and frame rendering"
```

---

### Task 20: The turn function

**Files:**
- Create: `src/core/turn.ts`, `src/core/turn.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/turn.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { plan, resolve, type TurnContext } from './turn';
import { newSession, type Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { promptFrame, dtmfFrames, setupFrame } from '../channel/frames';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap } from '../jev/types';

const tc: TurnContext = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS } };

function answers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    provider: choice({ none: 0.95, chen: 0.05 }),
    containsMemberId: noul(0.05),
    dateMode: choice({ none: 0.95, window: 0.05 }),
    ...over,
  };
}

function started(): Session {
  return resolve(newSession('s', 0), setupFrame('s'), null, tc).session;
}

function say(session: Session, text: string, over: AnswerMap) {
  const event = promptFrame(text);
  const p = plan(session, event, tc);
  expect(p.needsModel).toBe(true);
  return resolve(session, event, answers(over), tc);
}

describe('turn', () => {
  it('greets on setup without a model call', () => {
    const p = plan(newSession('s', 0), setupFrame('s'), tc);
    expect(p.needsModel).toBe(false);
    const r = resolve(newSession('s', 0), setupFrame('s'), null, tc);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'greeting', target: 'intent' });
    expect(r.session.lastPromptId).toBe('greeting');
    expect(r.session.turnIndex).toBe(1);
  });

  it('routes an over-answered utterance and asks for the first missing slot with acks', () => {
    const r = say(started(), 'reschedule with dr chen next week', {
      intent: choice({ reschedule: 0.94, cancel: 0.03, none: 0.03 }),
      provider: choice({ chen: 0.91, cheng: 0.05, none: 0.04 }),
      dateMode: choice({ window: 0.9, none: 0.1 }),
      dateWindow: choice({ next_week: 0.88, none: 0.12 }),
    });
    expect(r.session.form).toBe('reschedule');
    expect(r.session.slots.provider.value).toBe('chen');
    expect(r.session.slots.date.window?.label).toBe('next_week');
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId', target: 'memberId', acks: [] });
    expect(r.frames.map((f) => f.type)).toEqual(['text']);
  });

  it('fills a slot from a directed answer and narrows the window next', () => {
    let r = say(started(), 'reschedule with dr chen next week', {
      intent: choice({ reschedule: 0.94, none: 0.06 }),
      provider: choice({ chen: 0.91, none: 0.09 }),
      dateMode: choice({ window: 0.9, none: 0.1 }),
      dateWindow: choice({ next_week: 0.88, none: 0.12 }),
    });
    r = say(r.session, 'four four seven one eight two nine three', {
      containsMemberId: noul(0.95),
      memberIdSpan: choice({ 'four four seven one eight two nine three': 0.9, none: 0.1 }),
      memberIdComplete: noul(0.9),
    });
    expect(r.session.slots.memberId.value).toBe('44718293');
    expect(r.decision).toMatchObject({
      kind: 'prompt', promptId: 'date_narrow_window', target: 'date', vars: { window: 'next week' },
      acks: [{ promptId: 'ack_memberId', vars: { memberId: '4471 8293' } }],
    });
  });

  it('completes the form and ends the call', () => {
    let r = say(started(), 'cancel with dr patel', {
      intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ patel: 0.92, none: 0.08 }),
    });
    r = resolve(r.session, dtmfFrames('44718293')[0]!, null, tc);
    for (const d of dtmfFrames('4718293')) r = resolve(r.session, d, null, tc);
    expect(r.decision).toMatchObject({ kind: 'complete', form: 'cancel', promptId: 'cancel_confirmed' });
    expect(r.frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed"}' });
    expect(r.session.ended).toBe(true);
  });

  it('walks the retry policy: open, dtmf menu, then agent', () => {
    let r = say(started(), 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'nomatch_open' });
    r = say(r.session, 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'nomatch_dtmf_menu' });
    expect(r.session.menuActive).toBe(true);
    r = say(r.session, 'blah', { intent: choice({ none: 0.7, other: 0.3 }), menuNumberSaid: choice({ none: 0.9, '1': 0.1 }) });
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('routes a dtmf menu digit', () => {
    let r = say(started(), 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    r = say(r.session, 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    r = resolve(r.session, dtmfFrames('3')[0]!, null, tc);
    expect(r.session.form).toBe('cancel');
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId' });
  });

  it('asks an explicit confirmation and acts on yes', () => {
    let r = say(started(), 'maybe cancel', { intent: choice({ cancel: 0.5, none: 0.5 }) });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit', options: ['yes', 'no'] });
    expect(r.session.pendingConfirmation).toEqual({ target: 'intent', intent: 'cancel' });
    r = say(r.session, 'yes', { confirmsYes: noul(0.9), confirmsNo: noul(0.1) });
    expect(r.session.form).toBe('cancel');
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId' });
  });

  it('handles a client failure once with a hint and twice with a handoff', () => {
    const err = { name: 'JevClientError', message: 'timeout' };
    let r = resolve(started(), promptFrame('hello'), null, tc, err);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'system_slow_dtmf_hint' });
    r = resolve(r.session, promptFrame('hello'), null, tc, err);
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'system-failure' });
  });

  it('ignores side speech without counting an attempt', () => {
    const r = say(started(), 'honey where are the keys', { addressedToSystem: noul(0.1) });
    expect(r.decision).toEqual({ kind: 'ignore' });
    expect(r.session.intentAttempts).toBe(0);
    expect(r.frames).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/turn.test.ts`
Expected: FAIL, cannot find module './turn'.

- [ ] **Step 3: Write turn.ts**

`src/core/turn.ts`:

```ts
import type { AnswerMap, QuestionMap } from '../jev/types';
import type { InboundFrame, OutboundFrame } from '../channel/frames';
import type { SlotId } from '../domain/forms';
import { FORMS } from '../domain/forms';
import { INTENT_LABELS, INTENT_MENU, isFormIntent, type FormId } from '../domain/intents';
import { SLOTS, allSlots, slotsFor, type SlotContext } from '../domain/slots';
import { describeWindow, type DateWindow } from './extract/date';
import { candidateSpans } from './spans';
import { cloneSession, missingSlots, setForm, type Session } from './session';
import { buildTurnState, type TurnState } from './state';
import { buildQuestions } from './questions';
import { evaluateGates, type GateRow, type Verdict } from './gates';
import { applyDtmf, fillSlots, nextPrompt, retryStep, type Ack, type FillEvent } from './fia';
import type { Decision, PromptDecision } from './decision';
import type { Thresholds } from './thresholds';
import { decisionText, decisionToFrames, handoffPromptId } from '../prompts/render';

export interface TurnContext {
  nowMs: number;
  todayIso: string;
  thresholds: Thresholds;
}

export interface Plan {
  needsModel: boolean;
  turnState: TurnState | null;
  questions: QuestionMap | null;
}

export interface TurnError {
  name: string;
  message: string;
}

export interface TurnResult {
  session: Session;
  turnState: TurnState | null;
  rows: GateRow[];
  verdict: Verdict | null;
  fillEvents: FillEvent[];
  decision: Decision;
  frames: OutboundFrame[];
}

function slotContext(text: string, tc: TurnContext): SlotContext {
  return { text, candidateSpans: candidateSpans(text), todayIso: tc.todayIso, thresholds: tc.thresholds };
}

export function plan(session: Session, event: InboundFrame, tc: TurnContext): Plan {
  if (event.type !== 'prompt' || session.ended) return { needsModel: false, turnState: null, questions: null };
  const turnState = buildTurnState(session, { text: event.voicePrompt, isFinal: event.last, dtmf: null }, tc.nowMs);
  const questions = buildQuestions(session, slotContext(event.voicePrompt, tc));
  return { needsModel: true, turnState, questions };
}

function prompt(promptId: string, target: PromptDecision['target'], vars: Record<string, string> = {}, acks: Ack[] = [], options: string[] = []): PromptDecision {
  return { kind: 'prompt', promptId, vars, acks, target, options };
}

function handoff(reason: string): Decision {
  return { kind: 'handoff', reason, promptId: handoffPromptId(reason) };
}

function askSlot(slot: SlotId, window: DateWindow | null, acks: Ack[]): PromptDecision {
  if (window) return prompt('date_narrow_window', slot, { window: describeWindow(window) }, acks);
  return prompt(`ask_${slot}`, slot, {}, acks);
}

function completeForm(s: Session, form: FormId): Decision {
  const completion = FORMS[form].completion;
  if (completion.kind === 'handoff') return handoff(completion.reason);
  const vars: Record<string, string> = {};
  for (const id of Object.keys(s.slots) as SlotId[]) vars[id] = s.slots[id].display ?? '';
  return { kind: 'complete', form, promptId: completion.promptId, vars };
}

function failAttempt(s: Session, target: 'intent' | SlotId, t: Thresholds): Decision {
  const attempts = target === 'intent' ? ++s.intentAttempts : ++s.slots[target].attempts;
  const step = retryStep(attempts, t);
  if (step === 'agent') return handoff('max-attempts');
  if (target === 'intent') {
    if (step === 'dtmf') return prompt('nomatch_dtmf_menu', 'intent', {}, [], INTENT_MENU.map((m) => m.digit));
    return prompt('nomatch_open', 'intent');
  }
  return prompt(step === 'dtmf' ? `ask_${target}_dtmf` : `ask_${target}_retry`, target);
}

/** After slots changed: disambiguate, ask the next slot, or complete. */
function continueForm(s: Session, acks: Ack[], disambiguate: { slot: SlotId; a: { display: string }; b: { display: string } } | null): Decision {
  if (disambiguate) {
    return prompt(`disambiguate_${disambiguate.slot}`, disambiguate.slot, { a: disambiguate.a.display, b: disambiguate.b.display }, acks, [disambiguate.a.display, disambiguate.b.display]);
  }
  const next = nextPrompt(s);
  if (next.kind === 'complete') return completeForm(s, s.form!);
  return askSlot(next.slot, next.window, acks);
}

function enterForm(s: Session, form: FormId, confirm: 'none' | 'implicit', answers: AnswerMap, ctx: SlotContext): { decision: Decision; events: FillEvent[] } {
  setForm(s, form);
  const acks: Ack[] = confirm === 'implicit' ? [{ promptId: 'ack_intent', vars: { intentLabel: INTENT_LABELS[form] } }] : [];
  const fill = fillSlots(s, answers, ctx, slotsFor(form));
  return { decision: continueForm(s, [...acks, ...fill.acks], fill.disambiguate), events: fill.events };
}

function handleVerdict(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, tc: TurnContext): { decision: Decision; events: FillEvent[] } {
  const t = tc.thresholds;
  switch (verdict.kind) {
    case 'ignore':
      return { decision: { kind: 'ignore' }, events: [] };
    case 'hold':
      return { decision: { kind: 'hold' }, events: [] };
    case 'nomatch':
      return { decision: failAttempt(s, s.promptedFor ?? 'intent', t), events: [] };
    case 'handoff':
      return { decision: handoff(verdict.reason), events: [] };
    case 'replay':
      return { decision: { kind: 'replay', text: s.lastPromptText }, events: [] };
    case 'confirmed': {
      const intent = s.pendingConfirmation!.intent;
      s.pendingConfirmation = null;
      if (intent === 'agent') return { decision: handoff('live-agent'), events: [] };
      if (!isFormIntent(intent)) return { decision: failAttempt(s, 'intent', t), events: [] };
      return enterForm(s, intent, 'none', answers, ctx);
    }
    case 'rejected':
      s.pendingConfirmation = null;
      return { decision: failAttempt(s, 'intent', t), events: [] };
    case 'route':
      if (verdict.confirm === 'explicit') {
        s.pendingConfirmation = { target: 'intent', intent: verdict.intent };
        return { decision: prompt('confirm_intent_explicit', 'intent', { intentLabel: INTENT_LABELS[verdict.intent] }, [], ['yes', 'no']), events: [] };
      }
      return enterForm(s, verdict.intent, verdict.confirm, answers, ctx);
    case 'disambiguate_intent':
      return { decision: prompt('disambiguate_intent', 'intent', { a: INTENT_LABELS[verdict.a], b: INTENT_LABELS[verdict.b] }, [], [INTENT_LABELS[verdict.a], INTENT_LABELS[verdict.b]]), events: [] };
    case 'intent_failed':
      return { decision: failAttempt(s, 'intent', t), events: [] };
    case 'proceed': {
      const specs = s.form ? slotsFor(s.form) : allSlots();
      const fill = fillSlots(s, answers, ctx, specs);
      if (!fill.progress) {
        const target = s.promptedFor && s.promptedFor !== 'intent' ? s.promptedFor : (missingSlots(s)[0] ?? 'intent');
        return { decision: failAttempt(s, target, t), events: fill.events };
      }
      return { decision: continueForm(s, fill.acks, fill.disambiguate), events: fill.events };
    }
  }
}

function handleDtmf(s: Session, digit: string, tc: TurnContext): Decision {
  s.dtmfBuffer += digit;
  if (s.menuActive) {
    const option = INTENT_MENU.find((m) => m.digit === digit);
    s.dtmfBuffer = '';
    if (!option) return { kind: 'ignore' };
    if (option.intent === 'agent') return handoff('live-agent');
    if (!isFormIntent(option.intent)) return { kind: 'ignore' };
    setForm(s, option.intent);
    return continueForm(s, [], null);
  }
  const result = applyDtmf(s, s.dtmfBuffer, slotContext('', tc));
  switch (result.kind) {
    case 'collecting':
    case 'no_target':
      return { kind: 'ignore' };
    case 'invalid':
      s.dtmfBuffer = '';
      return failAttempt(s, result.slot, tc.thresholds);
    case 'filled':
      s.dtmfBuffer = '';
      return continueForm(s, [], null);
  }
}

function handleFailure(s: Session): Decision {
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= 2) return handoff('system-failure');
  return prompt('system_slow_dtmf_hint', s.promptedFor);
}

function bookkeep(s: Session, decision: Decision, verdictLabel: string): void {
  if (decision.kind === 'ignore' || decision.kind === 'hold') return;
  s.turnIndex += 1;
  s.history.push({ node: s.lastPromptId ?? 'start', intent: verdictLabel, outcome: decision.kind });
  if (decision.kind === 'prompt') {
    s.lastPromptId = decision.promptId;
    s.lastPromptText = decisionText(decision);
    s.lastPromptOptions = decision.options;
    s.promptedFor = decision.target;
    s.menuActive = decision.promptId === 'nomatch_dtmf_menu';
    s.dtmfBuffer = '';
  } else if (decision.kind === 'complete' || decision.kind === 'handoff') {
    s.lastPromptId = decision.promptId;
    s.lastPromptText = decisionText(decision);
    s.ended = true;
  }
}

export function resolve(session: Session, event: InboundFrame, answers: AnswerMap | null, tc: TurnContext, error: TurnError | null = null): TurnResult {
  const s = cloneSession(session);
  const base = { session: s, turnState: null, rows: [], verdict: null, fillEvents: [] };
  if (s.ended) return { ...base, decision: { kind: 'ignore' }, frames: [] };

  switch (event.type) {
    case 'setup': {
      const decision = prompt('greeting', 'intent');
      bookkeep(s, decision, 'setup');
      return { ...base, decision, frames: decisionToFrames(decision) };
    }
    case 'dtmf': {
      const decision = handleDtmf(s, event.digit, tc);
      bookkeep(s, decision, `dtmf:${event.digit}`);
      return { ...base, decision, frames: decisionToFrames(decision) };
    }
    case 'interrupt':
    case 'error':
      return { ...base, decision: { kind: 'ignore' }, frames: [] };
    case 'prompt': {
      const turnState = buildTurnState(s, { text: event.voicePrompt, isFinal: event.last, dtmf: null }, tc.nowMs);
      if (error || answers === null) {
        const decision = handleFailure(s);
        bookkeep(s, decision, 'error');
        return { ...base, turnState, decision, frames: decisionToFrames(decision) };
      }
      s.consecutiveFailures = 0;
      const ctx = slotContext(event.voicePrompt, tc);
      const { rows, verdict } = evaluateGates(s, turnState, answers, tc.thresholds);
      const { decision, events } = handleVerdict(s, verdict, answers, ctx, tc);
      bookkeep(s, decision, verdict.kind);
      return { session: s, turnState, rows, verdict, fillEvents: events, decision, frames: decisionToFrames(decision) };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/turn.test.ts`
Expected: 9 tests passed. If the "completes the form" test fails on the DTMF loop, check that `applyDtmf` is receiving the growing `dtmfBuffer` and that `bookkeep` clears the buffer only on a `prompt` decision, never on `ignore`.

- [ ] **Step 5: Commit**

```bash
git add src/core/turn.ts src/core/turn.test.ts
git commit -m "feat(core): add plan/resolve turn function"
```

---

### Task 21: Trace record and writer

**Files:**
- Create: `src/trace/types.ts`, `src/trace/writer.ts`, `src/trace/writer.test.ts`

- [ ] **Step 1: Write the failing test**

`src/trace/writer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceWriter, buildTraceRecord } from './writer';
import { newSession } from '../core/session';
import { resolve } from '../core/turn';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { setupFrame } from '../channel/frames';

describe('trace', () => {
  it('builds a v1 record and appends one JSON line per write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const path = join(dir, 'out', 'run.jsonl');
    const writer = new TraceWriter(path);
    const event = setupFrame('s');
    const result = resolve(newSession('s', 0), event, null, { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS } });
    const record = buildTraceRecord({
      result, event, questions: null, response: null, error: null,
      timing: { planMs: 0, askMs: 0, resolveMs: 1, totalMs: 1 }, ts: '2026-09-18T00:00:00.000Z',
      pricePerMtok: 0.042,
    });
    writer.write(record);
    writer.write(record);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.v).toBe(1);
    expect(parsed.sessionId).toBe('s');
    expect(parsed.source).toBe('none');
    expect(parsed.decision.kind).toBe('prompt');
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 0, estimated: true, costUsd: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/trace/writer.test.ts`
Expected: FAIL, cannot find module './writer'.

- [ ] **Step 3: Write types.ts**

`src/trace/types.ts`:

```ts
import type { InboundFrame, OutboundFrame } from '../channel/frames';
import type { AnswerMap, AnswerSource, QuestionMap } from '../jev/types';
import type { TurnState } from '../core/state';
import type { GateRow } from '../core/gates';
import type { Decision } from '../core/decision';
import type { SlotState } from '../core/session';
import type { SlotId } from '../domain/forms';

export type TraceSource = AnswerSource | 'dtmf' | 'error' | 'none';

export interface TraceTiming {
  planMs: number;
  askMs: number;
  resolveMs: number;
  totalMs: number;
}

export interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  costUsd: number;
}

/** Frozen at v:1. All three layers write this shape. */
export interface TraceRecord {
  v: 1;
  sessionId: string;
  turnIndex: number;
  ts: string;
  event: InboundFrame;
  turnState: TurnState | null;
  questions: QuestionMap | null;
  answers: AnswerMap | null;
  source: TraceSource;
  error: { name: string; message: string } | null;
  gates: GateRow[];
  decision: Decision;
  frames: OutboundFrame[];
  slots: Record<SlotId, SlotState>;
  timing: TraceTiming;
  usage: TraceUsage;
}
```

- [ ] **Step 4: Write writer.ts**

`src/trace/writer.ts`:

```ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TraceRecord, TraceTiming } from './types';
import type { InboundFrame } from '../channel/frames';
import type { JevResponse, QuestionMap } from '../jev/types';
import type { TurnError, TurnResult } from '../core/turn';

export class TraceWriter {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(record: TraceRecord): void {
    appendFileSync(this.path, JSON.stringify(record) + '\n');
  }
}

export interface TraceInput {
  result: TurnResult;
  event: InboundFrame;
  questions: QuestionMap | null;
  response: JevResponse | null;
  error: TurnError | null;
  timing: TraceTiming;
  ts: string;
  pricePerMtok: number;
}

export function buildTraceRecord(input: TraceInput): TraceRecord {
  const { result, event, questions, response, error, timing, ts, pricePerMtok } = input;
  const source = error ? 'error' : response ? response.source : event.type === 'dtmf' ? 'dtmf' : 'none';
  const inputTokens = response?.usage.inputTokens ?? 0;
  return {
    v: 1,
    sessionId: result.session.sessionId,
    turnIndex: result.session.turnIndex,
    ts,
    event,
    turnState: result.turnState,
    questions,
    answers: response?.answers ?? null,
    source,
    error,
    gates: result.rows,
    decision: result.decision,
    frames: result.frames,
    slots: result.session.slots,
    timing,
    usage: {
      inputTokens,
      outputTokens: response?.usage.outputTokens ?? 0,
      estimated: response?.usage.estimated ?? true,
      costUsd: (inputTokens * pricePerMtok) / 1_000_000,
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/trace/writer.test.ts`
Expected: 1 test passed.

- [ ] **Step 6: Commit**

```bash
git add src/trace
git commit -m "feat(trace): add frozen v1 trace record and JSONL writer"
```

---

### Task 22: Distribution helpers, quiet defaults, and the heuristic stub

**Files:**
- Create: `src/jev/distributions.ts`, `src/jev/defaults.ts`, `src/jev/heuristicStub.ts`, `src/jev/heuristicStub.test.ts`

- [ ] **Step 1: Write the failing test**

`src/jev/heuristicStub.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HeuristicStubClient } from './heuristicStub';
import { sharp } from './distributions';
import { buildQuestions } from '../core/questions';
import { newSession } from '../core/session';
import { buildTurnState } from '../core/state';
import { candidateSpans } from '../core/spans';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { isChoice, isNoul, isScore, rankProbabilities } from './types';

async function ask(text: string) {
  const session = newSession('s', 0);
  const state = buildTurnState(session, { text, isFinal: true, dtmf: null }, 0);
  const questions = buildQuestions(session, { text, candidateSpans: candidateSpans(text), todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS } });
  const res = await new HeuristicStubClient().ask({ state: state as never, questions });
  expect(Object.keys(res.answers).sort()).toEqual(Object.keys(questions).sort());
  return res;
}

describe('sharp', () => {
  it('gives the winner the sharpness and spreads the rest', () => {
    expect(sharp(['a', 'b', 'c'], 'b', 0.9)).toEqual({ a: 0.05, b: 0.9, c: 0.05 });
  });
});

describe('HeuristicStubClient', () => {
  it('answers every question with the right type', async () => {
    const res = await ask('I need to reschedule with dr chen next week');
    expect(isChoice(res.answers.intent)).toBe(true);
    expect(isScore(res.answers.frustration)).toBe(true);
    expect(isNoul(res.answers.intelligible)).toBe(true);
    expect(res.source).toBe('stub:heuristic');
    expect(res.usage.estimated).toBe(true);
  });

  it('guesses intent, provider and date window from keywords', async () => {
    const res = await ask('I need to reschedule with dr chen next week');
    expect(rankProbabilities((res.answers.intent as never as { probabilities: Record<string, number> }).probabilities)[0]?.label).toBe('reschedule');
    expect((res.answers.provider as { choice: string }).choice).toBe('chen');
    expect((res.answers.dateMode as { choice: string }).choice).toBe('window');
    expect((res.answers.dateWindow as { choice: string }).choice).toBe('next_week');
  });

  it('detects a spoken member id and picks the eight-digit span', async () => {
    const res = await ask('my id is four four seven one eight two nine three');
    expect((res.answers.containsMemberId as { noul: number }).noul).toBeGreaterThan(0.8);
    expect((res.answers.memberIdSpan as { choice: string }).choice).toBe('four four seven one eight two nine three');
  });

  it('flags a request for a human', async () => {
    const res = await ask('just let me talk to a person');
    expect((res.answers.wantsHuman as { noul: number }).noul).toBeGreaterThan(0.8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/jev/heuristicStub.test.ts`
Expected: FAIL, cannot find module './heuristicStub'.

- [ ] **Step 3: Write distributions.ts**

`src/jev/distributions.ts`:

```ts
import type { ChoiceAnswer, ChoiceQuestion, NoulAnswer, ScoreAnswer, ScoreQuestion } from './types';

/** winner gets `sharpness`; the remainder is split evenly across the other labels. */
export function sharp(labels: readonly string[], winner: string, sharpness: number): Record<string, number> {
  const others = labels.filter((l) => l !== winner);
  const rest = others.length ? (1 - sharpness) / others.length : 0;
  const out: Record<string, number> = {};
  for (const l of labels) out[l] = l === winner ? (others.length ? sharpness : 1) : rest;
  return round(out);
}

export function normalize(probs: Record<string, number>): Record<string, number> {
  const total = Object.values(probs).reduce((a, b) => a + b, 0) || 1;
  return round(Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, v / total])));
}

function round(probs: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
}

export function choiceAnswer(probabilities: Record<string, number>): ChoiceAnswer {
  const [top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return { type: 'choice', choice: top?.[0] ?? 'none', probabilities, confidence: top?.[1] ?? 0 };
}

export function scoreAnswer(q: ScoreQuestion, probabilities: Record<string, number>): ScoreAnswer {
  const score = q.levels.reduce((acc, l, i) => acc + (i + 1) * (probabilities[l.label] ?? 0), 0);
  return { type: 'score', score, probabilities, confidence: Math.max(...Object.values(probabilities)) };
}

export function noulAnswer(noul: number): NoulAnswer {
  return { type: 'noul', noul };
}

export function choiceLabels(q: ChoiceQuestion): string[] {
  return Object.keys(q.criteria);
}
```

- [ ] **Step 4: Write defaults.ts**

`src/jev/defaults.ts`:

```ts
import { choiceAnswer, choiceLabels, noulAnswer, scoreAnswer, sharp } from './distributions';
import type { Answer, Question } from './types';

/** Noul values for a calm, on-topic, complete utterance with nothing notable. */
export const QUIET_NOUL: Record<string, number> = {
  addressedToSystem: 0.92,
  intelligible: 0.93,
  utteranceComplete: 0.88,
  wantsHuman: 0.04,
  rephrasingLastTurn: 0.08,
  confusedByPrompt: 0.06,
  spokeAMenuNumber: 0.03,
  triedSelfService: 0.1,
  containsMemberId: 0.05,
  memberIdComplete: 0.4,
  confirmsYes: 0.1,
  confirmsNo: 0.1,
};

export const QUIET_SCORE_WINNER: Record<string, string> = {
  frustration: 'none',
  urgency: 'normal',
};

/** The answer a question gets when nothing in the utterance bears on it. */
export function quietAnswer(id: string, q: Question, sharpness: number): Answer {
  switch (q.type) {
    case 'noul':
      return noulAnswer(QUIET_NOUL[id] ?? 0.1);
    case 'score': {
      const labels = q.levels.map((l) => l.label);
      return scoreAnswer(q, sharp(labels, QUIET_SCORE_WINNER[id] ?? labels[0]!, 0.85));
    }
    case 'choice': {
      const labels = choiceLabels(q);
      const winner = labels.includes('none') ? 'none' : labels[0]!;
      return choiceAnswer(sharp(labels, winner, sharpness));
    }
  }
}
```

- [ ] **Step 5: Write heuristicStub.ts**

`src/jev/heuristicStub.ts`:

```ts
import { choiceAnswer, choiceLabels, noulAnswer, normalize, scoreAnswer, sharp } from './distributions';
import { quietAnswer } from './defaults';
import { estimateTokens, type Answer, type AnswerMap, type JevClient, type JevRequest, type JevResponse, type Question } from './types';
import { spokenToDigits } from '../core/extract/spokenNumber';
import { MONTHS, WEEKDAYS } from '../core/extract/date';
import { INTENT_MENU } from '../domain/intents';
import { PROVIDERS } from '../domain/slots/provider';

const INTENT_KEYWORDS: Array<[string, RegExp]> = [
  ['reschedule', /\b(reschedule|move|change|push|different day|another day)\b/],
  ['schedule_new', /\b(schedule|book|make|set up|new appointment)\b/],
  ['cancel', /\bcancel/],
  ['confirm_appointment', /\b(confirm|check|verify|when is|do i have|still on)\b/],
  ['billing', /\b(bill|billing|charge|charged|payment|invoice|insurance|copay|owe)\b/],
  ['agent', /\b(agent|representative|person|human|operator|someone|somebody)\b/],
  ['repeat_prompt', /\b(repeat|say that again|what were the options|didn't hear)\b/],
];

const NUMBER_WORD_DIGIT: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5' };

function textOf(state: unknown): string {
  const s = state as { asr?: { text?: string } } | null;
  return (s?.asr?.text ?? '').toLowerCase();
}

function has(text: string, re: RegExp): boolean {
  return re.test(text);
}

function intentAnswer(text: string, labels: string[]): Answer {
  const hits = INTENT_KEYWORDS.filter(([, re]) => re.test(text)).map(([label]) => label);
  if (hits.length === 0) return choiceAnswer(sharp(labels, 'none', 0.8));
  const probs: Record<string, number> = {};
  for (const l of labels) probs[l] = 0.01;
  probs[hits[0]!] = 0.85;
  for (const h of hits.slice(1)) probs[h] = 0.3;
  return choiceAnswer(normalize(probs));
}

function providerAnswer(text: string, labels: string[]): Answer {
  const hits = PROVIDERS.filter((p) => new RegExp(`\\b${p.name.toLowerCase()}\\b`).test(text)).map((p) => p.key);
  if (hits.length === 0) return choiceAnswer(sharp(labels, 'none', 0.9));
  if (hits.length === 1) return choiceAnswer(sharp(labels, hits[0]!, 0.9));
  const probs: Record<string, number> = {};
  for (const l of labels) probs[l] = 0.01;
  for (const h of hits) probs[h] = 0.45;
  return choiceAnswer(normalize(probs));
}

function spanAnswer(labels: string[]): Answer {
  const scored = labels
    .filter((l) => l !== 'none')
    .map((l) => ({ l, digits: spokenToDigits(l), tokens: l.split(' ').length }))
    .filter((x) => x.digits.length === 8)
    .sort((a, b) => a.tokens - b.tokens);
  return choiceAnswer(sharp(labels, scored[0]?.l ?? 'none', 0.9));
}

function bestDigits(text: string): string {
  return spokenToDigits(text);
}

function dateAnswers(id: string, text: string, labels: string[]): Answer {
  const month = MONTHS.find((m) => has(text, new RegExp(`\\b${m}\\b`)));
  const weekday = WEEKDAYS.find((w) => has(text, new RegExp(`\\b${w}\\b`)));
  const window = has(text, /\bnext week\b/) ? 'next_week' : has(text, /\bthis week\b/) ? 'this_week'
    : has(text, /\bnext month\b/) ? 'next_month' : has(text, /\bthis month\b/) ? 'this_month' : 'none';
  const relative = has(text, /\bday after tomorrow\b/) ? 'day_after_tomorrow' : has(text, /\btomorrow\b/) ? 'tomorrow' : has(text, /\btoday\b/) ? 'today' : 'none';
  const dayMatch = month ? new RegExp(`\\b${month}\\s+(?:the\\s+)?(\\d{1,2})`).exec(text) : null;
  const day = dayMatch ? dayMatch[1]! : 'none';
  const qualifier = weekday && has(text, new RegExp(`\\bnext\\s+${weekday}\\b`)) ? 'next' : weekday && has(text, new RegExp(`\\bthis\\s+${weekday}\\b`)) ? 'this' : 'none';
  const mode = window !== 'none' ? 'window' : relative !== 'none' ? 'relative_day' : weekday ? 'weekday' : month ? 'absolute' : 'none';
  const pick = (v: string) => choiceAnswer(sharp(labels, labels.includes(v) ? v : 'none', 0.88));
  switch (id) {
    case 'dateMode': return pick(mode);
    case 'dateMonth': return pick(month ?? 'none');
    case 'dateDay': return pick(day);
    case 'dateWeekday': return pick(weekday ?? 'none');
    case 'dateWeekdayQualifier': return pick(qualifier);
    case 'dateRelativeDay': return pick(relative);
    case 'dateWindow': return pick(window);
    default: return pick('none');
  }
}

export function answerHeuristically(id: string, q: Question, text: string): Answer {
  if (q.type === 'choice') {
    const labels = choiceLabels(q);
    switch (id) {
      case 'intent': return intentAnswer(text, labels);
      case 'provider': return providerAnswer(text, labels);
      case 'memberIdSpan': return spanAnswer(labels);
      case 'menuNumberSaid': {
        const tok = text.trim().split(/\s+/)[0] ?? '';
        const digit = /^\d$/.test(tok) ? tok : NUMBER_WORD_DIGIT[tok];
        const ok = digit && INTENT_MENU.some((m) => m.digit === digit);
        return choiceAnswer(sharp(labels, ok ? digit! : 'none', 0.9));
      }
      case 'languageSwitch':
        return choiceAnswer(sharp(labels, has(text, /\b(spanish|espanol|español)\b/) ? 'es' : has(text, /\b(french|francais)\b/) ? 'fr' : 'none', 0.9));
      default:
        if (id.startsWith('date')) return dateAnswers(id, text, labels);
        return quietAnswer(id, q, 0.9);
    }
  }
  if (q.type === 'score') {
    const labels = q.levels.map((l) => l.label);
    if (id === 'frustration') {
      const high = has(text, /\b(ridiculous|stupid|damn|hell|third time|already told|frustrat\w*|ugh|useless)\b/);
      const mild = has(text, /\b(come on|seriously|again|hurry)\b/);
      return scoreAnswer(q, sharp(labels, high ? 'high' : mild ? 'mild' : 'none', 0.7));
    }
    if (id === 'urgency') {
      return scoreAnswer(q, sharp(labels, has(text, /\b(urgent|emergency|asap|right away|today)\b/) ? 'high' : 'normal', 0.6));
    }
    return quietAnswer(id, q, 0.9);
  }
  switch (id) {
    case 'intelligible': return noulAnswer(/[a-z]{2,}/.test(text) ? 0.9 : 0.3);
    case 'utteranceComplete': return noulAnswer(/\b(um|uh|and)\s*$/.test(text) ? 0.3 : 0.85);
    case 'wantsHuman': return noulAnswer(has(text, /\b(agent|representative|person|human|operator|someone|somebody)\b/) ? 0.9 : 0.05);
    case 'confusedByPrompt': return noulAnswer(has(text, /\b(what|huh|pardon|sorry)\b\??$/) ? 0.7 : 0.1);
    case 'spokeAMenuNumber': return noulAnswer(/^(press\s+)?(\d|one|two|three|four|five|zero)$/.test(text.trim()) ? 0.9 : 0.05);
    case 'triedSelfService': return noulAnswer(has(text, /\b(website|online|the app|portal)\b/) ? 0.8 : 0.1);
    case 'containsMemberId': return noulAnswer(bestDigits(text).length >= 4 ? 0.9 : 0.05);
    case 'memberIdComplete': return noulAnswer(bestDigits(text).length >= 8 ? 0.9 : 0.4);
    case 'confirmsYes': return noulAnswer(has(text, /\b(yes|yeah|yep|correct|right|sure|that's it)\b/) ? 0.9 : 0.1);
    case 'confirmsNo': return noulAnswer(has(text, /\b(no|nope|wrong|not|incorrect)\b/) ? 0.9 : 0.1);
    default: return quietAnswer(id, q, 0.9);
  }
}

/** Development aid for the REPL. Never used by the regression suite. */
export class HeuristicStubClient implements JevClient {
  async ask(req: JevRequest): Promise<JevResponse> {
    const text = textOf(req.state);
    const answers: AnswerMap = {};
    for (const [id, q] of Object.entries(req.questions)) answers[id] = answerHeuristically(id, q, text);
    return {
      answers,
      model: 'stub-heuristic',
      usage: { inputTokens: estimateTokens(req.state) + estimateTokens(req.questions), outputTokens: 0, estimated: true },
      latencyMs: 0,
      source: 'stub:heuristic',
    };
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run src/jev/heuristicStub.test.ts`
Expected: 5 tests passed.

- [ ] **Step 7: Commit**

```bash
git add src/jev/distributions.ts src/jev/defaults.ts src/jev/heuristicStub.ts src/jev/heuristicStub.test.ts
git commit -m "feat(jev): add distribution helpers, quiet defaults and heuristic stub"
```

---

### Task 23: Corpus format and fixture stub

**Files:**
- Create: `src/jev/corpus.ts`, `src/jev/fixtureStub.ts`, `src/jev/fixtureStub.test.ts`

- [ ] **Step 1: Write the failing test**

`src/jev/fixtureStub.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FixtureStubClient } from './fixtureStub';
import { parseCorpus, normalizeText, type CorpusEntry } from './corpus';
import { HeuristicStubClient } from './heuristicStub';
import { buildQuestions } from '../core/questions';
import { newSession } from '../core/session';
import { buildTurnState } from '../core/state';
import { candidateSpans } from '../core/spans';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { JevClientError } from './types';

const entries: CorpusEntry[] = [
  {
    id: 'r1', text: 'Reschedule with Dr. Chen next week', intent: 'reschedule', context: 'no_form',
    slots: { provider: 'chen', date: { mode: 'window', window: 'next_week' } },
  },
  {
    id: 'm1', text: 'four four seven one eight two nine three', intent: 'none', context: 'billing',
    slots: { memberId: { span: 'four four seven one eight two nine three', value: '44718293' } },
  },
  {
    id: 'lo', text: 'maybe cancel it', intent: 'cancel', context: 'no_form',
    answers: { intent: { probabilities: { cancel: 0.5, reschedule: 0.4 } }, utteranceComplete: { noul: 0.3 } },
  },
];

function request(text: string) {
  const session = newSession('s', 0);
  const state = buildTurnState(session, { text, isFinal: true, dtmf: null }, 0);
  const questions = buildQuestions(session, { text, candidateSpans: candidateSpans(text), todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS } });
  return { state: state as never, questions };
}

describe('parseCorpus', () => {
  it('parses JSONL, skips blank lines and rejects duplicate ids', () => {
    const text = JSON.stringify(entries[0]) + '\n\n' + JSON.stringify(entries[1]) + '\n';
    expect(parseCorpus(text).map((e) => e.id)).toEqual(['r1', 'm1']);
    expect(() => parseCorpus(text + JSON.stringify(entries[0]))).toThrow(/duplicate/);
  });
  it('normalizes text for lookup', () => {
    expect(normalizeText('Reschedule, with Dr. Chen!')).toBe('reschedule with dr chen');
  });
});

describe('FixtureStubClient', () => {
  const client = new FixtureStubClient(entries, { sharpness: 0.9, fallback: new HeuristicStubClient() });

  it('answers from labels with sharp distributions', async () => {
    const res = await client.ask(request('reschedule with dr chen next week'));
    expect(res.source).toBe('stub:fixture');
    expect(res.answers.intent).toMatchObject({ choice: 'reschedule', probabilities: expect.objectContaining({ reschedule: 0.9 }) });
    expect(res.answers.provider).toMatchObject({ choice: 'chen' });
    expect(res.answers.dateMode).toMatchObject({ choice: 'window' });
    expect(res.answers.dateWindow).toMatchObject({ choice: 'next_week' });
    expect(res.answers.dateMonth).toMatchObject({ choice: 'none' });
  });

  it('answers member id questions from the labeled span', async () => {
    const res = await client.ask(request('four four seven one eight two nine three'));
    expect(res.answers.containsMemberId).toMatchObject({ noul: 0.92 });
    expect(res.answers.memberIdSpan).toMatchObject({ choice: 'four four seven one eight two nine three' });
    expect(res.answers.memberIdComplete).toMatchObject({ noul: 0.9 });
  });

  it('applies overrides and keeps distributions normalized', async () => {
    const res = await client.ask(request('maybe cancel it'));
    const intent = res.answers.intent as { probabilities: Record<string, number> };
    expect(intent.probabilities.cancel).toBeCloseTo(0.5, 2);
    expect(intent.probabilities.reschedule).toBeCloseTo(0.4, 2);
    expect(Object.values(intent.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    expect(res.answers.utteranceComplete).toEqual({ type: 'noul', noul: 0.3 });
  });

  it('falls back to the heuristic stub for unknown text', async () => {
    const res = await client.ask(request('something not in the corpus about billing'));
    expect(res.source).toBe('stub:heuristic');
  });

  it('injects failures on demand', async () => {
    const failing = new FixtureStubClient(entries, { sharpness: 0.9, fallback: new HeuristicStubClient(), injectFailure: (n) => n === 1 });
    await expect(failing.ask(request('maybe cancel it'))).rejects.toBeInstanceOf(JevClientError);
    await expect(failing.ask(request('maybe cancel it'))).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/jev/fixtureStub.test.ts`
Expected: FAIL, cannot find module './fixtureStub'.

- [ ] **Step 3: Write corpus.ts**

`src/jev/corpus.ts`:

```ts
import { readFileSync } from 'node:fs';
import { INTENTS, type FormId, type Intent } from '../domain/intents';

export interface DateLabel {
  mode?: string;
  month?: string;
  day?: string;
  weekday?: string;
  weekdayQualifier?: string;
  relativeDay?: string;
  window?: string;
}

export interface CorpusSlots {
  memberId?: { span: string; value: string };
  provider?: string;
  date?: DateLabel;
}

export interface AnswerOverride {
  noul?: number;
  probabilities?: Record<string, number>;
}

export interface CorpusEntry {
  id: string;
  text: string;
  intent: Intent;
  /** the form active when this utterance is spoken; no_form for a first utterance */
  context: 'no_form' | FormId;
  slots?: CorpusSlots;
  /** explicit distributions that replace the generated ones */
  answers?: Record<string, AnswerOverride>;
  tags?: string[];
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseCorpus(jsonl: string): CorpusEntry[] {
  const seen = new Set<string>();
  const out: CorpusEntry[] = [];
  for (const [i, line] of jsonl.split('\n').entries()) {
    if (!line.trim()) continue;
    let entry: CorpusEntry;
    try {
      entry = JSON.parse(line) as CorpusEntry;
    } catch (e) {
      throw new Error(`corpus line ${i + 1}: invalid JSON`);
    }
    if (!entry.id || !entry.text) throw new Error(`corpus line ${i + 1}: id and text are required`);
    if (!(INTENTS as readonly string[]).includes(entry.intent)) throw new Error(`corpus ${entry.id}: unknown intent ${entry.intent}`);
    if (seen.has(entry.id)) throw new Error(`corpus ${entry.id}: duplicate id`);
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

export function loadCorpus(path: string): CorpusEntry[] {
  return parseCorpus(readFileSync(path, 'utf8'));
}
```

- [ ] **Step 4: Write fixtureStub.ts**

`src/jev/fixtureStub.ts`:

```ts
import { choiceAnswer, choiceLabels, noulAnswer, normalize, scoreAnswer, sharp } from './distributions';
import { quietAnswer } from './defaults';
import { normalizeText, type CorpusEntry, type DateLabel } from './corpus';
import {
  JevClientError, estimateTokens,
  type Answer, type AnswerMap, type JevClient, type JevRequest, type JevResponse, type Question,
} from './types';

export interface FixtureStubOptions {
  sharpness: number;
  /** answers utterances not in the corpus */
  fallback: JevClient;
  /** return true to make the nth ask (1-based) reject with a timeout error */
  injectFailure?: (callIndex: number) => boolean;
}

const DATE_IDS: Record<string, keyof DateLabel> = {
  dateMode: 'mode',
  dateMonth: 'month',
  dateDay: 'day',
  dateWeekday: 'weekday',
  dateWeekdayQualifier: 'weekdayQualifier',
  dateRelativeDay: 'relativeDay',
  dateWindow: 'window',
};

function textOf(state: unknown): string {
  const s = state as { asr?: { text?: string } } | null;
  return s?.asr?.text ?? '';
}

function labeledAnswer(id: string, q: Question, entry: CorpusEntry, sharpness: number): Answer {
  const slots = entry.slots ?? {};
  if (q.type === 'choice') {
    const labels = choiceLabels(q);
    const pick = (v: string | undefined) => choiceAnswer(sharp(labels, v && labels.includes(v) ? v : 'none', sharpness));
    if (id === 'intent') return pick(entry.intent);
    if (id === 'provider') return pick(slots.provider);
    if (id === 'memberIdSpan') {
      const span = slots.memberId?.span;
      const exact = span && labels.includes(span) ? span : labels.find((l) => span && l.includes(span));
      return pick(exact);
    }
    if (id in DATE_IDS) return pick(slots.date?.[DATE_IDS[id]!]);
    return quietAnswer(id, q, sharpness);
  }
  if (q.type === 'noul') {
    if (id === 'containsMemberId') return noulAnswer(slots.memberId ? 0.92 : 0.05);
    if (id === 'memberIdComplete') return noulAnswer(slots.memberId ? 0.9 : 0.4);
    if (id === 'wantsHuman') return noulAnswer(entry.intent === 'agent' ? 0.9 : 0.04);
    return quietAnswer(id, q, sharpness);
  }
  return quietAnswer(id, q, sharpness);
}

function applyOverride(answer: Answer, q: Question, override: { noul?: number; probabilities?: Record<string, number> }): Answer {
  if (answer.type === 'noul') return override.noul === undefined ? answer : noulAnswer(override.noul);
  if (!override.probabilities) return answer;
  const labels = answer.type === 'choice' ? choiceLabels(q as Extract<Question, { type: 'choice' }>) : (q as Extract<Question, { type: 'score' }>).levels.map((l) => l.label);
  const given = override.probabilities;
  const givenMass = Object.values(given).reduce((a, b) => a + b, 0);
  const rest = labels.filter((l) => !(l in given));
  const probs: Record<string, number> = {};
  for (const l of labels) probs[l] = l in given ? given[l]! : rest.length ? Math.max(0, 1 - givenMass) / rest.length : 0;
  const normalized = normalize(probs);
  return answer.type === 'choice' ? choiceAnswer(normalized) : scoreAnswer(q as Extract<Question, { type: 'score' }>, normalized);
}

/** Deterministic answers from corpus labels. Unknown utterances go to the fallback. */
export class FixtureStubClient implements JevClient {
  private readonly index = new Map<string, CorpusEntry>();
  private calls = 0;

  constructor(entries: CorpusEntry[], private readonly opts: FixtureStubOptions) {
    for (const e of entries) this.index.set(normalizeText(e.text), e);
  }

  lookup(text: string): CorpusEntry | undefined {
    return this.index.get(normalizeText(text));
  }

  async ask(req: JevRequest): Promise<JevResponse> {
    this.calls += 1;
    if (this.opts.injectFailure?.(this.calls)) throw new JevClientError('injected timeout');
    const entry = this.lookup(textOf(req.state));
    if (!entry) return this.opts.fallback.ask(req);
    const answers: AnswerMap = {};
    for (const [id, q] of Object.entries(req.questions)) {
      let a = labeledAnswer(id, q, entry, this.opts.sharpness);
      const override = entry.answers?.[id];
      if (override) a = applyOverride(a, q, override);
      answers[id] = a;
    }
    return {
      answers,
      model: 'stub-fixture',
      usage: { inputTokens: estimateTokens(req.state) + estimateTokens(req.questions), outputTokens: 0, estimated: true },
      latencyMs: 0,
      source: 'stub:fixture',
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/jev/fixtureStub.test.ts`
Expected: 7 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/jev/corpus.ts src/jev/fixtureStub.ts src/jev/fixtureStub.test.ts
git commit -m "feat(jev): add corpus format and deterministic fixture stub"
```

---

### Task 24: SDK-backed client

**Files:**
- Create: `src/jev/sdkClient.ts`, `src/jev/sdkClient.test.ts`

The SDK is only imported here. The wire shapes come from the TypeSafe docs: request `{ state, questions, model }`; response `{ model, answers: { id: {...} }, usage: { input_tokens, output_tokens } }`; Score `probabilities` keyed by level number (1-based); Noul criteria is an optional `{ true, false }` object.

- [ ] **Step 1: Write the failing test**

`src/jev/sdkClient.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SdkJevClient, toSdkQuestions, fromSdkAnswers, JEV_MODEL } from './sdkClient';
import type { QuestionMap } from './types';

const questions: QuestionMap = {
  intent: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: null } },
  frustration: { type: 'score', instructions: 'How?', levels: [{ label: 'none', description: 'calm' }, { label: 'high', description: 'angry' }] },
  ok: { type: 'noul', instructions: 'Is it?', criteria: { true: 'yes means yes' } },
};

describe('toSdkQuestions', () => {
  it('maps our types to the SDK wire shape', () => {
    expect(toSdkQuestions(questions)).toEqual({
      intent: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: null } },
      frustration: { type: 'score', instructions: 'How?', criteria: ['none: calm', 'high: angry'] },
      ok: { type: 'noul', instructions: 'Is it?', criteria: { true: 'yes means yes' } },
    });
  });
});

describe('fromSdkAnswers', () => {
  it('relabels score probabilities by level and passes choice and noul through', () => {
    const answers = fromSdkAnswers(questions, {
      intent: { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.7 },
      frustration: { type: 'score', score: 1.8, legend: { 1: 'none: calm', 2: 'high: angry' }, probabilities: { 1: 0.2, 2: 0.8 }, confidence: 0.8 },
      ok: { type: 'noul', noul: 0.42 },
    });
    expect(answers.intent).toEqual({ type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.7 });
    expect(answers.frustration).toEqual({ type: 'score', score: 1.8, probabilities: { none: 0.2, high: 0.8 }, confidence: 0.8 });
    expect(answers.ok).toEqual({ type: 'noul', noul: 0.42 });
  });
});

describe('SdkJevClient', () => {
  it('posts to systemone with the pinned model and measures latency', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({
        model: JEV_MODEL,
        answers: { ok: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 120, output_tokens: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new SdkJevClient({ apiKey: 'test-key', timeoutMs: 1000, fetch: fetchImpl as typeof fetch });
    const res = await client.ask({ state: { asr: { text: 'hi' } }, questions: { ok: questions.ok! } });
    expect(captured!.url).toMatch(/\/v1\/systemone$/);
    expect(captured!.body).toMatchObject({ model: JEV_MODEL, state: { asr: { text: 'hi' } } });
    expect(res.answers.ok).toEqual({ type: 'noul', noul: 0.9 });
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 0, estimated: false });
    expect(res.source).toBe('jev');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/jev/sdkClient.test.ts`
Expected: FAIL, cannot find module './sdkClient'.

- [ ] **Step 3: Write sdkClient.ts**

`src/jev/sdkClient.ts`:

```ts
import { TypeSafeClient } from '@typesafe-ai/sdk';
import {
  JevClientError,
  type AnswerMap, type JevClient, type JevRequest, type JevResponse, type Question, type QuestionMap,
} from './types';

/** Pinned: aliases move between releases and thresholds are calibrated per version. */
export const JEV_MODEL = 'jev-1.13.0';

export interface SdkJevClientOptions {
  apiKey?: string;
  timeoutMs: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

type SdkQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } };

export function toSdkQuestions(questions: QuestionMap): Record<string, SdkQuestion> {
  const out: Record<string, SdkQuestion> = {};
  for (const [id, q] of Object.entries(questions)) {
    switch (q.type) {
      case 'choice':
        out[id] = { type: 'choice', instructions: q.instructions, criteria: q.criteria };
        break;
      case 'score':
        out[id] = { type: 'score', instructions: q.instructions, criteria: q.levels.map((l) => `${l.label}: ${l.description}`) };
        break;
      case 'noul':
        out[id] = q.criteria ? { type: 'noul', instructions: q.instructions, criteria: q.criteria } : { type: 'noul', instructions: q.instructions };
        break;
    }
  }
  return out;
}

interface RawAnswer {
  type: string;
  choice?: string;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export function fromSdkAnswers(questions: QuestionMap, raw: Record<string, RawAnswer>): AnswerMap {
  const out: AnswerMap = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = raw[id];
    if (!a) throw new JevClientError(`missing answer for ${id}`);
    out[id] = convert(q, a, id);
  }
  return out;
}

function convert(q: Question, a: RawAnswer, id: string): AnswerMap[string] {
  switch (q.type) {
    case 'choice':
      if (a.type !== 'choice' || a.choice === undefined || !a.probabilities) throw new JevClientError(`bad choice answer for ${id}`);
      return { type: 'choice', choice: a.choice, probabilities: a.probabilities, confidence: a.confidence ?? 0 };
    case 'score': {
      if (a.type !== 'score' || a.score === undefined || !a.probabilities) throw new JevClientError(`bad score answer for ${id}`);
      const probabilities: Record<string, number> = {};
      q.levels.forEach((level, i) => {
        probabilities[level.label] = a.probabilities![String(i + 1)] ?? a.probabilities![i + 1] ?? 0;
      });
      return { type: 'score', score: a.score, probabilities, confidence: a.confidence ?? 0 };
    }
    case 'noul':
      if (a.type !== 'noul' || a.noul === undefined) throw new JevClientError(`bad noul answer for ${id}`);
      return { type: 'noul', noul: a.noul };
  }
}

export class SdkJevClient implements JevClient {
  private readonly client: TypeSafeClient;

  constructor(private readonly opts: SdkJevClientOptions) {
    this.client = new TypeSafeClient({
      apiKey: opts.apiKey,
      defaultModel: JEV_MODEL,
      timeout: opts.timeoutMs,
      retry: { maxRetries: opts.maxRetries ?? 1 },
      fetch: opts.fetch,
    });
  }

  async ask(req: JevRequest): Promise<JevResponse> {
    const started = performance.now();
    try {
      const result = await this.client.systemOne(
        { state: req.state as never, questions: toSdkQuestions(req.questions) as never, model: JEV_MODEL },
        { signal: req.signal, timeout: req.timeoutMs ?? this.opts.timeoutMs },
      );
      const raw = result as unknown as { model: string; answers: Record<string, RawAnswer>; usage: { input_tokens: number; output_tokens: number } };
      return {
        answers: fromSdkAnswers(req.questions, raw.answers),
        model: raw.model,
        usage: { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens, estimated: false },
        latencyMs: performance.now() - started,
        source: 'jev',
      };
    } catch (e) {
      if (e instanceof JevClientError) throw e;
      throw new JevClientError(e instanceof Error ? e.message : String(e), e);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/jev/sdkClient.test.ts`
Expected: 3 tests passed. If the SDK rejects the fake `Response` or the criteria shape, read `node_modules/@typesafe-ai/sdk/dist/index.d.ts` for the installed version's exact types and adjust `toSdkQuestions` and the fake response, keeping the test's assertions on our own types unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/jev/sdkClient.ts src/jev/sdkClient.test.ts
git commit -m "feat(jev): add SDK-backed client with type mapping and pinned model"
```

---

### Task 25: Runner, scenario format and metrics

**Files:**
- Create: `src/harness-text/runner.ts`, `src/harness-text/metrics.ts`, `src/harness-text/runner.test.ts`

- [ ] **Step 1: Write the failing test**

`src/harness-text/runner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runTurn, runCorpusEntry, runScenario, type Scenario } from './runner';
import { summarize } from './metrics';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { CorpusEntry } from '../jev/corpus';
import { newSession } from '../core/session';
import { setupFrame } from '../channel/frames';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

const entries: CorpusEntry[] = [
  { id: 'c1', text: 'cancel my appointment with dr patel', intent: 'cancel', context: 'no_form', slots: { provider: 'patel' } },
  { id: 'm1', text: 'four four seven one eight two nine three', intent: 'none', context: 'cancel',
    slots: { memberId: { span: 'four four seven one eight two nine three', value: '44718293' } } },
];

const opts = {
  client: new FixtureStubClient(entries, { sharpness: 0.9, fallback: new HeuristicStubClient() }),
  thresholds: { ...DEFAULT_THRESHOLDS },
  todayIso: '2026-09-18',
  now: () => 1_000,
};

describe('runTurn', () => {
  it('runs setup without asking the client and returns a trace record', async () => {
    const run = await runTurn(newSession('s', 0), setupFrame('s'), opts);
    expect(run.response).toBeNull();
    expect(run.record.source).toBe('none');
    expect(run.record.decision.kind).toBe('prompt');
  });
});

describe('runCorpusEntry', () => {
  it('runs a first-utterance entry from the greeting', async () => {
    const { outcome } = await runCorpusEntry(entries[0]!, opts);
    expect(outcome).toMatchObject({ id: 'c1', decision: 'prompt', promptId: 'ask_memberId', form: 'cancel', decidedGate: 'intent' });
    expect(outcome.slots.provider).toBe('patel');
  });

  it('runs an in-form entry with the form active and the first slot prompted', async () => {
    const { outcome } = await runCorpusEntry(entries[1]!, opts);
    expect(outcome).toMatchObject({ decision: 'prompt', promptId: 'ask_provider', form: 'cancel' });
    expect(outcome.slots.memberId).toBe('44718293');
  });
});

describe('runScenario', () => {
  const scenario: Scenario = {
    id: 'cancel-happy',
    steps: [
      { say: 'cancel my appointment with dr patel' },
      { say: 'four four seven one eight two nine three' },
    ],
    expect: { decision: 'complete', promptId: 'cancel_confirmed', form: 'cancel', slots: { memberId: '44718293', provider: 'patel' } },
  };

  it('runs steps and checks the expectation', async () => {
    const r = await runScenario(scenario, opts);
    expect(r.pass).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.runs).toHaveLength(3);
  });

  it('injects a failure on a step marked fail', async () => {
    const r = await runScenario({
      id: 'fail-once',
      steps: [{ say: 'cancel my appointment with dr patel', fail: true }],
      expect: { decision: 'prompt', promptId: 'system_slow_dtmf_hint' },
    }, opts);
    expect(r.pass).toBe(true);
  });

  it('reports mismatches', async () => {
    const r = await runScenario({ ...scenario, expect: { decision: 'handoff' } }, opts);
    expect(r.pass).toBe(false);
    expect(r.mismatches[0]).toMatch(/decision/);
  });
});

describe('summarize', () => {
  it('computes completion turns against the baseline and slots per utterance', async () => {
    const r = await runScenario({
      id: 'cancel-happy',
      steps: [{ say: 'cancel my appointment with dr patel' }, { say: 'four four seven one eight two nine three' }],
      expect: { decision: 'complete' },
    }, opts);
    const m = summarize(r.runs.map((x) => x.record));
    expect(m.completions).toEqual([{ sessionId: 'cancel-happy', form: 'cancel', turns: 2, baseline: 5 }]);
    expect(m.slotsFilledPerUtterance).toBeCloseTo(1, 5);
    expect(m.bySource['stub:fixture']).toBe(2);
    // turn 1 routed at the intent gate; turn 2 proceeded to slot filling with no gate deciding
    expect(m.byDecidingGate).toEqual({ intent: 1, none: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/harness-text/runner.test.ts`
Expected: FAIL, cannot find module './runner'.

- [ ] **Step 3: Write runner.ts**

`src/harness-text/runner.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { InboundFrame } from '../channel/frames';
import { promptFrame, setupFrame, dtmfFrames } from '../channel/frames';
import { plan, resolve, type TurnContext, type TurnError, type TurnResult } from '../core/turn';
import { missingSlots, newSession, setForm, type Session } from '../core/session';
import type { Thresholds } from '../core/thresholds';
import type { CorpusEntry } from '../jev/corpus';
import { JevClientError, type JevClient, type JevResponse, type JsonValue, type QuestionMap } from '../jev/types';
import { buildTraceRecord, type TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { promptText } from '../prompts/render';
import type { SlotId } from '../domain/forms';

export interface RunOptions {
  client: JevClient;
  thresholds: Thresholds;
  todayIso: string;
  trace?: TraceWriter | null;
  now?: () => number;
}

export interface TurnRun {
  result: TurnResult;
  questions: QuestionMap | null;
  response: JevResponse | null;
  error: TurnError | null;
  record: TraceRecord;
}

export async function runTurn(session: Session, event: InboundFrame, opts: RunOptions): Promise<TurnRun> {
  const now = opts.now ?? (() => Date.now());
  const tc: TurnContext = { nowMs: now(), todayIso: opts.todayIso, thresholds: opts.thresholds };
  const t0 = performance.now();
  const p = plan(session, event, tc);
  const t1 = performance.now();
  let response: JevResponse | null = null;
  let error: TurnError | null = null;
  if (p.needsModel) {
    try {
      response = await opts.client.ask({
        state: p.turnState as unknown as JsonValue,
        questions: p.questions!,
        timeoutMs: opts.thresholds.JEV_TIMEOUT_MS,
      });
    } catch (e) {
      error = e instanceof Error ? { name: e.name, message: e.message } : { name: 'Error', message: String(e) };
    }
  }
  const t2 = performance.now();
  const result = resolve(session, event, response?.answers ?? null, tc, error);
  const t3 = performance.now();
  const record = buildTraceRecord({
    result, event, questions: p.questions, response, error,
    timing: { planMs: t1 - t0, askMs: t2 - t1, resolveMs: t3 - t2, totalMs: t3 - t0 },
    ts: new Date(now()).toISOString(),
    pricePerMtok: opts.thresholds.JEV_PRICE_PER_MTOK,
  });
  opts.trace?.write(record);
  return { result, questions: p.questions, response, error, record };
}

export interface Outcome {
  id: string;
  decision: string;
  promptId: string | null;
  reason: string | null;
  decidedGate: string | null;
  verdict: string | null;
  form: string | null;
  slots: Record<SlotId, string | null>;
}

export function outcomeOf(id: string, result: TurnResult): Outcome {
  const d = result.decision;
  return {
    id,
    decision: d.kind,
    promptId: 'promptId' in d ? d.promptId : null,
    reason: d.kind === 'handoff' ? d.reason : null,
    decidedGate: result.rows.find((r) => r.decided)?.gate ?? null,
    verdict: result.verdict?.kind ?? null,
    form: result.session.form,
    slots: {
      memberId: result.session.slots.memberId.value,
      provider: result.session.slots.provider.value,
      date: result.session.slots.date.value,
    },
  };
}

async function startSession(id: string, opts: RunOptions): Promise<Session> {
  const run = await runTurn(newSession(id, (opts.now ?? Date.now)()), setupFrame(id), opts);
  return run.result.session;
}

export async function runCorpusEntry(entry: CorpusEntry, opts: RunOptions): Promise<{ outcome: Outcome; run: TurnRun }> {
  const session = await startSession(entry.id, opts);
  if (entry.context !== 'no_form') {
    setForm(session, entry.context);
    const [slot] = missingSlots(session);
    session.promptedFor = slot ?? null;
    session.lastPromptId = slot ? `ask_${slot}` : null;
    session.lastPromptText = slot ? promptText(`ask_${slot}`, {}) : '';
  }
  const run = await runTurn(session, promptFrame(entry.text), opts);
  return { outcome: outcomeOf(entry.id, run.result), run };
}

export type ScenarioStep = { say: string; fail?: boolean } | { dtmf: string };

export interface ScenarioExpectation {
  decision: string;
  promptId?: string;
  reason?: string;
  form?: string | null;
  slots?: Partial<Record<SlotId, string>>;
}

export interface Scenario {
  id: string;
  steps: ScenarioStep[];
  expect: ScenarioExpectation;
}

export interface ScenarioRun {
  outcome: Outcome;
  runs: TurnRun[];
  pass: boolean;
  mismatches: string[];
}

export async function runScenario(scenario: Scenario, opts: RunOptions): Promise<ScenarioRun> {
  let failNext = false;
  const client: JevClient = {
    ask: (req) => (failNext ? Promise.reject(new JevClientError('injected timeout')) : opts.client.ask(req)),
  };
  const o = { ...opts, client };
  const runs: TurnRun[] = [];
  let session = newSession(scenario.id, (opts.now ?? Date.now)());
  const setup = await runTurn(session, setupFrame(scenario.id), o);
  runs.push(setup);
  session = setup.result.session;
  let last = setup;
  for (const step of scenario.steps) {
    const events = 'dtmf' in step ? dtmfFrames(step.dtmf) : [promptFrame(step.say)];
    failNext = 'say' in step && step.fail === true;
    for (const event of events) {
      last = await runTurn(session, event, o);
      runs.push(last);
      session = last.result.session;
    }
    failNext = false;
  }
  const outcome = outcomeOf(scenario.id, last.result);
  const mismatches = checkExpectation(outcome, scenario.expect);
  return { outcome, runs, pass: mismatches.length === 0, mismatches };
}

export function checkExpectation(outcome: Outcome, expected: ScenarioExpectation): string[] {
  const out: string[] = [];
  if (outcome.decision !== expected.decision) out.push(`decision: expected ${expected.decision}, got ${outcome.decision}`);
  if (expected.promptId !== undefined && outcome.promptId !== expected.promptId) out.push(`promptId: expected ${expected.promptId}, got ${outcome.promptId}`);
  if (expected.reason !== undefined && outcome.reason !== expected.reason) out.push(`reason: expected ${expected.reason}, got ${outcome.reason}`);
  if (expected.form !== undefined && outcome.form !== expected.form) out.push(`form: expected ${expected.form}, got ${outcome.form}`);
  for (const [slot, value] of Object.entries(expected.slots ?? {})) {
    if (outcome.slots[slot as SlotId] !== value) out.push(`slot ${slot}: expected ${value}, got ${outcome.slots[slot as SlotId]}`);
  }
  return out;
}

export function loadScenarios(dir: string): Scenario[] {
  const seen = new Set<string>();
  const out: Scenario[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const list = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Scenario[];
    for (const s of list) {
      if (seen.has(s.id)) throw new Error(`scenario ${s.id}: duplicate id`);
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}
```

- [ ] **Step 4: Write metrics.ts**

`src/harness-text/metrics.ts`:

```ts
import type { TraceRecord } from '../trace/types';
import baseline from '../domain/dtmf-baseline.json';

export interface Completion {
  sessionId: string;
  form: string;
  turns: number;
  baseline: number;
}

export interface Metrics {
  sessions: number;
  turns: number;
  promptTurns: number;
  slotsFilledPerUtterance: number;
  completions: Completion[];
  latency: { p50: number; p95: number };
  costUsd: number;
  costPerSessionUsd: number;
  byDecidingGate: Record<string, number>;
  bySource: Record<string, number>;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function filledCount(slots: TraceRecord['slots']): number {
  return Object.values(slots).filter((s) => s.value !== null).length;
}

export function summarize(records: TraceRecord[]): Metrics {
  const bySession = new Map<string, TraceRecord[]>();
  for (const r of records) {
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }

  let promptTurns = 0;
  let slotsFilled = 0;
  const completions: Completion[] = [];
  const latencies: number[] = [];
  const byDecidingGate: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let costUsd = 0;

  for (const [sessionId, list] of bySession) {
    let prevFilled = 0;
    let callerTurns = 0;
    let inDtmfRun = false;
    let form: string | null = null;
    for (const r of list) {
      costUsd += r.usage.costUsd;
      bySource[r.source] = (bySource[r.source] ?? 0) + 1;
      if (r.event.type === 'prompt') {
        promptTurns += 1;
        callerTurns += 1;
        inDtmfRun = false;
        const now = filledCount(r.slots);
        slotsFilled += Math.max(0, now - prevFilled);
        prevFilled = now;
        if (r.source !== 'error' && r.source !== 'none') latencies.push(r.timing.askMs);
        const gate = r.gates.find((g) => g.decided)?.gate ?? 'none';
        byDecidingGate[gate] = (byDecidingGate[gate] ?? 0) + 1;
      } else if (r.event.type === 'dtmf') {
        if (!inDtmfRun) callerTurns += 1;
        inDtmfRun = true;
        prevFilled = filledCount(r.slots);
      }
      if (r.decision.kind === 'complete') form = r.decision.form;
    }
    if (form) {
      completions.push({ sessionId, form, turns: callerTurns, baseline: (baseline as Record<string, number>)[form] ?? 0 });
    }
  }

  return {
    sessions: bySession.size,
    turns: records.length,
    promptTurns,
    slotsFilledPerUtterance: promptTurns ? slotsFilled / promptTurns : 0,
    completions,
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    costUsd,
    costPerSessionUsd: bySession.size ? costUsd / bySession.size : 0,
    byDecidingGate,
    bySource,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/harness-text/runner.test.ts`
Expected: 7 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/harness-text/runner.ts src/harness-text/metrics.ts src/harness-text/runner.test.ts
git commit -m "feat(harness): add turn runner, scenario format and run metrics"
```

---

### Task 26: Printing and the CLI

**Files:**
- Create: `src/harness-text/print.ts`, `src/harness-text/print.test.ts`, `src/harness-text/cli.ts`

- [ ] **Step 1: Write the failing test**

`src/harness-text/print.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatAnswers, formatGates, formatDecision } from './print';
import { choice, noul, score } from '../testing/answers';
import type { QuestionMap } from '../jev/types';

describe('print', () => {
  it('formats top choices, all score levels and noul values', () => {
    const q: QuestionMap = {
      intent: { type: 'choice', instructions: '', criteria: { a: null, b: null, c: null, d: null } },
      frustration: { type: 'score', instructions: '', levels: [{ label: 'none', description: '' }, { label: 'high', description: '' }] },
      ok: { type: 'noul', instructions: '' },
    };
    const text = formatAnswers(q, {
      intent: choice({ a: 0.5, b: 0.3, c: 0.15, d: 0.05 }),
      frustration: score({ none: 0.9, high: 0.1 }),
      ok: noul(0.42),
    });
    expect(text).toContain('intent');
    expect(text).toContain('a 0.50');
    expect(text).not.toContain('d 0.05');
    expect(text).toContain('none 0.90');
    expect(text).toContain('ok');
    expect(text).toContain('0.42');
  });

  it('formats gate rows with a marker on the deciding gate', () => {
    const text = formatGates([
      { gate: 'addressedToSystem', value: 0.9, threshold: 0.7, passed: true, outcome: 'pass', decided: false },
      { gate: 'intent', value: 0.3, threshold: 0.4, passed: false, outcome: 'failed:none', decided: true },
    ]);
    expect(text).toContain('addressedToSystem');
    expect(text).toMatch(/intent.*0\.30.*0\.40.*FAIL.*failed:none.*<==/);
  });

  it('formats a decision with its spoken text', () => {
    const text = formatDecision(
      { kind: 'prompt', promptId: 'ask_memberId', vars: {}, acks: [], target: 'memberId', options: [] },
      [{ type: 'text', token: "What's your member ID?", last: true, lang: 'en-US', interruptible: true, preemptible: false }],
    );
    expect(text).toContain('prompt ask_memberId');
    expect(text).toContain("What's your member ID?");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/harness-text/print.test.ts`
Expected: FAIL, cannot find module './print'.

- [ ] **Step 3: Write print.ts**

`src/harness-text/print.ts`:

```ts
import type { AnswerMap, QuestionMap } from '../jev/types';
import { rankProbabilities } from '../jev/types';
import type { GateRow } from '../core/gates';
import type { Decision } from '../core/decision';
import type { OutboundFrame } from '../channel/frames';
import type { Metrics } from './metrics';

const f2 = (n: number): string => n.toFixed(2);

export function formatAnswers(questions: QuestionMap, answers: AnswerMap): string {
  const lines: string[] = [];
  const width = Math.max(...Object.keys(questions).map((k) => k.length));
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (!a) continue;
    let cell: string;
    if (a.type === 'noul') cell = f2(a.noul);
    else if (a.type === 'score') cell = q.type === 'score' ? q.levels.map((l) => `${l.label} ${f2(a.probabilities[l.label] ?? 0)}`).join('  ') : '';
    else cell = rankProbabilities(a.probabilities).slice(0, 3).map((r) => `${r.label} ${f2(r.p)}`).join('  ');
    lines.push(`${id.padEnd(width)}  ${cell}`);
  }
  return lines.join('\n');
}

export function formatGates(rows: GateRow[]): string {
  const width = Math.max(...rows.map((r) => r.gate.length), 4);
  const lines = [`${'gate'.padEnd(width)}  value  thresh  result  outcome`];
  for (const r of rows) {
    const value = r.value === null ? '  -  ' : f2(r.value).padStart(5);
    const thresh = r.threshold === null ? '   -  ' : f2(r.threshold).padStart(6);
    const result = r.threshold === null ? 'info' : r.passed ? 'pass' : 'FAIL';
    lines.push(`${r.gate.padEnd(width)}  ${value}  ${thresh}  ${result.padEnd(6)}  ${r.outcome}${r.decided ? '  <==' : ''}`);
  }
  return lines.join('\n');
}

export function formatDecision(decision: Decision, frames: OutboundFrame[]): string {
  const head = 'promptId' in decision ? `${decision.kind} ${decision.promptId}` : decision.kind;
  const extra = decision.kind === 'handoff' ? ` (${decision.reason})` : decision.kind === 'prompt' && decision.target ? ` -> ${decision.target}` : '';
  const spoken = frames.map((fr) => (fr.type === 'text' ? `  > ${fr.token}` : `  [${fr.type}]${fr.type === 'end' ? ' ' + fr.handoffData : ''}`));
  return [`decision: ${head}${extra}`, ...spoken].join('\n');
}

export function formatMetrics(m: Metrics): string {
  const lines = [
    `sessions ${m.sessions}   turns ${m.turns}   prompt turns ${m.promptTurns}`,
    `slots filled per utterance  ${m.slotsFilledPerUtterance.toFixed(2)}`,
    `decision latency ms  p50 ${m.latency.p50.toFixed(1)}  p95 ${m.latency.p95.toFixed(1)}`,
    `cost usd  total ${m.costUsd.toFixed(6)}  per session ${m.costPerSessionUsd.toFixed(6)}`,
  ];
  if (m.completions.length) {
    lines.push('turns to completion vs dtmf baseline');
    for (const c of m.completions) lines.push(`  ${c.form.padEnd(20)} ${String(c.turns).padStart(2)} / ${c.baseline}   (${c.sessionId})`);
  }
  lines.push('decisions by deciding gate  ' + Object.entries(m.byDecidingGate).map(([g, n]) => `${g}=${n}`).join('  '));
  lines.push('answers by source           ' + Object.entries(m.bySource).map(([s, n]) => `${s}=${n}`).join('  '));
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/harness-text/print.test.ts`
Expected: 3 tests passed.

- [ ] **Step 5: Write cli.ts**

`src/harness-text/cli.ts`:

```ts
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { dtmfFrames, promptFrame, setupFrame } from '../channel/frames';
import { newSession, type Session } from '../core/session';
import { parseOverride, withOverrides, type Thresholds } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { SdkJevClient } from '../jev/sdkClient';
import type { JevClient } from '../jev/types';
import { TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { loadScenarios, runCorpusEntry, runScenario, runTurn, type RunOptions, type TurnRun } from './runner';
import { summarize } from './metrics';
import { formatAnswers, formatDecision, formatGates, formatMetrics } from './print';

const { values: args } = parseArgs({
  options: {
    corpus: { type: 'string' },
    scenarios: { type: 'string' },
    client: { type: 'string', default: 'stub' },
    trace: { type: 'string' },
    threshold: { type: 'string', multiple: true, default: [] },
    today: { type: 'string', default: new Date().toISOString().slice(0, 10) },
    quiet: { type: 'boolean', default: false },
    'corpus-file': { type: 'string', default: 'fixtures/corpus.jsonl' },
  },
});

export function buildThresholds(overrides: string[]): Thresholds {
  return withOverrides(Object.assign({}, ...overrides.map(parseOverride)));
}

export function buildClient(kind: string, corpusFile: string, thresholds: Thresholds): JevClient {
  if (kind === 'jev') return new SdkJevClient({ timeoutMs: thresholds.JEV_TIMEOUT_MS });
  if (kind === 'heuristic') return new HeuristicStubClient();
  return new FixtureStubClient(loadCorpus(corpusFile), { sharpness: thresholds.STUB_SHARPNESS, fallback: new HeuristicStubClient() });
}

function printRun(run: TurnRun, quiet: boolean): void {
  if (quiet) return;
  const { result, questions, response } = run;
  if (questions && response) {
    console.log(formatAnswers(questions, response.answers));
    console.log('');
  }
  if (result.rows.length) {
    console.log(formatGates(result.rows));
    console.log('');
  }
  if (run.error) console.log(`client error: ${run.error.name}: ${run.error.message}`);
  console.log(formatDecision(result.decision, result.frames));
  console.log(`timing ms  ask ${run.record.timing.askMs.toFixed(1)}  total ${run.record.timing.totalMs.toFixed(1)}   source ${run.record.source}`);
  console.log('');
}

async function repl(opts: RunOptions, quiet: boolean): Promise<TraceRecord[]> {
  const records: TraceRecord[] = [];
  let session: Session = newSession(`repl-${Date.now()}`, Date.now());
  const start = async () => {
    const run = await runTurn(session, setupFrame(session.sessionId), opts);
    session = run.result.session;
    records.push(run.record);
    printRun(run, quiet);
  };
  await start();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'caller> ' });
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text === '/reset') {
      session = newSession(`repl-${Date.now()}`, Date.now());
      await start();
    } else if (text.startsWith('dtmf:')) {
      for (const event of dtmfFrames(text.slice(5))) {
        const run = await runTurn(session, event, opts);
        session = run.result.session;
        records.push(run.record);
        if (run.result.decision.kind !== 'ignore') printRun(run, quiet);
      }
    } else if (text) {
      const run = await runTurn(session, promptFrame(text), opts);
      session = run.result.session;
      records.push(run.record);
      printRun(run, quiet);
    }
    if (session.ended) console.log('(call ended; /reset to start another)');
    rl.prompt();
  }
  return records;
}

async function main(): Promise<void> {
  const thresholds = buildThresholds(args.threshold ?? []);
  const client = buildClient(args.client!, args['corpus-file']!, thresholds);
  const trace = args.trace ? new TraceWriter(args.trace) : null;
  const opts: RunOptions = { client, thresholds, todayIso: args.today!, trace };
  const records: TraceRecord[] = [];

  if (args.corpus) {
    for (const entry of loadCorpus(args.corpus)) {
      const { run, outcome } = await runCorpusEntry(entry, opts);
      records.push(run.record);
      if (!args.quiet) {
        console.log(`=== ${entry.id}  "${entry.text}"  [${entry.context}]`);
        printRun(run, false);
      } else {
        console.log(`${entry.id.padEnd(16)} ${outcome.decision.padEnd(9)} ${outcome.promptId ?? outcome.reason ?? ''}`);
      }
    }
  }

  if (args.scenarios) {
    let failed = 0;
    for (const scenario of loadScenarios(args.scenarios)) {
      const r = await runScenario(scenario, opts);
      for (const run of r.runs) records.push(run.record);
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${scenario.id}`);
      for (const m of r.mismatches) console.log(`      ${m}`);
      if (!r.pass) failed += 1;
      if (!args.quiet && !r.pass) for (const run of r.runs) printRun(run, false);
    }
    if (failed) process.exitCode = 1;
  }

  if (!args.corpus && !args.scenarios) {
    records.push(...(await repl(opts, args.quiet!)));
  }

  if (records.length) {
    console.log('');
    console.log(formatMetrics(summarize(records)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 6: Smoke the CLI**

Run: `printf 'reschedule with dr chen next week\nfour four seven one eight two nine three\n' | pnpm cli --client heuristic --today 2026-09-18`
Expected: the greeting, then for each line a probability table, a gate table, and a decision. The second decision is `prompt date_narrow_window -> date`. A metrics block prints at the end. (The fixture corpus file does not exist yet; `--client heuristic` avoids loading it.)

- [ ] **Step 7: Commit**

```bash
git add src/harness-text/print.ts src/harness-text/print.test.ts src/harness-text/cli.ts
git commit -m "feat(harness): add table printing and the text harness CLI"
```

---

### Task 27: The labeled corpus

**Files:**
- Create: `fixtures/corpus.jsonl`, `src/jev/corpus.test.ts`

Rules for every entry, enforced by the test:

- `id` unique; `intent` in the intent set; `context` is `no_form` or a form id.
- A `memberId` label's `span` must be a contiguous run of tokens in the normalized text and must normalize to the labeled `value`.
- Date labels use the criteria vocabularies from `src/core/extract/date.ts`.
- `answers` overrides are only for questions that exist in the schema.

- [ ] **Step 1: Write the corpus validation test**

`src/jev/corpus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadCorpus, normalizeText } from './corpus';
import { candidateSpans } from '../core/spans';
import { spokenToDigits } from '../core/extract/spokenNumber';
import { DATE_MODES, MONTHS, WEEKDAYS, QUALIFIERS, RELATIVE_DAYS, WINDOWS } from '../core/extract/date';
import { PROVIDERS } from '../domain/slots/provider';
import { FORM_INTENTS } from '../domain/intents';

const corpus = loadCorpus('fixtures/corpus.jsonl');

describe('fixtures/corpus.jsonl', () => {
  it('has at least 100 entries', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(100);
  });

  it('uses valid contexts', () => {
    for (const e of corpus) expect(['no_form', ...FORM_INTENTS], e.id).toContain(e.context);
  });

  it('labels member id spans that exist as candidate spans and normalize to the value', () => {
    for (const e of corpus) {
      const m = e.slots?.memberId;
      if (!m) continue;
      expect(candidateSpans(e.text), e.id).toContain(normalizeText(m.span));
      expect(spokenToDigits(m.span), e.id).toBe(m.value);
    }
  });

  it('labels providers from the roster', () => {
    const keys = PROVIDERS.map((p) => p.key);
    for (const e of corpus) if (e.slots?.provider) expect(keys, e.id).toContain(e.slots.provider);
  });

  it('labels dates with criteria vocabulary', () => {
    const days = Array.from({ length: 31 }, (_, i) => String(i + 1));
    for (const e of corpus) {
      const d = e.slots?.date;
      if (!d) continue;
      if (d.mode) expect(DATE_MODES, e.id).toContain(d.mode);
      if (d.month) expect(MONTHS, e.id).toContain(d.month);
      if (d.day) expect(days, e.id).toContain(d.day);
      if (d.weekday) expect(WEEKDAYS, e.id).toContain(d.weekday);
      if (d.weekdayQualifier) expect(QUALIFIERS, e.id).toContain(d.weekdayQualifier);
      if (d.relativeDay) expect(RELATIVE_DAYS, e.id).toContain(d.relativeDay);
      if (d.window) expect(WINDOWS, e.id).toContain(d.window);
    }
  });

  it('covers every intent and every slot kind', () => {
    const intents = new Set(corpus.map((e) => e.intent));
    for (const i of ['schedule_new', 'reschedule', 'cancel', 'confirm_appointment', 'billing', 'agent', 'repeat_prompt', 'other', 'none']) expect(intents).toContain(i);
    expect(corpus.some((e) => e.slots?.memberId)).toBe(true);
    expect(corpus.some((e) => e.slots?.provider)).toBe(true);
    expect(corpus.some((e) => e.slots?.date?.mode === 'absolute')).toBe(true);
    expect(corpus.some((e) => e.slots?.date?.mode === 'window')).toBe(true);
    expect(corpus.filter((e) => e.answers).length).toBeGreaterThanOrEqual(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/jev/corpus.test.ts`
Expected: FAIL, ENOENT fixtures/corpus.jsonl.

- [ ] **Step 3: Write the corpus**

`fixtures/corpus.jsonl` (one JSON object per line; blank lines between groups are allowed):

```jsonl
{"id":"sn-01","text":"I'd like to make an appointment","intent":"schedule_new","context":"no_form"}
{"id":"sn-02","text":"I need to book an appointment with Dr. Patel","intent":"schedule_new","context":"no_form","slots":{"provider":"patel"}}
{"id":"sn-03","text":"Can I schedule a visit with Dr. Nguyen next week","intent":"schedule_new","context":"no_form","slots":{"provider":"nguyen","date":{"mode":"window","window":"next_week"}},"tags":["over_answer","window"]}
{"id":"sn-04","text":"I want to set up a new appointment for tomorrow","intent":"schedule_new","context":"no_form","slots":{"date":{"mode":"relative_day","relativeDay":"tomorrow"}}}
{"id":"sn-05","text":"Book me with Dr. Kim on October 5th","intent":"schedule_new","context":"no_form","slots":{"provider":"kim","date":{"mode":"absolute","month":"october","day":"5"}},"tags":["over_answer"]}
{"id":"sn-06","text":"New appointment please, my member ID is four four seven one eight two nine three","intent":"schedule_new","context":"no_form","slots":{"memberId":{"span":"four four seven one eight two nine three","value":"44718293"}},"tags":["over_answer"]}
{"id":"sn-07","text":"I'd like to see Dr. Alvarez sometime this month","intent":"schedule_new","context":"no_form","slots":{"provider":"alvarez","date":{"mode":"window","window":"this_month"}}}
{"id":"sn-08","text":"Schedule an appointment for next Tuesday with Dr. Rossi","intent":"schedule_new","context":"no_form","slots":{"provider":"rossi","date":{"mode":"weekday","weekday":"tuesday","weekdayQualifier":"next"}}}
{"id":"sn-09","text":"I need to get in to see somebody about my knee","intent":"schedule_new","context":"no_form"}
{"id":"sn-10","text":"Make an appointment with Dr. Okafor, member ID 4471 8293, Friday","intent":"schedule_new","context":"no_form","slots":{"provider":"okafor","memberId":{"span":"4471 8293","value":"44718293"},"date":{"mode":"weekday","weekday":"friday"}},"tags":["over_answer","all_slots"]}

{"id":"rs-01","text":"I need to reschedule my appointment","intent":"reschedule","context":"no_form"}
{"id":"rs-02","text":"I need to reschedule my appointment, it's with Dr. Chen sometime next week","intent":"reschedule","context":"no_form","slots":{"provider":"chen","date":{"mode":"window","window":"next_week"}},"tags":["over_answer","window","handoff_example"]}
{"id":"rs-03","text":"Can I move my appointment with Dr. Patel to Thursday","intent":"reschedule","context":"no_form","slots":{"provider":"patel","date":{"mode":"weekday","weekday":"thursday"}}}
{"id":"rs-04","text":"I have to change my appointment to a different day","intent":"reschedule","context":"no_form"}
{"id":"rs-05","text":"Reschedule to tomorrow please","intent":"reschedule","context":"no_form","slots":{"date":{"mode":"relative_day","relativeDay":"tomorrow"}}}
{"id":"rs-06","text":"Push my visit with Dr. Kim to next month","intent":"reschedule","context":"no_form","slots":{"provider":"kim","date":{"mode":"window","window":"next_month"}}}
{"id":"rs-07","text":"I'd like to move my appointment to November 12","intent":"reschedule","context":"no_form","slots":{"date":{"mode":"absolute","month":"november","day":"12"}}}
{"id":"rs-08","text":"Reschedule my appointment with Dr. Cheng","intent":"reschedule","context":"no_form","slots":{"provider":"cheng"}}
{"id":"rs-09","text":"Hi, my member ID is four four seven one eight two nine three and I need to reschedule","intent":"reschedule","context":"no_form","slots":{"memberId":{"span":"four four seven one eight two nine three","value":"44718293"}},"tags":["over_answer"]}
{"id":"rs-10","text":"Move my Dr. Nguyen appointment to this Friday","intent":"reschedule","context":"no_form","slots":{"provider":"nguyen","date":{"mode":"weekday","weekday":"friday","weekdayQualifier":"this"}}}
{"id":"rs-11","text":"Can we do the day after tomorrow instead for my appointment with Dr. Rossi","intent":"reschedule","context":"no_form","slots":{"provider":"rossi","date":{"mode":"relative_day","relativeDay":"day_after_tomorrow"}}}
{"id":"rs-12","text":"I need a different date for my appointment, something in December","intent":"reschedule","context":"no_form","slots":{"date":{"mode":"absolute","month":"december"}},"tags":["month_window"]}

{"id":"cn-01","text":"Cancel my appointment","intent":"cancel","context":"no_form"}
{"id":"cn-02","text":"I need to cancel my appointment with Dr. Okafor","intent":"cancel","context":"no_form","slots":{"provider":"okafor"}}
{"id":"cn-03","text":"Please cancel, I can't make it","intent":"cancel","context":"no_form"}
{"id":"cn-04","text":"I want to cancel my visit with Dr. Chen, member ID 44718293","intent":"cancel","context":"no_form","slots":{"provider":"chen","memberId":{"span":"44718293","value":"44718293"}},"tags":["over_answer"]}
{"id":"cn-05","text":"Cancel the appointment I have with Dr. Alvarez","intent":"cancel","context":"no_form","slots":{"provider":"alvarez"}}
{"id":"cn-06","text":"I won't be able to come in, cancel it","intent":"cancel","context":"no_form"}
{"id":"cn-07","text":"Cancel my appointment with Dr. Kim please","intent":"cancel","context":"no_form","slots":{"provider":"kim"}}
{"id":"cn-08","text":"I'd like to cancel","intent":"cancel","context":"no_form"}
{"id":"cn-09","text":"Cancel my appointment, my ID is eight one two zero four four five seven","intent":"cancel","context":"no_form","slots":{"memberId":{"span":"eight one two zero four four five seven","value":"81204457"}}}
{"id":"cn-10","text":"Cancel Dr. Patel","intent":"cancel","context":"no_form","slots":{"provider":"patel"}}

{"id":"cf-01","text":"I want to confirm my appointment","intent":"confirm_appointment","context":"no_form"}
{"id":"cf-02","text":"Can you check when my appointment with Dr. Rossi is","intent":"confirm_appointment","context":"no_form","slots":{"provider":"rossi"}}
{"id":"cf-03","text":"Do I still have an appointment with Dr. Nguyen","intent":"confirm_appointment","context":"no_form","slots":{"provider":"nguyen"}}
{"id":"cf-04","text":"Just confirming my visit with Dr. Chen next week","intent":"confirm_appointment","context":"no_form","slots":{"provider":"chen","date":{"mode":"window","window":"next_week"}}}
{"id":"cf-05","text":"Is my appointment still on","intent":"confirm_appointment","context":"no_form"}
{"id":"cf-06","text":"I'm calling to verify my appointment, member ID four four seven one eight two nine three","intent":"confirm_appointment","context":"no_form","slots":{"memberId":{"span":"four four seven one eight two nine three","value":"44718293"}}}
{"id":"cf-07","text":"What time is my appointment with Dr. Kim","intent":"confirm_appointment","context":"no_form","slots":{"provider":"kim"}}
{"id":"cf-08","text":"Confirm my appointment with Dr. Okafor","intent":"confirm_appointment","context":"no_form","slots":{"provider":"okafor"}}

{"id":"bl-01","text":"I have a question about my bill","intent":"billing","context":"no_form"}
{"id":"bl-02","text":"I was charged twice for my last visit","intent":"billing","context":"no_form"}
{"id":"bl-03","text":"Why did my copay go up","intent":"billing","context":"no_form"}
{"id":"bl-04","text":"I need to make a payment on my account","intent":"billing","context":"no_form"}
{"id":"bl-05","text":"Does my insurance cover the visit","intent":"billing","context":"no_form"}
{"id":"bl-06","text":"Billing please, my member ID is four four seven one eight two nine three","intent":"billing","context":"no_form","slots":{"memberId":{"span":"four four seven one eight two nine three","value":"44718293"}},"tags":["over_answer"]}
{"id":"bl-07","text":"I got an invoice I don't understand","intent":"billing","context":"no_form"}
{"id":"bl-08","text":"How much do I owe","intent":"billing","context":"no_form"}

{"id":"ag-01","text":"I want to talk to a person","intent":"agent","context":"no_form"}
{"id":"ag-02","text":"Agent","intent":"agent","context":"no_form"}
{"id":"ag-03","text":"Can I speak with a representative","intent":"agent","context":"no_form"}
{"id":"ag-04","text":"Operator please","intent":"agent","context":"no_form"}
{"id":"ag-05","text":"Just get me a human","intent":"agent","context":"no_form"}
{"id":"ag-06","text":"I need to speak to someone about my appointment","intent":"agent","context":"no_form"}
{"id":"ag-07","text":"Representative","intent":"agent","context":"no_form"}
{"id":"ag-08","text":"Let me talk to somebody","intent":"agent","context":"no_form"}

{"id":"rp-01","text":"Can you repeat that","intent":"repeat_prompt","context":"no_form"}
{"id":"rp-02","text":"Say that again","intent":"repeat_prompt","context":"no_form"}
{"id":"rp-03","text":"What were the options","intent":"repeat_prompt","context":"no_form"}
{"id":"rp-04","text":"Sorry, I didn't hear that","intent":"repeat_prompt","context":"no_form"}

{"id":"ot-01","text":"What are your hours","intent":"other","context":"no_form"}
{"id":"ot-02","text":"Do you have parking","intent":"other","context":"no_form"}
{"id":"ot-03","text":"I need a prescription refill","intent":"other","context":"no_form"}
{"id":"ot-04","text":"Can I get my lab results","intent":"other","context":"no_form"}
{"id":"ot-05","text":"Where are you located","intent":"other","context":"no_form"}
{"id":"ot-06","text":"I want to update my address","intent":"other","context":"no_form"}

{"id":"ns-01","text":"honey where did you put the keys","intent":"none","context":"no_form","answers":{"addressedToSystem":{"noul":0.15}},"tags":["side_speech"]}
{"id":"ns-02","text":"hold on a second I'm on the phone","intent":"none","context":"no_form","answers":{"addressedToSystem":{"noul":0.2}},"tags":["side_speech"]}
{"id":"ns-03","text":"um","intent":"none","context":"no_form","answers":{"intelligible":{"noul":0.3}},"tags":["unintelligible"]}
{"id":"ns-04","text":"ksh brr the","intent":"none","context":"no_form","answers":{"intelligible":{"noul":0.2}},"tags":["unintelligible"]}
{"id":"ns-05","text":"I was wondering if","intent":"none","context":"no_form","answers":{"utteranceComplete":{"noul":0.25}},"tags":["incomplete"]}
{"id":"ns-06","text":"so my appointment","intent":"none","context":"no_form","answers":{"utteranceComplete":{"noul":0.3}},"tags":["incomplete"]}
{"id":"ns-07","text":"hello","intent":"none","context":"no_form"}
{"id":"ns-08","text":"yeah so","intent":"none","context":"no_form","answers":{"utteranceComplete":{"noul":0.35}},"tags":["incomplete"]}

{"id":"lc-01","text":"I need to do something about my appointment","intent":"reschedule","context":"no_form","answers":{"intent":{"probabilities":{"reschedule":0.45,"cancel":0.35,"confirm_appointment":0.1}}},"tags":["low_margin"]}
{"id":"lc-02","text":"My appointment with Dr. Chen","intent":"confirm_appointment","context":"no_form","slots":{"provider":"chen"},"answers":{"intent":{"probabilities":{"confirm_appointment":0.5,"reschedule":0.2}}},"tags":["explicit_confirm"]}
{"id":"lc-03","text":"Maybe cancel it","intent":"cancel","context":"no_form","answers":{"intent":{"probabilities":{"cancel":0.55,"none":0.3}}},"tags":["explicit_confirm"]}
{"id":"lc-04","text":"I think I need to reschedule or maybe cancel","intent":"reschedule","context":"no_form","answers":{"intent":{"probabilities":{"reschedule":0.5,"cancel":0.42}}},"tags":["low_margin"]}
{"id":"lc-05","text":"Change it","intent":"reschedule","context":"no_form","answers":{"intent":{"probabilities":{"reschedule":0.65,"cancel":0.15}}},"tags":["implicit_confirm"]}
{"id":"lc-06","text":"I'm seeing Dr. Chen, or Cheng, I'm not sure","intent":"confirm_appointment","context":"no_form","slots":{"provider":"chen"},"answers":{"provider":{"probabilities":{"chen":0.46,"cheng":0.44}}},"tags":["provider_margin"]}
{"id":"lc-07","text":"Reschedule with Dr. Chen","intent":"reschedule","context":"no_form","slots":{"provider":"chen"},"answers":{"provider":{"probabilities":{"chen":0.5,"cheng":0.4}}},"tags":["provider_margin"]}
{"id":"lc-08","text":"Book something","intent":"schedule_new","context":"no_form","answers":{"intent":{"probabilities":{"schedule_new":0.42,"other":0.3}}},"tags":["explicit_confirm"]}
{"id":"lc-09","text":"Check on my appointment","intent":"confirm_appointment","context":"no_form","answers":{"intent":{"probabilities":{"confirm_appointment":0.75,"cancel":0.1}}},"tags":["implicit_confirm"]}
{"id":"lc-10","text":"I guess I need to cancel","intent":"cancel","context":"no_form","answers":{"intent":{"probabilities":{"cancel":0.35,"none":0.4}}},"tags":["intent_failed"]}
{"id":"lc-11","text":"Rossi I think","intent":"none","context":"schedule_new","slots":{"provider":"rossi"},"answers":{"provider":{"probabilities":{"rossi":0.55,"none":0.4}}},"tags":["implicit_confirm"]}
{"id":"lc-12","text":"It might be Dr. Kim","intent":"none","context":"cancel","slots":{"provider":"kim"},"answers":{"provider":{"probabilities":{"kim":0.4,"none":0.5}}},"tags":["slot_absent"]}

{"id":"fr-01","text":"This is ridiculous, I just want to reschedule","intent":"reschedule","context":"no_form","answers":{"frustration":{"probabilities":{"high":0.75,"mild":0.2}}},"tags":["frustration"]}
{"id":"fr-02","text":"I already told you, cancel it","intent":"cancel","context":"no_form","answers":{"frustration":{"probabilities":{"high":0.65,"mild":0.25}},"rephrasingLastTurn":{"noul":0.8}},"tags":["frustration"]}
{"id":"fr-03","text":"Ugh, come on, I need to reschedule","intent":"reschedule","context":"no_form","answers":{"frustration":{"probabilities":{"mild":0.6,"high":0.3}}},"tags":["frustration"]}
{"id":"fr-04","text":"For the third time, Dr. Chen","intent":"none","context":"reschedule","slots":{"provider":"chen"},"answers":{"frustration":{"probabilities":{"high":0.8,"mild":0.15}},"rephrasingLastTurn":{"noul":0.85}},"tags":["frustration"]}
{"id":"fr-05","text":"Are you kidding me","intent":"none","context":"no_form","answers":{"frustration":{"probabilities":{"high":0.7,"mild":0.2}}},"tags":["frustration"]}
{"id":"fr-06","text":"Seriously, just cancel the appointment","intent":"cancel","context":"no_form","answers":{"frustration":{"probabilities":{"mild":0.55,"high":0.35}}},"tags":["frustration"]}

{"id":"mn-01","text":"one","intent":"none","context":"no_form","answers":{"menuNumberSaid":{"probabilities":{"1":0.92}},"spokeAMenuNumber":{"noul":0.9}},"tags":["menu"]}
{"id":"mn-02","text":"two","intent":"none","context":"no_form","answers":{"menuNumberSaid":{"probabilities":{"2":0.92}},"spokeAMenuNumber":{"noul":0.9}},"tags":["menu"]}
{"id":"mn-03","text":"press three","intent":"none","context":"no_form","answers":{"menuNumberSaid":{"probabilities":{"3":0.9}},"spokeAMenuNumber":{"noul":0.9}},"tags":["menu"]}
{"id":"mn-04","text":"zero","intent":"none","context":"no_form","answers":{"menuNumberSaid":{"probabilities":{"0":0.9}},"spokeAMenuNumber":{"noul":0.9}},"tags":["menu"]}
{"id":"mn-05","text":"five please","intent":"none","context":"no_form","answers":{"menuNumberSaid":{"probabilities":{"5":0.88}},"spokeAMenuNumber":{"noul":0.85}},"tags":["menu"]}

{"id":"cy-01","text":"yes","intent":"none","context":"no_form","answers":{"confirmsYes":{"noul":0.94},"confirmsNo":{"noul":0.03}},"tags":["confirm_yes"]}
{"id":"cy-02","text":"yeah that's right","intent":"none","context":"no_form","answers":{"confirmsYes":{"noul":0.9},"confirmsNo":{"noul":0.05}},"tags":["confirm_yes"]}
{"id":"cy-03","text":"yes please","intent":"none","context":"no_form","answers":{"confirmsYes":{"noul":0.93},"confirmsNo":{"noul":0.03}},"tags":["confirm_yes"]}
{"id":"cy-04","text":"correct","intent":"none","context":"no_form","answers":{"confirmsYes":{"noul":0.88},"confirmsNo":{"noul":0.06}},"tags":["confirm_yes"]}
{"id":"cno-01","text":"no","intent":"none","context":"no_form","answers":{"confirmsYes":{"noul":0.03},"confirmsNo":{"noul":0.94}},"tags":["confirm_no"]}
{"id":"cno-02","text":"no that's wrong","intent":"none","context":"no_form","answers":{"confirmsYes":{"noul":0.04},"confirmsNo":{"noul":0.92}},"tags":["confirm_no"]}
{"id":"cno-03","text":"nope","intent":"none","context":"no_form","answers":{"confirmsYes":{"noul":0.05},"confirmsNo":{"noul":0.9}},"tags":["confirm_no"]}

{"id":"mi-01","text":"four four seven one eight two nine three","intent":"none","context":"reschedule","slots":{"memberId":{"span":"four four seven one eight two nine three","value":"44718293"}}}
{"id":"mi-02","text":"it's 4471 8293","intent":"none","context":"cancel","slots":{"memberId":{"span":"4471 8293","value":"44718293"}}}
{"id":"mi-03","text":"my member ID is eight one two zero four four five seven","intent":"none","context":"billing","slots":{"memberId":{"span":"eight one two zero four four five seven","value":"81204457"}}}
{"id":"mi-04","text":"forty four seventy one eighty two ninety three","intent":"none","context":"schedule_new","slots":{"memberId":{"span":"forty four seventy one eighty two ninety three","value":"44718293"}},"tags":["compound_numbers"]}
{"id":"mi-05","text":"double four seven one eight two nine three","intent":"none","context":"confirm_appointment","slots":{"memberId":{"span":"double four seven one eight two nine three","value":"44718293"}},"tags":["double"]}
{"id":"mi-06","text":"it is two two zero five nine one three eight","intent":"none","context":"reschedule","slots":{"memberId":{"span":"two two zero five nine one three eight","value":"22059138"}}}
{"id":"mi-07","text":"four four seven one, that's it","intent":"none","context":"cancel","slots":{"memberId":{"span":"four four seven one","value":"4471"}},"tags":["mask_fail"]}
{"id":"mi-08","text":"four four seven one uh","intent":"none","context":"cancel","slots":{"memberId":{"span":"four four seven one","value":"4471"}},"answers":{"memberIdComplete":{"noul":0.3},"utteranceComplete":{"noul":0.4}},"tags":["incomplete_id"]}
{"id":"mi-09","text":"member ID 4471 8293 and it's with Dr. Chen","intent":"none","context":"reschedule","slots":{"memberId":{"span":"4471 8293","value":"44718293"},"provider":"chen"},"tags":["over_answer"]}
{"id":"mi-10","text":"4 4 7 1 8 2 9 3","intent":"none","context":"schedule_new","slots":{"memberId":{"span":"4 4 7 1 8 2 9 3","value":"44718293"}}}
{"id":"mi-11","text":"one two three four five six seven eight","intent":"none","context":"billing","slots":{"memberId":{"span":"one two three four five six seven eight","value":"12345678"}}}
{"id":"mi-12","text":"it's oh nine three three one two seven six","intent":"none","context":"reschedule","slots":{"memberId":{"span":"oh nine three three one two seven six","value":"09331276"}},"tags":["oh_as_zero"]}

{"id":"pv-01","text":"Dr. Chen","intent":"none","context":"reschedule","slots":{"provider":"chen"}}
{"id":"pv-02","text":"It's with Patel","intent":"none","context":"cancel","slots":{"provider":"patel"}}
{"id":"pv-03","text":"Nguyen","intent":"none","context":"schedule_new","slots":{"provider":"nguyen"}}
{"id":"pv-04","text":"Dr. Cheng, C H E N G","intent":"none","context":"reschedule","slots":{"provider":"cheng"}}
{"id":"pv-05","text":"Doctor Okafor","intent":"none","context":"confirm_appointment","slots":{"provider":"okafor"}}
{"id":"pv-06","text":"Dr. Kim, and can we do next Monday","intent":"none","context":"reschedule","slots":{"provider":"kim","date":{"mode":"weekday","weekday":"monday","weekdayQualifier":"next"}},"tags":["over_answer"]}
{"id":"pv-07","text":"I don't remember the doctor's name","intent":"none","context":"cancel","tags":["no_progress"]}
{"id":"pv-08","text":"Alvarez","intent":"none","context":"cancel","slots":{"provider":"alvarez"}}

{"id":"dt-01","text":"tomorrow","intent":"none","context":"reschedule","slots":{"date":{"mode":"relative_day","relativeDay":"tomorrow"}}}
{"id":"dt-02","text":"next Tuesday","intent":"none","context":"schedule_new","slots":{"date":{"mode":"weekday","weekday":"tuesday","weekdayQualifier":"next"}}}
{"id":"dt-03","text":"October 5th","intent":"none","context":"reschedule","slots":{"date":{"mode":"absolute","month":"october","day":"5"}}}
{"id":"dt-04","text":"the twelfth of November","intent":"none","context":"schedule_new","slots":{"date":{"mode":"absolute","month":"november","day":"12"}}}
{"id":"dt-05","text":"sometime next week","intent":"none","context":"reschedule","slots":{"date":{"mode":"window","window":"next_week"}}}
{"id":"dt-06","text":"Thursday","intent":"none","context":"schedule_new","slots":{"date":{"mode":"weekday","weekday":"thursday"}}}
{"id":"dt-07","text":"this Friday","intent":"none","context":"reschedule","slots":{"date":{"mode":"weekday","weekday":"friday","weekdayQualifier":"this"}}}
{"id":"dt-08","text":"next month","intent":"none","context":"schedule_new","slots":{"date":{"mode":"window","window":"next_month"}}}
{"id":"dt-09","text":"Monday, September 28","intent":"none","context":"reschedule","slots":{"date":{"mode":"absolute","month":"september","day":"28"}}}
{"id":"dt-10","text":"today if possible","intent":"none","context":"schedule_new","slots":{"date":{"mode":"relative_day","relativeDay":"today"}}}
{"id":"dt-11","text":"February 30th","intent":"none","context":"reschedule","slots":{"date":{"mode":"absolute","month":"february","day":"30"}},"tags":["impossible_date"]}
{"id":"dt-12","text":"Tuesday next week","intent":"none","context":"reschedule","slots":{"date":{"mode":"weekday","weekday":"tuesday","weekdayQualifier":"next"}}}
{"id":"dt-13","text":"the day after tomorrow","intent":"none","context":"schedule_new","slots":{"date":{"mode":"relative_day","relativeDay":"day_after_tomorrow"}}}
{"id":"dt-14","text":"March 3rd","intent":"none","context":"reschedule","slots":{"date":{"mode":"absolute","month":"march","day":"3"}},"tags":["next_year"]}
{"id":"dt-15","text":"Wednesday","intent":"none","context":"reschedule","slots":{"date":{"mode":"weekday","weekday":"wednesday"}}}
{"id":"dt-16","text":"how about Wednesday","intent":"none","context":"reschedule","slots":{"date":{"mode":"weekday","weekday":"wednesday"}}}
{"id":"dt-17","text":"Tuesday","intent":"none","context":"reschedule","slots":{"date":{"mode":"weekday","weekday":"tuesday"}}}
{"id":"dt-18","text":"any day is fine","intent":"none","context":"reschedule","tags":["no_progress"]}

{"id":"sw-01","text":"actually I want to cancel it instead","intent":"cancel","context":"reschedule","tags":["intent_switch"]}
{"id":"sw-02","text":"wait, never mind, cancel the appointment","intent":"cancel","context":"reschedule","tags":["intent_switch"]}
{"id":"sw-03","text":"actually can I just talk to someone","intent":"agent","context":"reschedule","tags":["wants_human"]}
{"id":"sw-04","text":"I'd rather talk to a person","intent":"agent","context":"cancel","tags":["wants_human"]}
{"id":"sw-05","text":"what did you say","intent":"repeat_prompt","context":"reschedule","tags":["repeat"]}
{"id":"sw-06","text":"repeat that","intent":"repeat_prompt","context":"billing","tags":["repeat"]}
{"id":"sw-07","text":"and can I also ask about my bill","intent":"none","context":"reschedule","answers":{"intentSecondary":{"probabilities":{"billing":0.8}}},"tags":["secondary_intent"]}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/jev/corpus.test.ts`
Expected: 6 tests passed. If a span assertion fails, the labeled `span` is not a contiguous token run of the normalized text; fix the label, never the test.

- [ ] **Step 5: Run the corpus through the CLI**

Run: `pnpm cli --corpus fixtures/corpus.jsonl --today 2026-09-18 --quiet`
Expected: one line per entry with the decision and prompt id, then a metrics block. `answers by source` shows only `stub:fixture` and `none`, never `stub:heuristic`; if it does, a corpus `text` does not match the lookup after normalization.

- [ ] **Step 6: Commit**

```bash
git add fixtures/corpus.jsonl src/jev/corpus.test.ts
git commit -m "feat(fixtures): add labeled utterance corpus"
```

---

### Task 28: Multi-turn scenarios

**Files:**
- Create: `fixtures/scenarios/core.json`, `src/harness-text/scenarios.test.ts`

All scenarios assume `today` is `2026-09-18` (a Friday). Every `say` text must exist in the corpus so the fixture stub answers deterministically.

- [ ] **Step 1: Write the scenario test**

`src/harness-text/scenarios.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadScenarios, runScenario } from './runner';
import { loadCorpus, normalizeText } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

const corpus = loadCorpus('fixtures/corpus.jsonl');
const scenarios = loadScenarios('fixtures/scenarios');
const known = new Set(corpus.map((e) => normalizeText(e.text)));
const opts = {
  client: new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient() }),
  thresholds: { ...DEFAULT_THRESHOLDS },
  todayIso: '2026-09-18',
  now: () => 0,
};

describe('fixtures/scenarios', () => {
  it('has at least 15 scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(15);
  });

  it('only says things that are in the corpus', () => {
    for (const s of scenarios) for (const step of s.steps) if ('say' in step) expect(known, `${s.id}: ${step.say}`).toContain(normalizeText(step.say));
  });

  for (const s of scenarios) {
    it(`passes: ${s.id}`, async () => {
      const r = await runScenario(s, opts);
      expect(r.mismatches).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/harness-text/scenarios.test.ts`
Expected: FAIL, ENOENT fixtures/scenarios.

- [ ] **Step 3: Write the scenarios**

`fixtures/scenarios/core.json`:

```json
[
  {
    "id": "reschedule-happy",
    "steps": [
      { "say": "I need to reschedule my appointment, it's with Dr. Chen sometime next week" },
      { "say": "four four seven one eight two nine three" },
      { "say": "Tuesday" }
    ],
    "expect": { "decision": "complete", "promptId": "reschedule_confirmed", "form": "reschedule",
                "slots": { "memberId": "44718293", "provider": "chen", "date": "2026-09-22" } }
  },
  {
    "id": "schedule-dtmf-id",
    "steps": [
      { "say": "I need to book an appointment with Dr. Patel" },
      { "dtmf": "44718293" },
      { "say": "next Tuesday" }
    ],
    "expect": { "decision": "complete", "promptId": "schedule_confirmed", "form": "schedule_new",
                "slots": { "memberId": "44718293", "provider": "patel", "date": "2026-09-22" } }
  },
  {
    "id": "cancel-happy",
    "steps": [
      { "say": "I need to cancel my appointment with Dr. Okafor" },
      { "say": "it's 4471 8293" }
    ],
    "expect": { "decision": "complete", "promptId": "cancel_confirmed", "form": "cancel",
                "slots": { "memberId": "44718293", "provider": "okafor" } }
  },
  {
    "id": "confirm-happy",
    "steps": [
      { "say": "Confirm my appointment with Dr. Okafor" },
      { "say": "it's 4471 8293" }
    ],
    "expect": { "decision": "complete", "promptId": "appointment_details", "form": "confirm_appointment" }
  },
  {
    "id": "billing-handoff",
    "steps": [
      { "say": "I have a question about my bill" },
      { "say": "my member ID is eight one two zero four four five seven" }
    ],
    "expect": { "decision": "handoff", "reason": "billing", "form": "billing", "slots": { "memberId": "81204457" } }
  },
  {
    "id": "over-answer-one-turn",
    "steps": [
      { "say": "Make an appointment with Dr. Okafor, member ID 4471 8293, Friday" }
    ],
    "expect": { "decision": "complete", "promptId": "schedule_confirmed",
                "slots": { "memberId": "44718293", "provider": "okafor", "date": "2026-09-25" } }
  },
  {
    "id": "intent-switch-mid-form",
    "steps": [
      { "say": "Reschedule my appointment with Dr. Cheng" },
      { "say": "actually I want to cancel it instead" }
    ],
    "expect": { "decision": "prompt", "promptId": "ask_memberId", "form": "cancel", "slots": { "provider": "cheng" } }
  },
  {
    "id": "window-then-day",
    "steps": [
      { "say": "I need to reschedule my appointment, it's with Dr. Chen sometime next week" },
      { "say": "four four seven one eight two nine three" },
      { "say": "how about Wednesday" }
    ],
    "expect": { "decision": "complete", "slots": { "date": "2026-09-23" } }
  },
  {
    "id": "month-window-narrow",
    "steps": [
      { "say": "I need a different date for my appointment, something in December" },
      { "say": "four four seven one eight two nine three" }
    ],
    "expect": { "decision": "prompt", "promptId": "ask_provider", "form": "reschedule" }
  },
  {
    "id": "intent-retry-to-agent",
    "steps": [
      { "say": "What are your hours" },
      { "say": "What are your hours" },
      { "say": "What are your hours" }
    ],
    "expect": { "decision": "handoff", "reason": "max-attempts", "form": null }
  },
  {
    "id": "slot-retry-to-dtmf",
    "steps": [
      { "say": "Cancel my appointment" },
      { "say": "um" },
      { "say": "um" },
      { "dtmf": "44718293" }
    ],
    "expect": { "decision": "prompt", "promptId": "ask_provider", "form": "cancel", "slots": { "memberId": "44718293" } }
  },
  {
    "id": "dtmf-menu",
    "steps": [
      { "say": "What are your hours" },
      { "say": "What are your hours" },
      { "dtmf": "2" }
    ],
    "expect": { "decision": "prompt", "promptId": "ask_memberId", "form": "reschedule" }
  },
  {
    "id": "spoken-menu-number",
    "steps": [
      { "say": "What are your hours" },
      { "say": "What are your hours" },
      { "say": "press three" }
    ],
    "expect": { "decision": "prompt", "promptId": "ask_memberId", "form": "cancel" }
  },
  {
    "id": "explicit-confirm-yes",
    "steps": [
      { "say": "Maybe cancel it" },
      { "say": "yes" }
    ],
    "expect": { "decision": "prompt", "promptId": "ask_memberId", "form": "cancel" }
  },
  {
    "id": "explicit-confirm-no",
    "steps": [
      { "say": "Maybe cancel it" },
      { "say": "no" }
    ],
    "expect": { "decision": "prompt", "promptId": "nomatch_open", "form": null }
  },
  {
    "id": "disambiguate-intent",
    "steps": [
      { "say": "I think I need to reschedule or maybe cancel" },
      { "say": "I need to reschedule my appointment" }
    ],
    "expect": { "decision": "prompt", "promptId": "ask_memberId", "form": "reschedule" }
  },
  {
    "id": "disambiguate-provider",
    "steps": [
      { "say": "Reschedule with Dr. Chen" },
      { "say": "Dr. Cheng, C H E N G" }
    ],
    "expect": { "decision": "prompt", "promptId": "ask_memberId", "form": "reschedule", "slots": { "provider": "cheng" } }
  },
  {
    "id": "frustration-escalation",
    "steps": [
      { "say": "I need to reschedule my appointment" },
      { "say": "four four seven one, that's it" },
      { "say": "For the third time, Dr. Chen" }
    ],
    "expect": { "decision": "handoff", "reason": "frustrated" }
  },
  {
    "id": "wants-human-mid-form",
    "steps": [
      { "say": "I need to reschedule my appointment" },
      { "say": "actually can I just talk to someone" }
    ],
    "expect": { "decision": "handoff", "reason": "live-agent" }
  },
  {
    "id": "repeat-prompt",
    "steps": [
      { "say": "I need to reschedule my appointment" },
      { "say": "what did you say" }
    ],
    "expect": { "decision": "replay", "form": "reschedule" }
  },
  {
    "id": "client-failure-once",
    "steps": [
      { "say": "I need to reschedule my appointment", "fail": true },
      { "say": "I need to reschedule my appointment" }
    ],
    "expect": { "decision": "prompt", "promptId": "ask_memberId", "form": "reschedule" }
  },
  {
    "id": "client-failure-twice",
    "steps": [
      { "say": "I need to reschedule my appointment", "fail": true },
      { "say": "I need to reschedule my appointment", "fail": true }
    ],
    "expect": { "decision": "handoff", "reason": "system-failure" }
  },
  {
    "id": "side-speech-ignored",
    "steps": [
      { "say": "I need to reschedule my appointment" },
      { "say": "honey where did you put the keys" }
    ],
    "expect": { "decision": "ignore", "form": "reschedule" }
  },
  {
    "id": "invalid-date-retry",
    "steps": [
      { "say": "I need to reschedule my appointment" },
      { "say": "four four seven one eight two nine three" },
      { "say": "Dr. Chen" },
      { "say": "February 30th" }
    ],
    "expect": { "decision": "prompt", "promptId": "ask_date_retry", "form": "reschedule" }
  }
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/harness-text/scenarios.test.ts`
Expected: 26 tests passed. If a scenario fails, run it verbosely to see every turn: `pnpm cli --scenarios fixtures/scenarios --today 2026-09-18` prints the answer table, gate table and decision for each turn of any failing scenario. Fix the core or the corpus label, whichever is wrong; do not loosen the expectation unless the spec says the expectation is wrong.

- [ ] **Step 5: Commit**

```bash
git add fixtures/scenarios/core.json src/harness-text/scenarios.test.ts
git commit -m "feat(fixtures): add multi-turn scenarios"
```

---

### Task 29: Regression runner

**Files:**
- Create: `src/harness-text/regress.ts`, `fixtures/expected/corpus.json`, `fixtures/expected/scenarios.json`

- [ ] **Step 1: Write regress.ts**

`src/harness-text/regress.ts`:

```ts
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { parseOverride, withOverrides } from '../core/thresholds';
import { loadScenarios, runCorpusEntry, runScenario, type Outcome, type RunOptions } from './runner';

/** Fixed so recorded outcomes never depend on the wall clock. */
export const REGRESS_TODAY = '2026-09-18';
const EXPECTED_DIR = 'fixtures/expected';

const { values: args } = parseArgs({
  options: {
    update: { type: 'boolean', default: false },
    threshold: { type: 'string', multiple: true, default: [] },
  },
});

type ScenarioOutcome = Outcome & { pass: boolean; mismatches: string[] };
interface Recorded {
  corpus: Record<string, Outcome>;
  scenarios: Record<string, ScenarioOutcome>;
}

function readExpected<T>(file: string): Record<string, T> {
  const path = `${EXPECTED_DIR}/${file}`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, T>) : {};
}

function diff<T extends object>(name: string, expected: Record<string, T>, actual: Record<string, T>): string[] {
  const out: string[] = [];
  for (const id of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const e = expected[id];
    const a = actual[id];
    if (!e) { out.push(`+ ${name} ${id}: new`); continue; }
    if (!a) { out.push(`- ${name} ${id}: removed`); continue; }
    for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) {
      const ev = JSON.stringify((e as Record<string, unknown>)[key]);
      const av = JSON.stringify((a as Record<string, unknown>)[key]);
      if (ev !== av) out.push(`~ ${name} ${id}.${key}: ${ev} -> ${av}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const thresholds = withOverrides(Object.assign({}, ...(args.threshold ?? []).map(parseOverride)));
  const corpus = loadCorpus('fixtures/corpus.jsonl');
  const opts: RunOptions = {
    client: new FixtureStubClient(corpus, { sharpness: thresholds.STUB_SHARPNESS, fallback: new HeuristicStubClient() }),
    thresholds,
    todayIso: REGRESS_TODAY,
    now: () => 0,
  };

  const actual: Recorded = { corpus: {}, scenarios: {} };
  for (const entry of corpus) actual.corpus[entry.id] = (await runCorpusEntry(entry, opts)).outcome;
  for (const scenario of loadScenarios('fixtures/scenarios')) {
    const r = await runScenario(scenario, opts);
    actual.scenarios[scenario.id] = { ...r.outcome, pass: r.pass, mismatches: r.mismatches };
  }

  if (args.update) {
    mkdirSync(EXPECTED_DIR, { recursive: true });
    writeFileSync(`${EXPECTED_DIR}/corpus.json`, JSON.stringify(actual.corpus, null, 2) + '\n');
    writeFileSync(`${EXPECTED_DIR}/scenarios.json`, JSON.stringify(actual.scenarios, null, 2) + '\n');
    console.log(`recorded ${Object.keys(actual.corpus).length} corpus outcomes and ${Object.keys(actual.scenarios).length} scenario outcomes`);
    return;
  }

  const lines = [
    ...diff('corpus', readExpected<Outcome>('corpus.json'), actual.corpus),
    ...diff('scenario', readExpected<ScenarioOutcome>('scenarios.json'), actual.scenarios),
  ];
  const failing = Object.values(actual.scenarios).filter((s) => !s.pass);
  for (const s of failing) console.log(`FAIL scenario ${s.id}: ${s.mismatches.join('; ')}`);
  for (const l of lines) console.log(l);
  if (lines.length === 0 && failing.length === 0) console.log('no changes');
  else process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Record the baseline**

Run: `pnpm regress --update`
Expected: `recorded 149 corpus outcomes and 24 scenario outcomes` (counts match the files written in Tasks 27 and 28). Open `fixtures/expected/scenarios.json` and confirm every entry has `"pass": true`.

- [ ] **Step 3: Verify a clean run and a threshold change**

Run: `pnpm regress`
Expected: `no changes`, exit 0.

Run: `pnpm regress --threshold INTENT_ROUTE=0.95`
Expected: many `~ corpus <id>.promptId` and `~ corpus <id>.decidedGate` lines as silent routes become implicit confirms; exit 1. This is the "change a threshold, diff outcomes" loop working.

- [ ] **Step 4: Commit**

```bash
git add src/harness-text/regress.ts fixtures/expected
git commit -m "feat(harness): add regression runner with recorded outcomes"
```

---

### Task 30: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

```markdown
# jev-ivr

A mixed-initiative voice IVR front end driven by a fast, calibrated,
non-generative decision model (TypeSafe's Jev), demonstrated on a healthcare
scheduling flow. See `JEV-IVR-HANDOFF.md` for the thesis and
`docs/superpowers/specs/` for the design.

Status: Phase 0–1 (decision core and text harness). No Jev API key yet; the
harness runs against a deterministic stub keyed on a labeled corpus.

## Setup

    pnpm install
    pnpm test          # unit tests
    pnpm typecheck

## Text harness

    pnpm cli                                   # REPL against the fixture stub
    pnpm cli --client heuristic                # keyword stub, any input
    pnpm cli --corpus fixtures/corpus.jsonl    # every labeled utterance
    pnpm cli --scenarios fixtures/scenarios    # multi-turn scripts
    pnpm cli --trace traces/run.jsonl          # write JSONL trace records
    pnpm cli --threshold INTENT_ROUTE=0.9      # override any threshold
    pnpm cli --today 2026-09-18                # fix the clock for date slots
    pnpm cli --client jev                      # real model; needs TYPESAFE_API_KEY

In the REPL, type an utterance, `dtmf:44718293` to send keypad digits, or
`/reset` to start a new call.

## Regression

    pnpm regress            # diff outcomes against fixtures/expected
    pnpm regress --update   # re-record after an intended change

## Layout

    src/domain        intents, forms, slot specs, provider roster
    src/core          state, question set, gate ladder, form loop, extraction, turn
    src/jev           client interface, stubs, SDK client
    src/channel       ConversationRelay frame types
    src/prompts       prompt manifest and rendering
    src/trace         JSONL trace record
    src/harness-text  CLI, runner, metrics, regression
    fixtures          corpus, scenarios, recorded outcomes

## DTMF baseline

`src/domain/dtmf-baseline.json` counts caller turns under a conventional
keypad tree: main menu, ID entry, ID confirm, provider menu, date entry, date
confirm, final confirm. The metrics summary reports observed turns against it.
```

- [ ] **Step 2: Commit and push**

```bash
git add README.md
git commit -m "docs: add README for the text harness"
git push
```

---

## Self-review notes

Spec coverage, section by section:

| Spec section | Tasks |
| --- | --- |
| §2 decisions (SDK, pin, own types, layout, stub, buckets, date, member id, retry, margin) | 1, 2, 5–7, 14, 17, 18, 24 |
| §3 domain, slot kinds, candidate spans, DTMF baseline | 9–13 |
| §4 turn schema | 16 |
| §5 state | 15 |
| §6 gate ladder | 17 (escalation moved before intent; margin applies in the explicit band) |
| §7 turn function, session, events, decisions | 14, 19, 20 |
| §8 extraction tiers | 5–8, 11 |
| §9 client interface and implementations | 2, 22–24 |
| §10 failure handling | 20 |
| §11 frames and prompts | 3, 19 |
| §12 fixtures, scenarios, expected | 27–29 |
| §13 harness CLI, metrics, regress | 25, 26, 29 |
| §14 trace record | 21 |
| §15 testing | every task |
| §16 layout | file structure table |

Known simplifications, all called out inline: no "hundred" in spoken numbers; one scenarios file; `intentSecondary`, `urgency`, `triedSelfService` and `languageSwitch` are asked and traced but not acted on in this sub-project.

