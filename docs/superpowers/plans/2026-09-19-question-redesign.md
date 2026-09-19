# Question Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the questions match what Jev actually judges (which intent vs how committed; answering vs adding vs replacing; hedged providers; digit strings and chunked numbers), add the two flow features those judgments need (queue-and-chain for added intents, explicit member-ID confirmation), and re-record the baseline and cassette.

**Architecture:** Question wording and three new questions in `src/core/questions.ts` and the slot specs; the gate ladder consumes `intentTentative` and `intentChange`; the session gains a queue, a completed list, and a two-shape pending confirmation; `continueForm` raises slot confirmations; `completeForm` chains into the next queued form; decisions carry acks through completion and handoff. Corpus labels drive the stub for the new questions.

**Tech Stack:** TypeScript strict ESM, pnpm, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-19-question-redesign-design.md`. Read it first. The plan wins on small conflicts; each is marked "Deviation:".

**Conventions for every task:**

- Tests colocated as `*.test.ts`; run one with `pnpm vitest run <path>`, all with `pnpm test`; typecheck with `pnpm typecheck`.
- Extensionless imports; strict TS; `noUncheckedIndexedAccess` is on.
- Commit after every task with the message shown, one task per commit, exactly one writer at a time; every commit message ends with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never set, read, or print `TYPESAFE_API_KEY`; never run `--client jev` or `--client record`. Only Jason runs the recording (Task 12).
- Until Task 10 lands, `pnpm test` must stay green after every task: the fixture stub answers the new questions with quiet defaults (`intentTentative` 0.05, `intentChange` → `answering`, `providerUnsure` 0.05), so existing scenarios keep their behavior until their labels change.
- `src/server/*.ts` source is not modified; two of its test files are (Task 8).

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/core/thresholds.ts` | `INTENT_TENTATIVE`, `INTENT_CHANGE`, `PROVIDER_UNSURE` |
| `src/core/extract/spokenNumber.ts` | `hundred`/`thousand` multipliers, `and` inside a group |
| `src/core/questions.ts` | reworded `intelligible`; `intentTentative`; `intentChange` in-form; `intentSecondary` removed |
| `src/core/state.ts` | `activeFormLabel`; slot-shaped pending confirmation |
| `src/core/session.ts` | `queued`, `completed`, `PendingConfirmation` union with stashed answers |
| `src/core/gates.ts` | tentative → explicit; `intentChange` branch; `queue` verdict |
| `src/core/fia.ts` | explicit slot fills, `pendingSlotConfirmation` |
| `src/core/turn.ts` | slot confirmation flow, stashed-answer confirm, queue verdict, chaining, acks on complete/handoff |
| `src/core/decision.ts` | `acks` on complete and handoff, `completed` on handoff |
| `src/channel/frames.ts` | `endFrame(reason, completed?)` |
| `src/prompts/render.ts`, `manifest.json` | new prompts; completion + goodbye; acks before completion/handoff |
| `src/domain/slots/{types,memberId,provider}.ts` | `spokenConfirm` policy; reworded span question; `providerUnsure` |
| `src/jev/corpus.ts`, `src/jev/fixtureStub.ts` | `tentative`, `change`, `providerUnsure` labels |
| `src/harness-text/runner.ts` | `Outcome.queued` |
| `fixtures/corpus.jsonl`, `fixtures/scenarios/core.json`, `fixtures/expected/*` | relabels, new entries, rewritten scenarios, re-recorded baseline |
| `src/server/adapter.test.ts`, `src/server/server.test.ts` | pinned completion text now ends with a separate "Goodbye." |
| `README.md` | labels; confirmation and multi-intent notes |

---

### Task 1: Thresholds and chunked spoken numbers

**Files:**
- Modify: `src/core/thresholds.ts`
- Modify: `src/core/extract/spokenNumber.ts`
- Test: `src/core/extract/spokenNumber.test.ts`, `src/core/thresholds.test.ts`

- [ ] **Step 1: Add the thresholds**

In `src/core/thresholds.ts`, after `GATE_FRUSTRATION_HIGH: 0.6,` add:

```ts
  // question redesign (spec 2026-09-19 §8)
  INTENT_TENTATIVE: 0.5,
  INTENT_CHANGE: 0.6,
  PROVIDER_UNSURE: 0.5,
```

- [ ] **Step 2: Write the failing converter tests**

In `src/core/extract/spokenNumber.test.ts`, add these rows to the `it.each` table:

```ts
    ['forty four one eighty seven three hundred fifty five', '44187355'],
    ['three hundred five', '305'],
    ['two hundred', '200'],
    ['four hundred and twelve', '412'],
    ['44 187 355', '44187355'],
    ['one eighty seven', '187'],
    ['three hundred fifty', '350'],
    ['two thousand five', '2005'],
    ['three hundred please fifty five', '30055'],
    ['four four one eight seven three hundred five', '44187305'],
```

The `'three hundred please fifty five'` row pins that an unknown word closes the group: 300 then 55.

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm vitest run src/core/extract/spokenNumber.test.ts`
Expected: FAIL on the `hundred`/`thousand` rows (`'three hundred five'` gives `35`).

- [ ] **Step 4: Implement**

Replace the body of `src/core/extract/spokenNumber.ts` from `const REPEATS` down with:

```ts
const REPEATS: Record<string, number> = { double: 2, triple: 3 };
const MULTIPLIERS: Record<string, number> = { hundred: 100, thousand: 1000 };

export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...Object.keys(UNITS), ...Object.keys(TEENS), ...Object.keys(TENS), ...Object.keys(REPEATS), ...Object.keys(MULTIPLIERS),
]);

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Convert spoken number words to a digit string. Groups compose the way
 * English does ("forty four" 44, "three hundred five" 305, "two thousand"
 * 2000) and consecutive groups concatenate ("forty four, one eighty seven"
 * 44187). Non-number tokens close the current group and are otherwise
 * ignored, so a loosely chosen span still yields digits; the slot mask
 * decides whether the result is acceptable.
 */
export function spokenToDigits(text: string): string {
  let out = '';
  let pendingTens: number | null = null;
  let repeat = 1;
  // The last group emitted from words: where it starts in `out` and its value,
  // so a following multiplier can rewrite it ("three" then "hundred" → 300).
  let last: { start: number; value: number } | null = null;
  // A multiplier was just applied, so the next small number adds into `last`
  // ("three hundred" then "five" → 305) instead of starting a new group.
  let open = false;

  const rewriteLast = (): void => {
    out = out.slice(0, last!.start) + String(last!.value);
  };
  const emit = (n: number): void => {
    if (open && repeat === 1 && last) {
      last.value += n;
      rewriteLast();
      open = false;
      return;
    }
    const start = out.length;
    out += String(n).repeat(repeat);
    last = repeat === 1 ? { start, value: n } : null;
    repeat = 1;
    open = false;
  };
  const flush = (): void => {
    if (pendingTens !== null) {
      const n = pendingTens;
      pendingTens = null;
      emit(n);
    }
  };
  const close = (): void => {
    flush();
    repeat = 1;
    open = false;
    last = null;
  };

  for (const tok of tokenize(text)) {
    if (/^\d+$/.test(tok)) {
      flush();
      out += tok.repeat(repeat);
      repeat = 1;
      last = null;
      open = false;
    } else if (tok in REPEATS) {
      flush();
      repeat = REPEATS[tok]!;
    } else if (tok in MULTIPLIERS) {
      flush();
      if (last) {
        last.value *= MULTIPLIERS[tok]!;
        rewriteLast();
        open = true;
      } else {
        emit(MULTIPLIERS[tok]!);
      }
    } else if (tok === 'and') {
      if (!open) close();
    } else if (tok in UNITS) {
      const unit = UNITS[tok]!;
      if (pendingTens !== null && unit !== 0) {
        const n = pendingTens + unit;
        pendingTens = null;
        emit(n);
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
    } else {
      close();
    }
  }
  flush();
  return out;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run src/core/extract/spokenNumber.test.ts src/core/spans.test.ts src/core/thresholds.test.ts` then `pnpm typecheck` then `pnpm test`.
Expected: all passing. `hundred` and `thousand` are now number words, so `candidateSpans` covers chunked numbers; the existing `'forty please hold four'` → `'404'` and `'double please four'` → `'4'` rows must still pass (an unknown word closes the group).

- [ ] **Step 6: Commit**

```bash
git add src/core/thresholds.ts src/core/extract/spokenNumber.ts src/core/extract/spokenNumber.test.ts
git commit -m "feat(core): chunked spoken numbers; tentative, change and unsure thresholds

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Questions and turn state

**Files:**
- Modify: `src/core/questions.ts`, `src/core/state.ts`, `src/domain/slots/memberId.ts`
- Test: `src/core/questions.test.ts`, `src/core/state.test.ts`, `src/domain/slots/memberId.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/core/questions.test.ts` (reuse its existing imports; it already imports `buildQuestions`, `newSession`, `setForm` and a slot context, check the top of the file and add what is missing):

```ts
describe('question redesign', () => {
  it('asks intentTentative always and never intentSecondary', () => {
    const q = buildQuestions(newSession('s', 0), ctx);
    expect(q.intentTentative).toMatchObject({ type: 'noul' });
    expect(q.intentSecondary).toBeUndefined();
    expect(q.intentChange).toBeUndefined();
  });

  it('asks intentChange only inside a form, with answering first', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    const q = buildQuestions(s, ctx);
    expect(q.intentChange?.type).toBe('choice');
    if (q.intentChange?.type === 'choice') expect(Object.keys(q.intentChange.criteria)).toEqual(['answering', 'adding', 'replacing']);
  });

  it('pins the reworded and new instructions', () => {
    const q = buildQuestions(setForm(newSession('s', 0), 'reschedule'), ctx);
    expect(q.intelligible?.instructions).toBe('Read asr.text. Is the text something a caller could meaningfully have said, including a single word, a yes or no, a name, a number, or a string of digits, as opposed to garbled fragments or background noise?');
    expect(q.intentTentative?.instructions).toBe('Read asr.text. Does the caller express their request tentatively or hypothetically, with words such as maybe, I guess, I think, possibly, or maybe instead, rather than stating it plainly?');
    expect(q.intentChange?.instructions).toBe('Read asr.text. The caller is in the middle of the task described by activeFormLabel and was just asked node.promptJustPlayed. Which best describes this utterance?');
    expect(q.memberIdSpan?.instructions).toBe('Read asr.text. Which of these spans is the member ID the caller states? Choose the span that covers the whole number as spoken, including number words like forty-four or three hundred fifty-five and modifiers like double or triple. Choose none if no span is a member ID.');
  });
});
```

If the file's slot context variable is not named `ctx`, use its name. Append to `src/core/state.test.ts`:

```ts
  it('exposes the spoken label of the active form', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    expect(buildTurnState(s, { text: 'x', isFinal: true, dtmf: null }, 0).activeFormLabel).toBe('cancel an appointment');
    expect(buildTurnState(newSession('s', 0), { text: 'x', isFinal: true, dtmf: null }, 0).activeFormLabel).toBeNull();
  });
```

(add `setForm` to that file's session import if missing).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/core/questions.test.ts src/core/state.test.ts`
Expected: FAIL (no `intentTentative`, `intentSecondary` still present, wording differs, no `activeFormLabel`).

- [ ] **Step 3: Implement the questions**

In `src/core/questions.ts`:

`ALWAYS_ON_IDS` becomes:

```ts
export const ALWAYS_ON_IDS = [
  'intent', 'intentTentative',
  'addressedToSystem', 'utteranceComplete', 'wantsHuman', 'rephrasingLastTurn', 'confusedByPrompt', 'spokeAMenuNumber',
  'frustration', 'urgency', 'triedSelfService', 'languageSwitch',
  'intelligible',
] as const;
```

In `alwaysOn()`, delete the `intentSecondary` entry and insert after `intent`:

```ts
    intentTentative: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller express their request tentatively or hypothetically, with words such as maybe, I guess, I think, possibly, or maybe instead, rather than stating it plainly?',
    },
```

Replace the `intelligible` instructions with:

```ts
      instructions: 'Read asr.text. Is the text something a caller could meaningfully have said, including a single word, a yes or no, a name, a number, or a string of digits, as opposed to garbled fragments or background noise?',
```

Add after `confirmation()`:

```ts
/** Spec 2026-09-19 §2.2: what an in-form utterance does to the current task. Asked only inside a form. */
function inForm(): QuestionMap {
  return {
    intentChange: {
      type: 'choice',
      instructions: 'Read asr.text. The caller is in the middle of the task described by activeFormLabel and was just asked node.promptJustPlayed. Which best describes this utterance?',
      criteria: {
        answering: 'Answers or reacts to the question that was just asked, or says something incidental, without asking for a different task',
        adding: 'Asks for an additional task to be handled as well, while keeping the current one, for example with also, as well, and another thing, or after this',
        replacing: 'Abandons the current task in favour of a different one, for example with never mind, forget that, instead, or actually I just want',
      },
    },
  };
}
```

In `buildQuestions`, after the slot loop add `if (session.form) Object.assign(q, inForm());`.

Deviation: the spec wrote the instruction as `activeForm.label`; the turn state exposes it as a top-level `activeFormLabel` field (Step 4) because `activeForm` is the form id string and changing its shape would touch every consumer.

- [ ] **Step 4: Implement the state field**

In `src/core/state.ts`, add `activeFormLabel: string | null;` to `TurnState` after `activeForm`, and in `buildTurnState` set `activeFormLabel: session.form ? INTENT_LABELS[session.form] : null,` after `activeForm: session.form,`.

- [ ] **Step 5: Reword the span question**

In `src/domain/slots/memberId.ts`, the `memberIdSpan` instructions become:

```ts
        instructions: 'Read asr.text. Which of these spans is the member ID the caller states? Choose the span that covers the whole number as spoken, including number words like forty-four or three hundred fifty-five and modifiers like double or triple. Choose none if no span is a member ID.',
```

If `src/domain/slots/memberId.test.ts` pins the old wording, update it.

- [ ] **Step 6: Run everything**

Run: `pnpm typecheck` then `pnpm test`.
Expected: green. The fixture stub answers `intentTentative` at the quiet default 0.1 and `intentChange` as `answering` (first label); nothing consumes them yet.

- [ ] **Step 7: Commit**

```bash
git add src/core/questions.ts src/core/questions.test.ts src/core/state.ts src/core/state.test.ts src/domain/slots/memberId.ts src/domain/slots/memberId.test.ts
git commit -m "feat(core): tentative and intent-change questions; reword intelligible and span

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Corpus labels and stub answers

**Files:**
- Modify: `src/jev/corpus.ts`, `src/jev/fixtureStub.ts`
- Test: `src/jev/corpus.test.ts`, `src/jev/fixtureStub.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/jev/corpus.test.ts` inside `describe('parseCorpus', ...)`:

```ts
  it('accepts tentative, change and providerUnsure labels and rejects a bad change', () => {
    const ok = parseCorpus('{"id":"a","text":"maybe","intent":"cancel","context":"no_form","tentative":true}\n{"id":"b","text":"also bill","intent":"billing","context":"reschedule","change":"adding","providerUnsure":true}\n');
    expect(ok[0]?.tentative).toBe(true);
    expect(ok[1]?.change).toBe('adding');
    expect(() => parseCorpus('{"id":"c","text":"x","intent":"cancel","context":"reschedule","change":"swapping"}\n')).toThrow(/change/);
    expect(() => parseCorpus('{"id":"d","text":"x","intent":"cancel","context":"no_form","change":"adding"}\n')).toThrow(/change/);
  });
```

Append to `src/jev/fixtureStub.test.ts` inside `describe('FixtureStubClient', ...)` (follow the file's existing pattern for building a client and asking; it has helpers for a corpus and questions):

```ts
  it('answers the redesign questions from labels', async () => {
    const corpus = parseCorpus('{"id":"t","text":"maybe cancel it","intent":"cancel","context":"no_form","tentative":true}\n{"id":"a","text":"also my bill","intent":"billing","context":"reschedule","change":"adding"}\n{"id":"p","text":"might be kim","intent":"none","context":"cancel","prompted":"provider","slots":{"provider":"kim"},"providerUnsure":true}\n');
    const client = new FixtureStubClient(corpus, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const questions: QuestionMap = {
      intentTentative: { type: 'noul', instructions: '' },
      intentChange: { type: 'choice', instructions: '', criteria: { answering: null, adding: null, replacing: null } },
      providerUnsure: { type: 'noul', instructions: '' },
    };
    const ask = (text: string) => client.ask({ state: { asr: { text, isFinal: true } }, questions });
    expect((await ask('maybe cancel it')).answers.intentTentative).toMatchObject({ noul: 0.9 });
    expect((await ask('also my bill')).answers.intentChange).toMatchObject({ choice: 'adding' });
    expect((await ask('also my bill')).answers.intentTentative).toMatchObject({ noul: 0.05 });
    expect((await ask('maybe cancel it')).answers.intentChange).toMatchObject({ choice: 'answering' });
    expect((await ask('might be kim')).answers.providerUnsure).toMatchObject({ noul: 0.9 });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/jev/corpus.test.ts src/jev/fixtureStub.test.ts`
Expected: FAIL (bad `change` accepted; stub answers quiet defaults).

- [ ] **Step 3: Implement**

In `src/jev/corpus.ts`, add to `CorpusEntry` after `slots?`:

```ts
  /** the caller hedges the request (spec 2026-09-19 §2.1) */
  tentative?: boolean;
  /** in-form only: the utterance adds a task or replaces the current one (§2.2); absent means answering */
  change?: 'adding' | 'replacing';
  /** the caller hedges or names more than one provider (§2.5) */
  providerUnsure?: boolean;
```

In `parseCorpus`, after the `prompted` check add:

```ts
    if (entry.change !== undefined) {
      if (entry.change !== 'adding' && entry.change !== 'replacing') throw new Error(`corpus ${entry.id}: change must be adding or replacing`);
      if (entry.context === 'no_form') throw new Error(`corpus ${entry.id}: change needs a form context`);
    }
```

In `src/jev/fixtureStub.ts` `labeledAnswer`, in the `choice` branch before `if (Object.hasOwn(DATE_IDS, id))` add:

```ts
    if (id === 'intentChange') return choiceAnswer(sharp(labels, entry.change ?? 'answering', sharpness));
```

and in the `noul` branch after `wantsHuman`:

```ts
    if (id === 'intentTentative') return noulAnswer(entry.tentative ? 0.9 : 0.05);
    if (id === 'providerUnsure') return noulAnswer(entry.providerUnsure ? 0.9 : 0.05);
```

- [ ] **Step 4: Run everything**

Run: `pnpm typecheck` then `pnpm test`.
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/jev/corpus.ts src/jev/corpus.test.ts src/jev/fixtureStub.ts src/jev/fixtureStub.test.ts
git commit -m "feat(jev): tentative, change and providerUnsure corpus labels drive the stub

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Gate ladder: tentative routing and intent change

**Files:**
- Modify: `src/core/gates.ts`
- Test: `src/core/gates.test.ts`

- [ ] **Step 1: Write the failing tests**

First confirm in `src/jev/types.ts` that `noulValue(answers, id)` returns `0` when the answer is missing; if it throws instead, add `intentTentative: noul(0.05)` to `baseAnswers` in the test file. Append to `src/core/gates.test.ts` inside `describe('evaluateGates', ...)`:

```ts
  it('routes a tentative request with an explicit confirm even at full probability', () => {
    const r = run(newSession('s', 0), baseAnswers({ intent: choice({ cancel: 0.98, none: 0.02 }), intentTentative: noul(0.9) }));
    expect(r.verdict).toEqual({ kind: 'route', intent: 'cancel', confirm: 'explicit' });
    expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toBe('route_tentative:cancel');
  });

  it('leaves agent and repeat requests alone when tentative', () => {
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ agent: 0.9, none: 0.1 }), intentTentative: noul(0.9) })).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
  });

  describe('inside a form', () => {
    const inForm = () => setForm(newSession('s', 0), 'reschedule');

    it('treats a confident different intent as answering when intentChange says so', () => {
      const r = run(inForm(), baseAnswers({ intent: choice({ billing: 0.95, none: 0.05 }), intentChange: choice({ answering: 0.9, adding: 0.05, replacing: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'proceed' });
      expect(r.rows.find((g) => g.gate === 'intentChange')).toMatchObject({ outcome: 'answering', threshold: 0.6 });
    });

    it('queues an added intent', () => {
      const r = run(inForm(), baseAnswers({ intent: choice({ billing: 0.95, none: 0.05 }), intentChange: choice({ adding: 0.85, answering: 0.1, replacing: 0.05 }) }));
      expect(r.verdict).toEqual({ kind: 'queue', intent: 'billing' });
      expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toBe('queue:billing');
    });

    it('does not queue the active form or a weak intent', () => {
      expect(run(inForm(), baseAnswers({ intent: choice({ reschedule: 0.95, none: 0.05 }), intentChange: choice({ adding: 0.85, answering: 0.1, replacing: 0.05 }) })).verdict).toEqual({ kind: 'proceed' });
      expect(run(inForm(), baseAnswers({ intent: choice({ billing: 0.5, none: 0.5 }), intentChange: choice({ adding: 0.85, answering: 0.1, replacing: 0.05 }) })).verdict).toEqual({ kind: 'proceed' });
    });

    it('switches on replacing, explicitly when tentative', () => {
      const replacing = choice({ replacing: 0.9, answering: 0.05, adding: 0.05 });
      expect(run(inForm(), baseAnswers({ intent: choice({ cancel: 0.95, none: 0.05 }), intentChange: replacing })).verdict).toEqual({ kind: 'route', intent: 'cancel', confirm: 'none' });
      const r = run(inForm(), baseAnswers({ intent: choice({ cancel: 0.95, none: 0.05 }), intentChange: replacing, intentTentative: noul(0.8) }));
      expect(r.verdict).toEqual({ kind: 'route', intent: 'cancel', confirm: 'explicit' });
      expect(r.rows.find((g) => g.gate === 'intent')?.outcome).toBe('switch_tentative:cancel');
    });

    it('falls back to answering below the change threshold', () => {
      expect(run(inForm(), baseAnswers({ intent: choice({ cancel: 0.95, none: 0.05 }), intentChange: choice({ replacing: 0.5, answering: 0.45, adding: 0.05 }) })).verdict).toEqual({ kind: 'proceed' });
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/core/gates.test.ts`
Expected: FAIL (no `queue` verdict, no tentative handling, in-form switches on the intent alone).

- [ ] **Step 3: Implement**

In `src/core/gates.ts` add to `Verdict`:

```ts
  | { kind: 'queue'; intent: FormId }
```

Replace section `// 8. intent` from `let routeVerdict` through the `else { ... }` block with:

```ts
  let routeVerdict: Verdict | null = null;
  let outcome: string;
  const tentative = noulValue(answers, 'intentTentative') >= t.INTENT_TENTATIVE;

  if (activeForm === null) {
    if (label === 'agent' && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'handoff', reason: 'live-agent' }; outcome = 'agent'; }
    else if (label === 'repeat_prompt' && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'replay' }; outcome = 'replay'; }
    else if (isFormIntent(label) && top.p >= t.INTENT_ROUTE) { routeVerdict = { kind: 'route', intent: label, confirm: 'none' }; outcome = 'route'; }
    else if (isFormIntent(label) && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'route', intent: label, confirm: 'implicit' }; outcome = 'route_implicit'; }
    else if (isFormIntent(label) && top.p >= t.INTENT_EXPLICIT) { routeVerdict = { kind: 'route', intent: label, confirm: 'explicit' }; outcome = 'route_explicit'; }
    else { routeVerdict = { kind: 'intent_failed' }; outcome = 'failed'; }
    // A hedged request is confirmed however sure the model is which request it is (spec 2026-09-19 §3.1).
    if (tentative && routeVerdict.kind === 'route' && routeVerdict.confirm !== 'explicit') {
      routeVerdict = { kind: 'route', intent: routeVerdict.intent, confirm: 'explicit' };
      outcome = 'route_tentative';
    }
  } else {
    // Spec 2026-09-19 §3.2: what the utterance does to the current task decides how the intent is used.
    const change = answers.intentChange;
    const [changeTop] = isChoice(change) ? rankProbabilities(change.probabilities) : [];
    const mode = changeTop && changeTop.p >= t.INTENT_CHANGE ? changeTop.label : 'answering';
    rows.push({ gate: 'intentChange', value: changeTop?.p ?? null, threshold: t.INTENT_CHANGE, passed: true, outcome: mode, decided: false });

    if (label === 'agent' && top.p >= t.INTENT_SWITCH) { routeVerdict = { kind: 'handoff', reason: 'live-agent' }; outcome = 'agent'; }
    else if (label === 'repeat_prompt' && top.p >= t.INTENT_SWITCH) { routeVerdict = { kind: 'replay' }; outcome = 'replay'; }
    else if (mode === 'answering') { routeVerdict = { kind: 'proceed' }; outcome = 'answering'; }
    else if (mode === 'adding') {
      if (isFormIntent(label) && label !== activeForm && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'queue', intent: label }; outcome = 'queue'; }
      else { routeVerdict = { kind: 'proceed' }; outcome = 'answering'; }
    }
    else if (isFormIntent(label) && label !== activeForm && top.p >= t.INTENT_SWITCH) { routeVerdict = { kind: 'route', intent: label, confirm: tentative ? 'explicit' : 'none' }; outcome = tentative ? 'switch_tentative' : 'switch'; }
    else if (isFormIntent(label) && label !== activeForm && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'route', intent: label, confirm: 'explicit' }; outcome = 'switch_explicit'; }
    else { routeVerdict = { kind: 'proceed' }; outcome = 'proceed'; }
  }
```

Leave the `intentRow`, the confirmation rescue, the margin gate, and the return unchanged.

- [ ] **Step 4: Run everything**

Run: `pnpm typecheck` then `pnpm test`.
Expected: `turn.ts` fails to typecheck because `handleVerdict`'s switch does not handle `queue`. Add a temporary case there for this task only:

```ts
    case 'queue':
      // Task 8 wires the queue; until then an added intent is treated as answering.
      return handleVerdict(s, { kind: 'proceed' }, answers, ctx, tc);
```

Then green. Existing scenarios still pass: the stub's `intentChange` defaults to `answering` for every entry, so in-form switch scenarios (`intent-switch-mid-form`, `switch-confirm-*`, `wants-human-mid-form`) will FAIL at this point because their utterances are not yet labeled `change: replacing`. Fix that now in `fixtures/corpus.jsonl` (this task's only fixture edit): add `"change":"replacing"` to every corpus entry tagged `intent_switch` or whose scenario switches forms (`sw-01` … `sw-08` except `sw-07`; check with `grep '"context":"' fixtures/corpus.jsonl | grep -v '"intent":"none"'` for in-form entries whose intent is a different form). `pnpm regress` will now show diffs only for those entries' `intentChange` rows (the outcome is unchanged); do not run `--update`.

- [ ] **Step 5: Commit**

```bash
git add src/core/gates.ts src/core/gates.test.ts src/core/turn.ts fixtures/corpus.jsonl
git commit -m "feat(core): tentative requests confirm explicitly; in-form intent change gates switching and queuing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Session queue, two-shape pending confirmation, stashed answers

**Files:**
- Modify: `src/core/session.ts`, `src/core/state.ts`, `src/core/turn.ts`
- Test: `src/core/session.test.ts`, `src/core/state.test.ts`, `src/core/turn.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/core/session.test.ts`:

```ts
  it('starts with nothing queued or completed and clones both', () => {
    const s = newSession('s', 0);
    expect(s.queued).toEqual([]);
    expect(s.completed).toEqual([]);
    s.queued.push('billing');
    s.completed.push('reschedule');
    const c = cloneSession(s);
    c.queued.push('cancel');
    expect(s.queued).toEqual(['billing']);
    expect(c.completed).toEqual(['reschedule']);
  });
```

Append to `src/core/state.test.ts`:

```ts
  it('reports a pending slot confirmation by slot and spoken value', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    s.pendingConfirmation = { target: 'slot', slot: 'memberId', value: '44718293', display: '4471 8293' };
    expect(buildTurnState(s, { text: 'x', isFinal: true, dtmf: null }, 0).pendingConfirmation).toEqual({ target: 'memberId', value: '4471 8293' });
  });
```

Append to `src/core/turn.test.ts` inside `describe('turn', ...)`:

```ts
  it('fills slots from the confirmed utterance, not from the yes', () => {
    const asked = say(started(), 'maybe cancel it with dr chen', {
      intent: choice({ cancel: 0.97, none: 0.03 }), intentTentative: noul(0.9),
      provider: choice({ chen: 0.95, cheng: 0.03, none: 0.02 }),
    });
    expect(asked.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_intent_explicit' });
    expect(asked.session.form).toBeNull();
    const yes = say(asked.session, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02), intent: choice({ none: 0.95, cancel: 0.05 }) });
    expect(yes.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId' });
    expect(yes.session.form).toBe('cancel');
    expect(yes.session.slots.provider.value).toBe('chen');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/core/session.test.ts src/core/state.test.ts src/core/turn.test.ts`
Expected: FAIL / typecheck errors on `queued`, `target: 'slot'`, and the provider not carried.

- [ ] **Step 3: Implement the session**

In `src/core/session.ts`:

```ts
import type { AnswerMap } from '../jev/types';

export type PendingConfirmation =
  | {
      target: 'intent';
      intent: Intent;
      /** the routing utterance's answers and text, so slots it spoke fill once the intent is confirmed (spec 2026-09-19 §3.3) */
      answers: AnswerMap;
      text: string;
    }
  | { target: 'slot'; slot: SlotId; value: string; display: string };
```

Add to `Session` after `pendingConfirmation`:

```ts
  /** intents the caller added mid-form, handled in order after the current form completes */
  queued: FormId[];
  /** forms finished on this call, reported in handoff data */
  completed: FormId[];
```

In `newSession` add `queued: [], completed: [],`. In `cloneSession` add `queued: [...s.queued], completed: [...s.completed],` (the pending confirmation's shallow copy is fine; `answers` is never mutated).

- [ ] **Step 4: Implement the state mapping**

In `src/core/state.ts`, replace the `pendingConfirmation` expression with:

```ts
    pendingConfirmation: session.pendingConfirmation
      ? session.pendingConfirmation.target === 'intent'
        ? { target: 'intent', value: INTENT_LABELS[session.pendingConfirmation.intent] }
        : { target: session.pendingConfirmation.slot, value: session.pendingConfirmation.display }
      : null,
```

- [ ] **Step 5: Implement the stash in turn.ts**

In `src/core/turn.ts` `handleVerdict`:

`case 'route'` explicit branch becomes:

```ts
      if (verdict.confirm === 'explicit') {
        s.pendingConfirmation = { target: 'intent', intent: verdict.intent, answers, text: ctx.text };
        return { decision: prompt('confirm_intent_explicit', 'intent', { intentLabel: INTENT_LABELS[verdict.intent] }, [], ['yes', 'no']), events: [] };
      }
```

`case 'confirmed'` becomes (slot target is filled in by Task 6; for now it falls through to proceed):

```ts
    case 'confirmed': {
      const pc = s.pendingConfirmation!;
      s.pendingConfirmation = null;
      if (pc.target === 'slot') return handleVerdict(s, { kind: 'proceed' }, answers, ctx, tc);
      if (pc.intent === 'agent') return { decision: handoff('live-agent'), events: [] };
      if (!isFormIntent(pc.intent)) return { decision: failAttempt(s, 'intent', t), events: [] };
      // Fill from what the caller originally said, not from the "yes".
      return enterForm(s, pc.intent, 'none', pc.answers, slotContext(s, pc.text, tc));
    }
```

`reaskConfirmation` becomes:

```ts
function reaskConfirmation(s: Session, t: Thresholds): Decision {
  const pc = s.pendingConfirmation!;
  if (pc.target === 'slot') {
    const attempts = ++s.slots[pc.slot].attempts;
    if (retryStep(attempts, t) === 'agent') { s.pendingConfirmation = null; return handoff('max-attempts'); }
    return prompt(`confirm_${pc.slot}`, pc.slot, { [pc.slot]: pc.display }, [], ['yes', 'no']);
  }
  s.intentAttempts += 1;
  if (retryStep(s.intentAttempts, t) === 'agent') {
    s.pendingConfirmation = null;
    return handoff('max-attempts');
  }
  return prompt('confirm_intent_explicit', 'intent', { intentLabel: INTENT_LABELS[pc.intent] }, [], ['yes', 'no']);
}
```

`handleVerdict` receives `tc` already; `slotContext` is in scope.

- [ ] **Step 6: Run everything**

Run: `pnpm typecheck` then `pnpm test`.
Expected: green. The `confirm_memberId` prompt id used by `reaskConfirmation` does not exist in the manifest yet; it is unreachable until Task 6 adds it.

- [ ] **Step 7: Commit**

```bash
git add src/core/session.ts src/core/session.test.ts src/core/state.ts src/core/state.test.ts src/core/turn.ts src/core/turn.test.ts
git commit -m "feat(core): session queue and completed list; slot-shaped confirmation; confirmed intents fill from the original utterance

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Member ID confirmation policy

**Files:**
- Modify: `src/domain/slots/types.ts`, `src/domain/slots/memberId.ts`, `src/domain/slots/provider.ts`, `src/domain/slots/date.ts`, `src/core/fia.ts`, `src/core/turn.ts`, `src/prompts/manifest.json`
- Test: `src/core/fia.test.ts`, `src/core/turn.test.ts`, `src/domain/slots/memberId.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/core/fia.test.ts` (import `pendingSlotConfirmation` from `./fia` and `setForm`, `newSession` from `./session` if not already):

```ts
describe('pendingSlotConfirmation', () => {
  it('names the first filled, unconfirmed always-confirm slot on the form', () => {
    const s = setForm(newSession('s', 0), 'cancel');
    expect(pendingSlotConfirmation(s)).toBeNull();
    s.slots.memberId = { value: '44718293', display: '4471 8293', confirmed: false, attempts: 0, window: null };
    expect(pendingSlotConfirmation(s)).toBe('memberId');
    s.slots.memberId.confirmed = true;
    expect(pendingSlotConfirmation(s)).toBeNull();
    s.slots.provider = { value: 'chen', display: 'Dr. Chen', confirmed: false, attempts: 0, window: null };
    expect(pendingSlotConfirmation(s)).toBeNull();
  });
});
```

Append to `src/core/turn.test.ts` inside `describe('turn', ...)`:

```ts
  describe('member id confirmation', () => {
    const inCancel = () => say(started(), 'cancel my appointment', { intent: choice({ cancel: 0.95, none: 0.05 }) }).session;
    const idAnswers = {
      intent: choice({ none: 0.95, cancel: 0.05 }), intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
      containsMemberId: noul(0.95), memberIdComplete: noul(0.95),
      memberIdSpan: choice({ 'four four seven one eight two nine three': 0.9, none: 0.1 }),
    };

    it('asks the caller to confirm a spoken id instead of acking it', () => {
      const r = say(inCancel(), 'four four seven one eight two nine three', idAnswers);
      expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_memberId', target: 'memberId', options: ['yes', 'no'], acks: [] });
      expect(r.session.slots.memberId).toMatchObject({ value: '44718293', confirmed: false });
      expect(r.session.pendingConfirmation).toEqual({ target: 'slot', slot: 'memberId', value: '44718293', display: '4471 8293' });
    });

    it('confirms on yes and moves to the next slot', () => {
      const asked = say(inCancel(), 'four four seven one eight two nine three', idAnswers);
      const r = say(asked.session, 'yes', { confirmsYes: noul(0.95), confirmsNo: noul(0.02), intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }) });
      expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider' });
      expect(r.session.slots.memberId.confirmed).toBe(true);
      expect(r.session.pendingConfirmation).toBeNull();
    });

    it('sends a declined id straight to the keypad, then hands off if that fails too', () => {
      const asked = say(inCancel(), 'four four seven one eight two nine three', idAnswers);
      const no = say(asked.session, 'no', { confirmsYes: noul(0.02), confirmsNo: noul(0.95), intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }) });
      expect(no.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId_dtmf', target: 'memberId' });
      expect(no.session.slots.memberId.value).toBeNull();
      const again = say(no.session, 'um', { intelligible: noul(0.2) });
      expect(again.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
    });

    it('needs no confirmation for keypad digits', () => {
      const asked = say(inCancel(), 'four four seven one eight two nine three', idAnswers);
      let s = asked.session;
      let r;
      for (const f of dtmfFrames('81793314')) { r = resolve(s, f, null, tc); s = r.session; }
      expect(r!.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider' });
      expect(s.slots.memberId).toMatchObject({ value: '81793314', confirmed: true });
      expect(s.pendingConfirmation).toBeNull();
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/core/fia.test.ts src/core/turn.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the slot policy**

In `src/domain/slots/types.ts`:

```ts
export type SlotOutcome =
  | { kind: 'absent' }
  | { kind: 'filled'; value: string; display: string; confidence: number; confirm: 'none' | 'implicit' | 'explicit' }
  ...
export interface SlotSpec {
  id: SlotId;
  /** always: a spoken fill is read back and must be confirmed before it counts; by-confidence: the fill outcome decides */
  spokenConfirm: 'always' | 'by-confidence';
  ...
```

`memberIdSlot`: add `spokenConfirm: 'always',` and change its `filled` outcome to `confirm: 'explicit'`. `providerSlot` and `dateSlot`: add `spokenConfirm: 'by-confidence',`. Update `src/domain/slots/memberId.test.ts` where it expects `confirm: 'implicit'`.

- [ ] **Step 4: Implement in fia.ts**

`fillSlots` needs no logic change: `confirmed = outcome.confirm === 'none' || keepConfirmed` and only `'implicit'` pushes an ack, so an `'explicit'` fill lands unconfirmed and silent. Add after `nextPrompt`:

```ts
/** The first filled, unconfirmed slot whose policy is always-confirm, or null. */
export function pendingSlotConfirmation(session: Session): SlotId | null {
  for (const id of requiredSlots(session)) {
    const s = session.slots[id];
    if (s.value !== null && !s.confirmed && SLOTS[id].spokenConfirm === 'always') return id;
  }
  return null;
}
```

- [ ] **Step 5: Implement in turn.ts**

Import `pendingSlotConfirmation` from `./fia`. In `continueForm`, between the disambiguation branch and `nextPrompt`:

```ts
  const unconfirmed = pendingSlotConfirmation(s);
  if (unconfirmed) {
    const st = s.slots[unconfirmed];
    s.pendingConfirmation = { target: 'slot', slot: unconfirmed, value: st.value!, display: st.display! };
    return prompt(`confirm_${unconfirmed}`, unconfirmed, { [unconfirmed]: st.display! }, acks, ['yes', 'no']);
  }
```

In `handleVerdict`:

`case 'confirmed'` slot branch replaces the temporary line from Task 5:

```ts
      if (pc.target === 'slot') {
        s.slots[pc.slot].confirmed = true;
        return { decision: continueForm(s, [], null), events: [] };
      }
```

`case 'rejected'` becomes:

```ts
    case 'rejected': {
      const pc = s.pendingConfirmation!;
      s.pendingConfirmation = null;
      if (pc.target === 'slot') {
        // A declined readback means the spoken path failed; go straight to the keypad,
        // and let the next failure hand off.
        const st = s.slots[pc.slot];
        st.value = null; st.display = null; st.confirmed = false;
        st.attempts = Math.max(st.attempts, t.MAX_ATTEMPTS - 1);
        return { decision: prompt(`ask_${pc.slot}_dtmf`, pc.slot), events: [] };
      }
      if (s.form) return { decision: continueForm(s, [], null), events: [] };
      return { decision: failAttempt(s, 'intent', t), events: [] };
    }
```

In `handleDtmf` `case 'filled'`: add `s.pendingConfirmation = null;` before `continueForm`.

- [ ] **Step 6: Add the prompt**

In `src/prompts/manifest.json` after `confirm_intent_explicit`:

```json
  "confirm_memberId": { "text": "Your member ID is {memberId}. Is that right?", "interruptible": false },
```

- [ ] **Step 7: Run everything**

Run: `pnpm typecheck` then `pnpm test`.
Expected: the new tests pass; `src/harness-text/scenarios.test.ts` FAILS for every scenario that speaks a member ID (they now get `confirm_memberId` where they expected the next prompt). That is intended and is fixed in Task 10; to keep the suite green in the meantime, insert `{"say":"yes"}` immediately after every spoken member-ID step in `fixtures/scenarios/core.json` now (`grep -n 'four four seven one eight two nine three\|4471 8293\|forty four seventy' fixtures/scenarios/core.json` lists them; `over-answer-one-turn` and `implicit-ack-spoken` are among them). `implicit-ack-spoken`'s expectation becomes `{"decision":"prompt","promptId":"confirm_memberId","form":"reschedule","text":"Your member ID is 4471 8293"}` with no `yes` step. Also add `"yes"` to the corpus if it is not already an entry (it is, from the confirmation scenarios). `pnpm regress` diffs but is not updated.

- [ ] **Step 8: Commit**

```bash
git add src/domain/slots src/core/fia.ts src/core/fia.test.ts src/core/turn.ts src/core/turn.test.ts src/prompts/manifest.json fixtures/scenarios/core.json
git commit -m "feat(core): spoken member ids are read back and confirmed; declined readbacks go to the keypad

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Provider hedging

**Files:**
- Modify: `src/domain/slots/provider.ts`
- Test: `src/domain/slots/provider.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/domain/slots/provider.test.ts`, change the first test to expect two questions:

```ts
  it('asks the roster choice plus an unsure question', () => {
    const q = providerSlot.questions(ctx);
    expect(q.provider?.type).toBe('choice');
    if (q.provider?.type === 'choice') expect(Object.keys(q.provider.criteria)).toEqual(['chen', 'cheng', 'patel', 'okafor', 'nguyen', 'rossi', 'kim', 'alvarez', 'none']);
    expect(q.providerUnsure).toMatchObject({ type: 'noul' });
  });
```

and append (import `noul` from the answers helper):

```ts
  it('confirms implicitly when the caller is unsure, whatever the probability', () => {
    expect(providerSlot.fill({ provider: choice({ kim: 0.98, none: 0.02 }), providerUnsure: noul(0.9) }, ctx))
      .toMatchObject({ kind: 'filled', value: 'kim', confirm: 'implicit' });
  });

  it('disambiguates when the caller is unsure between two named providers', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.5, cheng: 0.46, none: 0.04 }), providerUnsure: noul(0.9) }, ctx))
      .toMatchObject({ kind: 'disambiguate', a: { value: 'chen' }, b: { value: 'cheng' } });
    expect(providerSlot.fill({ provider: choice({ chen: 0.8, cheng: 0.15, none: 0.05 }), providerUnsure: noul(0.9) }, ctx))
      .toMatchObject({ kind: 'filled', value: 'chen', confirm: 'implicit' });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/domain/slots/provider.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/domain/slots/provider.ts` import `noulValue` from `../../jev/types`. `questions()` returns, in addition to `provider`:

```ts
      providerUnsure: {
        type: 'noul',
        instructions: 'Read asr.text. Is the caller unsure which provider they mean, for example by hedging with might be, I think, or not sure, or by naming more than one provider?',
      },
```

`fill` becomes:

```ts
  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    const a = answers.provider;
    if (!isChoice(a)) return { kind: 'absent' };
    const [top, second] = rankProbabilities(a.probabilities);
    if (!top || top.label === 'none' || top.p < t.SLOT_CHOICE_CONFIRM) return { kind: 'absent' };
    const unsure = noulValue(answers, 'providerUnsure') >= t.PROVIDER_UNSURE;
    const twoNamed = second !== undefined && second.label !== 'none'
      && (top.p - second.p < t.SLOT_CHOICE_MARGIN || (unsure && second.p >= t.SLOT_CHOICE_CONFIRM));
    if (twoNamed) {
      return {
        kind: 'disambiguate',
        a: { value: top.label, display: providerDisplay(top.label) },
        b: { value: second!.label, display: providerDisplay(second!.label) },
      };
    }
    return {
      kind: 'filled',
      value: top.label,
      display: providerDisplay(top.label),
      confidence: top.p,
      // A hedged name is read back however sure the model is which name it was (spec 2026-09-19 §5.3).
      confirm: !unsure && top.p >= t.SLOT_CHOICE_FILL ? 'none' : 'implicit',
    };
  },
```

- [ ] **Step 4: Run everything**

Run: `pnpm typecheck` then `pnpm test`. Expected: green (the stub's quiet `providerUnsure` is 0.05).

- [ ] **Step 5: Commit**

```bash
git add src/domain/slots/provider.ts src/domain/slots/provider.test.ts
git commit -m "feat(slots): hedged or dual provider names are read back or disambiguated

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Queue and chain; acks through completion and handoff

**Files:**
- Modify: `src/core/decision.ts`, `src/core/turn.ts`, `src/channel/frames.ts`, `src/prompts/render.ts`, `src/prompts/manifest.json`, `src/harness-text/runner.ts`
- Test: `src/core/turn.test.ts`, `src/prompts/render.test.ts`, `src/channel/frames.test.ts` (if present, else in render.test), `src/server/adapter.test.ts`, `src/server/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/prompts/render.test.ts`:

```ts
describe('completion and chaining', () => {
  it('no completion prompt ends the call by itself', () => {
    for (const spec of Object.values(FORMS)) {
      if (spec.completion.kind === 'prompt') expect(promptEntry(spec.completion.promptId).text).not.toMatch(/goodbye/i);
    }
  });

  it('speaks acks, the completion, then goodbye, then ends', () => {
    const frames = decisionToFrames({ kind: 'complete', form: 'cancel', promptId: 'cancel_confirmed', vars: { memberId: '4471 8293', provider: 'Dr. Kim' }, acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Kim' } }], completed: ['cancel'] });
    expect(frames.map((f) => (f.type === 'text' ? f.token : f.type))).toEqual(['With Dr. Kim.', promptText('cancel_confirmed', { memberId: '4471 8293', provider: 'Dr. Kim' }), 'Goodbye.', 'end']);
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed","completed":["cancel"]}' });
  });

  it('speaks acks before a handoff and reports completed forms', () => {
    const frames = decisionToFrames({ kind: 'handoff', reason: 'billing', promptId: 'handoff_billing', acks: [{ promptId: 'bridge_next', vars: { intentLabel: 'ask about billing' } }], completed: ['reschedule'] });
    expect(frames.map((f) => (f.type === 'text' ? f.token : f.type))).toEqual(['Now, ask about billing.', 'Connecting you to billing now.', 'end']);
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"billing","completed":["reschedule"]}' });
  });
});
```

Update the existing `'ends the call after a handoff prompt'` test's decision to include `acks: [], completed: []` and keep its expected `'{"reasonCode":"billing"}'` (no `completed` key when empty).

Append to `src/core/turn.test.ts` inside `describe('turn', ...)`:

```ts
  it('queues an added intent, acks it, re-asks the current slot without counting an attempt, and chains after completion', () => {
    const routed = say(started(), 'reschedule with dr chen next tuesday', {
      intent: choice({ reschedule: 0.95, none: 0.05 }), provider: choice({ chen: 0.95, none: 0.05 }),
      dateMode: choice({ weekday: 0.9, none: 0.1 }), dateWeekday: choice({ tuesday: 0.95, none: 0.05 }), dateWeekdayQualifier: choice({ next: 0.9, none: 0.1 }),
    });
    expect(routed.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId' });
    const added = say(routed.session, 'and can i also ask about my bill', {
      intent: choice({ billing: 0.95, none: 0.05 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }),
    });
    expect(added.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_memberId', acks: [{ promptId: 'ack_queued', vars: { intentLabel: 'ask about billing' } }] });
    expect(added.session.queued).toEqual(['billing']);
    expect(added.session.slots.memberId.attempts).toBe(0);
    let s = added.session;
    let r;
    for (const f of dtmfFrames('44718293')) { r = resolve(s, f, null, tc); s = r.session; }
    expect(r!.decision).toMatchObject({
      kind: 'handoff', reason: 'billing', completed: ['reschedule'],
      acks: [{ promptId: 'reschedule_confirmed' }, { promptId: 'bridge_next', vars: { intentLabel: 'ask about billing' } }],
    });
    expect(s.completed).toEqual(['reschedule']);
    expect(s.ended).toBe(true);
  });

  it('chains into a slot form with the member id carried over and the rest cleared', () => {
    const routed = say(started(), 'cancel with dr chen', { intent: choice({ cancel: 0.95, none: 0.05 }), provider: choice({ chen: 0.95, none: 0.05 }) });
    const added = say(routed.session, 'also book a new one', { intent: choice({ schedule_new: 0.95, none: 0.05 }), intentChange: choice({ adding: 0.9, answering: 0.05, replacing: 0.05 }) });
    let s = added.session;
    let r;
    for (const f of dtmfFrames('44718293')) { r = resolve(s, f, null, tc); s = r.session; }
    expect(r!.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider', acks: [{ promptId: 'cancel_confirmed' }, { promptId: 'bridge_next' }] });
    expect(s.form).toBe('schedule_new');
    expect(s.slots.memberId).toMatchObject({ value: '44718293', confirmed: true });
    expect(s.slots.provider.value).toBeNull();
    expect(s.completed).toEqual(['cancel']);
    expect(s.queued).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/prompts/render.test.ts src/core/turn.test.ts`
Expected: FAIL / typecheck errors.

- [ ] **Step 3: Decisions and frames**

`src/core/decision.ts`:

```ts
export type Decision =
  | { kind: 'ignore' }
  | { kind: 'hold' }
  | PromptDecision
  | { kind: 'complete'; form: FormId; promptId: string; vars: Record<string, string>; acks: Ack[]; completed: FormId[] }
  | { kind: 'handoff'; reason: string; promptId: string; acks: Ack[]; completed: FormId[] }
  | { kind: 'replay'; text: string };
```

`src/channel/frames.ts`:

```ts
export function endFrame(reasonCode: string, completed: readonly string[] = []): EndFrame {
  return { type: 'end', handoffData: JSON.stringify(completed.length ? { reasonCode, completed } : { reasonCode }) };
}
```

- [ ] **Step 4: Prompts and render**

`src/prompts/manifest.json`: strip ` Goodbye.` from `schedule_confirmed`, `reschedule_confirmed`, `cancel_confirmed`, `appointment_details`, and add:

```json
  "goodbye": { "text": "Goodbye.", "interruptible": false },
  "ack_queued": { "text": "Sure, we'll get to that after this: {intentLabel}.", "interruptible": false },
  "bridge_next": { "text": "Now, {intentLabel}.", "interruptible": false },
```

Deviation: `ack_queued` wording puts the label at the end so it sits at a clause boundary for later audio splicing.

`src/prompts/render.ts` `decisionToFrames`:

```ts
    case 'complete':
      return [
        ...decision.acks.map((a) => textFrame(promptText(a.promptId, a.vars), false)),
        textFrame(promptText(decision.promptId, decision.vars), false),
        textFrame(promptText('goodbye', {}), false),
        endFrame('completed', decision.completed),
      ];
    case 'handoff':
      return [
        ...decision.acks.map((a) => textFrame(promptText(a.promptId, a.vars), false)),
        textFrame(promptText(decision.promptId, {}), false),
        endFrame(decision.reason, decision.completed),
      ];
```

`spokenText`:

```ts
    case 'complete':
      return [...decision.acks.map((a) => promptText(a.promptId, a.vars)), promptText(decision.promptId, decision.vars), promptText('goodbye', {})].join(' ');
    case 'handoff':
      return [...decision.acks.map((a) => promptText(a.promptId, a.vars)), promptText(decision.promptId, {})].join(' ');
```

- [ ] **Step 5: turn.ts**

Replace `handoff` and `completeForm`, and change `continueForm` to pass acks into completion:

```ts
function handoff(s: Session, reason: string, acks: Ack[] = []): Decision {
  return { kind: 'handoff', reason, promptId: handoffPromptId(reason), acks, completed: [...s.completed] };
}

/** Close the form: end the call, or bridge into the next queued intent with the member id carried over. */
function completeForm(s: Session, form: FormId, acks: Ack[]): Decision {
  const completion = FORMS[form].completion;
  if (completion.kind === 'handoff') return handoff(s, completion.reason, acks);
  const vars: Record<string, string> = {};
  for (const id of Object.keys(s.slots) as SlotId[]) vars[id] = s.slots[id].display ?? '';
  s.completed.push(form);
  const next = s.queued.shift();
  if (!next) return { kind: 'complete', form, promptId: completion.promptId, vars, acks, completed: [...s.completed] };
  s.slots.provider = emptySlot();
  s.slots.date = emptySlot();
  setForm(s, next);
  return continueForm(s, [...acks, { promptId: completion.promptId, vars }, { promptId: 'bridge_next', vars: { intentLabel: INTENT_LABELS[next] } }], null);
}
```

Import `emptySlot` from `./session`. Every existing `handoff('x')` call becomes `handoff(s, 'x')`. In `continueForm`, `if (next.kind === 'complete') return completeForm(s, s.form!, acks);`.

Add the real `queue` case to `handleVerdict`, replacing Task 4's placeholder:

```ts
    case 'queue': {
      if (verdict.intent !== s.form && !s.queued.includes(verdict.intent)) s.queued.push(verdict.intent);
      const ack: Ack = { promptId: 'ack_queued', vars: { intentLabel: INTENT_LABELS[verdict.intent] } };
      const fill = fillSlots(s, answers, ctx, slotsFor(s.form!));
      // Adding a request is not a failed answer: re-ask the open slot without counting an attempt.
      return { decision: continueForm(s, [ack, ...fill.acks], fill.disambiguate), events: fill.events };
    }
```

Note the billing form completes with a handoff, so a chained billing intent whose only slot (`memberId`) is carried over completes in the same turn and the handoff carries the bridge ack; the first new test pins this.

- [ ] **Step 6: Outcome**

In `src/harness-text/runner.ts`, add `queued: string[];` to `Outcome` after `slots`, and `queued: [...result.session.queued],` in `outcomeOf`. Also change the `acks` line in `outcomeOf` to `acks: 'acks' in d ? d.acks.map((a) => a.promptId) : [],` so acks spoken before a completion or handoff show in the regression diff.

- [ ] **Step 7: Server tests**

`src/server/adapter.test.ts` and `src/server/server.test.ts` pin the last spoken text of a completed call as `'For member ID 4 4 7 1, 8 2 9 3, your appointment ... Goodbye.'`. Now the completion line has no `Goodbye.` and a separate `'Goodbye.'` frame follows. Change each such assertion to check `texts(...).at(-1)` is `'Goodbye.'` and `texts(...).at(-2)` is the completion line without ` Goodbye.`. Do not modify `src/server/*.ts` sources.

- [ ] **Step 8: Run everything**

Run: `pnpm typecheck` then `pnpm test`.
Expected: green. Any scenario in `core.json` whose `expect.text` included `Goodbye` must drop it. `pnpm regress` diffs (new `queued` key, acks on completion) but is not updated yet.

- [ ] **Step 9: Commit**

```bash
git add src/core/decision.ts src/core/turn.ts src/core/turn.test.ts src/channel/frames.ts src/prompts/render.ts src/prompts/render.test.ts src/prompts/manifest.json src/harness-text/runner.ts src/server/adapter.test.ts src/server/server.test.ts fixtures/scenarios/core.json
git commit -m "feat(core): queue added intents and chain forms; acks reach completion and handoff; goodbye is its own prompt

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Corpus relabels and new entries

**Files:**
- Modify: `fixtures/corpus.jsonl`
- Test: `pnpm test` (corpus and scenarios tests) and `pnpm regress` (diff only)

- [ ] **Step 1: Relabel existing entries**

Edit these lines in place (whole-line replacements; keep other fields as they are unless listed):

- `lc-01`: `"intent":"other"`, delete `answers`, `"tags":["vague"]`.
- `lc-02`: delete `answers`, `"tags":["implicit_confirm"]`.
- `lc-03`: delete `answers`, add `"tentative":true`, `"tags":["tentative"]`.
- `lc-04`: delete `answers`, add `"tentative":true`, `"tags":["tentative","two_intents"]`.
- `lc-05`: `"intent":"other"`, delete `answers`, `"tags":["vague"]`.
- `lc-06`: `"intent":"none"`, delete `answers`, add `"providerUnsure":true`, `"tags":["provider_unsure"]`.
- `lc-07`: delete `answers`, `"tags":[]`.
- `lc-08`: delete `answers`, `"tags":[]`.
- `lc-09`: delete `answers`, `"tags":[]`.
- `lc-10`: delete `answers`, add `"tentative":true`, `"tags":["tentative"]`.
- `lc-11`: delete `answers`, add `"providerUnsure":true`, `"tags":["provider_unsure"]`.
- `lc-12`: delete `answers`, add `"providerUnsure":true`, `"tags":["provider_unsure"]`.
- `sw-07`: `"intent":"billing"`, delete `answers`, add `"change":"adding"`, `"tags":["adding"]`.
- `sw-08`: delete `answers`, add `"tentative":true` (it already has `"change":"replacing"` from Task 4), `"tags":["intent_switch","tentative"]`.

Deviation from spec §7.1: `lc-12` in the cancel form fills its last slot, so its expected outcome is a completion with the provider ack spoken first, not a bare ack.

- [ ] **Step 2: Add entries**

Append (each on its own line):

```
{"id":"mi-11","text":"forty four one eighty seven three hundred fifty five","intent":"none","context":"schedule_new","slots":{"memberId":{"span":"forty four one eighty seven three hundred fifty five","value":"44187355"}},"tags":["chunked_numbers"]}
{"id":"mi-12","text":"four four one eight seven three hundred five","intent":"none","context":"cancel","slots":{"memberId":{"span":"four four one eight seven three hundred five","value":"44187305"}},"tags":["chunked_numbers"]}
{"id":"mi-13","text":"my ID is 44 187 355","intent":"none","context":"reschedule","slots":{"memberId":{"span":"44 187 355","value":"44187355"}},"tags":["digit_groups"]}
{"id":"mi-14","text":"8 1 7 9 3 3 1 4","intent":"none","context":"reschedule","slots":{"memberId":{"span":"8 1 7 9 3 3 1 4","value":"81793314"}},"tags":["digit_string"]}
{"id":"sw-09","text":"and can I also check on a bill I got","intent":"billing","context":"cancel","prompted":"provider","change":"adding","tags":["adding"]}
{"id":"sw-10","text":"also I want to make another appointment while I'm on","intent":"schedule_new","context":"cancel","prompted":"memberId","change":"adding","tags":["adding"]}
{"id":"sw-11","text":"never mind, I have a question about my bill","intent":"billing","context":"reschedule","prompted":"memberId","change":"replacing","tags":["replacing"]}
{"id":"sw-12","text":"actually forget the reschedule, just cancel it","intent":"cancel","context":"reschedule","prompted":"date","change":"replacing","tags":["replacing"]}
{"id":"pv-01","text":"I think it's Dr. Patel","intent":"none","context":"schedule_new","prompted":"provider","slots":{"provider":"patel"},"providerUnsure":true,"tags":["provider_unsure"]}
{"id":"pv-02","text":"either Dr. Chen or Dr. Cheng, I'm not sure which","intent":"none","context":"reschedule","prompted":"provider","slots":{"provider":"chen"},"providerUnsure":true,"answers":{"provider":{"probabilities":{"chen":0.48,"cheng":0.46}}},"tags":["provider_unsure","two_providers"]}
{"id":"lc-13","text":"Maybe cancel it, it's with Dr. Chen","intent":"cancel","context":"no_form","slots":{"provider":"chen"},"tentative":true,"tags":["tentative","over_answer"]}
{"id":"fr-05","text":"This is ridiculous, I already said Dr. Chen three times","intent":"none","context":"reschedule","prompted":"provider","slots":{"provider":"chen"},"answers":{"frustration":{"probabilities":{"high":0.8,"mild":0.15}}},"tags":["frustration_high"]}
```

If an id above already exists, use the next free number in that prefix and report it. `pv-02` keeps a `provider` override because the stub cannot derive a two-way split from a single label.

- [ ] **Step 3: Verify**

Run: `pnpm test` (the corpus test parses the file; `scenarios.test.ts` may fail for scenarios whose premise changed, which Task 10 rewrites; report which) and `pnpm regress` (report the diff lines; do not `--update`).

- [ ] **Step 4: Commit**

```bash
git add fixtures/corpus.jsonl
git commit -m "fixtures(corpus): relabel hedged and vague entries; add chunked ids, adding, replacing and unsure-provider utterances

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Scenarios and the re-recorded baseline

**Files:**
- Modify: `fixtures/scenarios/core.json`, `fixtures/expected/corpus.json`, `fixtures/expected/scenarios.json`

- [ ] **Step 1: Rewrite scenarios**

In `fixtures/scenarios/core.json`:

- Replace `disambiguate-intent` with:
  `{"id":"tentative-two-intents","steps":[{"say":"I think I need to reschedule or maybe cancel"}],"expect":{"decision":"prompt","promptId":"confirm_intent_explicit","form":null}}`
- Replace `frustration-escalation`'s third step with `{"say":"This is ridiculous, I already said Dr. Chen three times"}`; expectation unchanged (`handoff`, `frustrated`, form `reschedule`). Its second step (`four four seven one, that's it`) is an invalid id and stays.
- `explicit-confirm-yes`, `explicit-confirm-no`, `confirm-unanswered-reask`, `confirm-unanswered-to-agent`, `switch-confirm-yes-mid-form`, `switch-confirm-no-resumes-form`: steps and expectations unchanged; they now reach the explicit confirm via `tentative`.
- `intent-switch-mid-form` and `wants-human-mid-form`: unchanged.
- Any scenario whose `expect.text` contains `Goodbye` drops that text or replaces it with the completion line.

Append these scenarios:

```json
{"id":"add-intent-chained","steps":[{"say":"I need to reschedule my appointment, it's with Dr. Chen sometime next week"},{"say":"four four seven one eight two nine three"},{"say":"yes"},{"say":"and can I also ask about my bill"},{"say":"Tuesday"}],"expect":{"decision":"handoff","reason":"billing","form":"billing","text":"Now, ask about billing."}},
{"id":"replace-intent-mid-form","steps":[{"say":"I need to reschedule my appointment"},{"say":"never mind, I have a question about my bill"}],"expect":{"decision":"prompt","promptId":"ask_memberId","form":"billing"}},
{"id":"replace-intent-keeps-date-slot-form","steps":[{"say":"I need to reschedule my appointment, it's with Dr. Chen sometime next week"},{"dtmf":"44718293"},{"say":"actually forget the reschedule, just cancel it"}],"expect":{"decision":"complete","promptId":"cancel_confirmed","form":"cancel","slots":{"memberId":"44718293","provider":"chen"}}},
{"id":"memberId-confirm-yes","steps":[{"say":"Cancel my appointment"},{"say":"four four seven one eight two nine three"},{"say":"yes"}],"expect":{"decision":"prompt","promptId":"ask_provider","form":"cancel","slots":{"memberId":"44718293"}}},
{"id":"memberId-confirm-no-to-keypad","steps":[{"say":"Cancel my appointment"},{"say":"four four seven one eight two nine three"},{"say":"no"},{"dtmf":"44718293"}],"expect":{"decision":"prompt","promptId":"ask_provider","form":"cancel","slots":{"memberId":"44718293"}}},
{"id":"chunked-memberId","steps":[{"say":"Cancel my appointment"},{"say":"forty four one eighty seven three hundred fifty five"}],"expect":{"decision":"prompt","promptId":"confirm_memberId","form":"cancel","slots":{"memberId":"44187355"},"text":"4418 7355"}},
{"id":"digit-string-memberId","steps":[{"say":"Cancel my appointment"},{"say":"8 1 7 9 3 3 1 4"}],"expect":{"decision":"prompt","promptId":"confirm_memberId","form":"cancel","slots":{"memberId":"81793314"}}},
{"id":"hedged-provider-implicit","steps":[{"say":"Cancel my appointment"},{"dtmf":"44718293"},{"say":"It might be Dr. Kim"}],"expect":{"decision":"complete","promptId":"cancel_confirmed","form":"cancel","slots":{"memberId":"44718293","provider":"kim"},"text":"With Dr. Kim."}},
{"id":"hedged-two-providers-disambiguate","steps":[{"say":"I need to reschedule my appointment"},{"dtmf":"44718293"},{"say":"either Dr. Chen or Dr. Cheng, I'm not sure which"}],"expect":{"decision":"prompt","promptId":"disambiguate_provider","form":"reschedule"}},
{"id":"tentative-carries-slots","steps":[{"say":"Maybe cancel it, it's with Dr. Chen"},{"say":"yes"}],"expect":{"decision":"prompt","promptId":"ask_memberId","form":"cancel","slots":{"provider":"chen"}}}
```

`replace-intent-keeps-date-slot-form`: on a silent switch the new form is entered with `enterForm`, which keeps already-filled slots the new form shares (memberId, provider) and completes cancel immediately; confirm this matches `enterForm`'s behavior and, if `enterForm` clears slots, change the expectation to `ask_provider` and report the deviation.

- [ ] **Step 2: Run the suite**

Run: `pnpm test`. Expected: every scenario passes, including the rewritten ones. Fix scenario JSON, never core code, unless a genuine bug surfaces; report it as a deviation if so. Also run `pnpm vitest run src/harness-text/scenarios.test.ts` alone and confirm the "only says things that are in the corpus" test passes (every new step text is a corpus entry).

- [ ] **Step 3: Review the diff, then re-record the baseline**

Run: `pnpm regress` and paste the full diff into your report. Every line must be explainable by one of: a `queued` key on every outcome; `confirm_memberId` where a spoken id used to ack; `route_tentative`/`switch_tentative` decided gates on the tentative entries; the relabels in Task 9; `answering` proceed on in-form entries; acks on completions. Anything else is a bug: stop and report it.

Then: `pnpm regress --update` and `pnpm regress` (expect `no changes`).

- [ ] **Step 4: Commit**

```bash
git add fixtures/scenarios/core.json fixtures/expected/corpus.json fixtures/expected/scenarios.json
git commit -m "fixtures: scenarios for tentative, adding, replacing, hedged providers and id confirmation; re-record the label baseline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: README and plan record

**Files:**
- Modify: `README.md`, this plan

- [ ] **Step 1: README**

In the Regression section, after the paragraph beginning "The baseline in `fixtures/expected/`", add:

```markdown
Corpus entries carry four kinds of label the stub answers from: the intent
and slots, `tentative` (the caller hedges, so the request is confirmed
explicitly), `change` (`adding` or `replacing`, for an in-form utterance
that asks for another task), and `providerUnsure` (a hedged or dual provider
name is read back). An entry with none of the last three is a plain,
committed answer to the current question.
```

Under `## Phone line (Twilio ConversationRelay)`, before `### Live-call checklist`, add:

```markdown
### Confirmation and multi-intent

A hedged request ("maybe cancel it") is confirmed before anything happens:
"Just to check, do you want to cancel an appointment?" A spoken member ID
is always read back, "Your member ID is 4471 8293. Is that right?", and a
"no" goes straight to the keypad; digits typed on the keypad need no
readback. A request added mid-task ("can I also ask about my bill") is
acknowledged and queued: the current task finishes, its summary is spoken
without a goodbye, and the call moves on with "Now, ask about billing."
The member ID carries over; provider and date are asked again. "Never mind,
I have a question about my bill" replaces the current task instead. Handoff
data on the `end` frame lists the forms completed on the call.
```

- [ ] **Step 2: Record deviations**

Append a "Deviations recorded during execution" section to this plan listing every "Deviation:" note the tasks produced, in the format of the previous plans.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/plans/2026-09-19-question-redesign.md
git commit -m "docs: labels, confirmation and multi-intent behaviour; record plan deviations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12 (Jason, not an agent): re-record the cassette

Every changed question re-keys its requests, so the whole corpus is live again; the old cassette was removed from the branch (a replay against it missed on all 252 turns), so the record run starts from an empty file. From the repo root, with the branch checked out. Prove the key first with one utterance in `pnpm cli --client jev`, then:

```bash
set -a; source .env; set +a; pnpm regress --client record --threshold JEV_TIMEOUT_MS=15000
```

Expected: roughly 250 live requests, a few cents, and a diff against the new label baseline. Then `pnpm regress --client recorded` reproduces it offline with no misses. Commit the cassette:

```bash
git add fixtures/recorded/jev-1.13.0.jsonl
git commit -m "fixtures: re-record jev-1.13.0 answers for the redesigned questions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

The remaining diff is the input to the threshold-sweep sub-project. If `frustration-escalation` still fails because the model rates the new utterance below `high` 0.6, that is a sweep-time finding, not a reason to edit the scenario now.

---

## Self-review

- §2 questions: Tasks 2, 7. §3 routing and stash: Tasks 4, 5. §4 queue and chain, handoff data, outcome: Task 8. §5 slot confirmation: Task 6; hedging: Task 7. §6 numbers: Task 1. §7 labels and scenarios: Tasks 3, 9, 10. §8 thresholds: Task 1. §9 prompts: Tasks 6, 8. §10 tests: each task; baseline: Task 10; cassette: Task 12. §11 README: Task 11.
- Names used across tasks: `intentTentative`, `intentChange`, `providerUnsure`, `activeFormLabel`, `queued`, `completed`, `PendingConfirmation` (`target: 'slot'` with `slot`, `value`, `display`), `pendingSlotConfirmation`, `spokenConfirm`, `confirm: 'explicit'`, `handoff(s, reason, acks)`, `completeForm(s, form, acks)`, `endFrame(reason, completed)`, prompts `confirm_memberId`, `goodbye`, `ack_queued`, `bridge_next`. All defined before use.
- Suite stays green after every task by construction (quiet stub defaults; Task 4 and Task 6 carry the fixture edits their behavior change forces).

## Deviations recorded during execution

- **Task 1.** The converter was restructured to a parts-and-group representation (a running group of a total plus a small part, plus a list of already-closed parts) so thousands compose with a trailing hundreds group and a spoken zero after a multiplier starts its own digit instead of folding into the group; this restructure also removed the TypeScript narrowing workaround the first pass needed. `MULTIPLIER_WORDS` is exported so `hundred`/`thousand` alone, with no other number word, cannot qualify a candidate span on their own. The heuristic stub's member-ID guess now prefers the candidate span with the most number-bearing tokens (fewest filler tokens breaking the tie), so a truncated prefix of a chunked number cannot beat the full span.
- **Task 2.** The turn state gained a top-level `activeFormLabel` field rather than reshaping `activeForm` into an object with a `.label`, since `activeForm` is a plain form-id string read elsewhere. Question wording moved past the spec draft after review: `intentTentative` dropped "or maybe instead" and gained might/I am not sure phrasing plus `true`/`false` criteria that separate a hedge about the request from a hedge about a detail; `intelligible` became a direct judgment with criteria so filler alone does not pass; `intentChange`'s `answering` criterion was reworded as the catch-all; the span question tells the model not to include words that are not part of the number. The question map is pinned by two snapshots (in-form and no-form) because the cassette key hashes the whole map, so any further wording change re-keys deliberately. The `sw-07` `intentSecondary` override was removed here because that question no longer exists.
- **Task 3.** The corpus parser rejects unknown fields, a non-boolean `tentative`/`providerUnsure`, a `change` label outside `adding`/`replacing`, a `change` on intent `none`, and a labeled slot that is not on the entry's context form. `sharp()` throws on an unrecognized winner label rather than silently defaulting. Quiet defaults for the two new nouls live alongside the existing ones in `QUIET_NOUL`. The `parseCorpus` tests were consolidated into a single `corpus.test.ts` rather than split across files.
- **Task 4.** The unanswered-confirmation rescue was extended to also catch a `queue` verdict, so an added intent during a pending confirmation is not lost. The in-form chain gained an explicit `replacing` branch and a closing `else`, so an intent-change label the model does not recognize proceeds as `answering` rather than being treated as a switch. `other` was hoisted to a shared constant. The `intentChange` gate row's `passed` field reflects whether the label cleared its own threshold, with a `:below` suffix on the outcome when it did not. Two new outcomes, `add_unused` (an `adding` verdict whose target intent is unusable) and `replace_unresolved` (a `replacing` verdict that resolves to nothing), keep those cases visible in the trace instead of collapsing into a generic `proceed`. `intentTentative` gets its own informational gate row. `sw-01`, `sw-02`, and `sw-08` were labeled `change: replacing` so their switch scenarios kept passing once the in-form gate started reading the label.
- **Task 5.** The stashed intent-confirmation answers are typed read-only (`Readonly<AnswerMap>`) and shared by reference across session clones rather than deep-copied, since they are never mutated after the routing turn. The model-facing `pendingConfirmation.target` was narrowed from a free-form string to `'intent' | SlotId` so an invalid target cannot leak to the question schema. A negative-case test pins that the confirmation turn's own slot answers (a caller saying "yes, Dr. Chen") are ignored. The stash is complete only for a route that happened outside a form; a mid-form switch stashes the old form's slot answers and the new form's other slots are asked normally.
- **Task 6.** The design's `explicit` confirm outcome was dropped in favor of one policy field, `spokenConfirm`, which `fillSlots` consults directly rather than branching on a third `SlotOutcome` variant; `pendingSlotConfirmation` returns the confirmation object itself, not just the slot id. A second decline following a fresh spoken ID hands off instead of spending a third spoken attempt, and an unanswered readback was folded into the same retry ladder as a decline (re-ask, then keypad, then handoff) rather than a separate unanswered-confirmation policy. `ack_declined` ("Sorry about that.") is spoken before the keypad prompt that follows a decline. Any switch away from an active form now always speaks `ack_intent`, whatever the route's confidence. The runner, replay, adapter, and server test suites all gained a confirming turn after a spoken member ID.
- **Task 7.** `providerUnsure`'s wording was reworked with explicit criteria so a caller who corrects themselves between two provider names is not read as "unsure." The second disambiguation clause (unsure plus a runner-up at or above `SLOT_CHOICE_CONFIRM`) is unreachable while probabilities are normalized and the current thresholds hold; it is kept and annotated in the code rather than removed, in case a later sweep makes it live. "Chen or Cheng, I'm not sure" therefore yields an implicit readback of the model's top pick, not a disambiguation, when the model does not actually split the probability mass between the two names. Span-based two-name detection (parsing "Chen or Cheng" directly out of the text) was deferred rather than built now.
- **Task 8.** Entering a form removes it from the queue, so a switch into an intent that was also queued does not run it a second time later. Handoff-completion intents in the queue always run last, after every prompt-completion intent, and the handoff data now also carries `queued` (intents the caller added that the call never reached). Adding a request during a readback does not count as an unanswered attempt against the retry ladder. When the intent being bridged into arrived as an `ack_queued` on the very turn that completes the current form, that ack is dropped from the completion line so the caller does not hear the same intent named twice in a row. The shipped `ack_queued` wording is "Sure, we'll {intentLabel} after this." `CompleteDecision` and `HandoffDecision` were named and exported as their own types. The switch path (replacing) keeps provider and date on the new form while the queue/chain path clears them, deliberately: a replacement refers to the same appointment, an addition to a different one.
- **Task 9.** New corpus ids were renumbered to avoid collisions with entries already in the file (landing as `mi-13`..`mi-16`, `pv-09`, `pv-10`, `fr-07` rather than the plan's placeholder numbers). `lc-05`'s `other` label rests on a weak real-model plurality and may be revisited once the threshold sweep runs.
- **Task 10.** The rewritten scenario file holds 45 scenarios. The silent-switch scenario was named `replace-intent-keeps-same-appointment` rather than the plan's placeholder name. The 301-line pre-update `pnpm regress` diff was classified line by line against the expected categories (queued keys, `confirm_memberId` readbacks, tentative/switch gate outcomes, the Task 9 relabels, in-form `answering`, completion acks) and nothing fell outside them.

Follow-ups, not in this branch: a hedged provider that fills a form's last slot gets its implicit ack folded into the completion, so the readback is the caller's only chance to object;
- A caller who answers the member-ID readback with a corrected number (rather than a plain yes/no) loses the correction and is sent to the keypad instead of having the new number heard.
- A bare "never mind" with no new request re-asks the current slot rather than doing anything else; it is visible in the trace as `replace_unresolved`.
- Adding the active form's own intent ("also book another one" while already booking) is dropped as `answering` rather than recognized as a no-op.
- The completion line still reads the member ID back immediately after it was just confirmed, on a one-turn call (Jason's own test call): mildly redundant but not wrong.
- Replaying a chained call re-speaks the bridged-into completion's ack a second time.
- `askSlot` ignores a keypad escalation once the confirmation that led to it has been cleared.
- Span-based detection of two provider names named in the same utterance, instead of relying on the model splitting its probability mass. Closed 2026-09-19: re-asking the same two surnames the caller offered adds nothing; first names in the roster and prompt would be the real fix, and it is not worth building for the prototype.
- `tentative-two-intents` may resolve as a disambiguation rather than an explicit confirmation under the real model, because the margin gate still runs after the tentative bump is applied.
