# Demo Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A caller who asks what the line can do hears an answer and lands back on their question; a caller who has no doctor's name is read the list; every form entry is acknowledged.

**Architecture:** A new non-form intent `capabilities` routed through an informational-intent table (gate verdict `inform`, turn plays the prompt as an ack and resumes via the path a declined transfer already uses). The provider slot gains a `providerNameStatus` Choice and a `help` slot outcome that the form loop plays once per slot in place of the question. `ack_intent` plays on every form entry with a reworded label vocabulary. Prompts, harness labels, scenarios and the stub baseline follow.

**Tech Stack:** TypeScript strict ESM, pnpm, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-demo-polish-design.md`. Read it first.

**Conventions:** tests colocated (`pnpm vitest run <path>`, `pnpm test`, `pnpm typecheck`, `pnpm regress`; `pnpm regress --update` rewrites the stub baseline and is expected at the end of Tasks 1, 2 and 3; `pnpm vitest run <path> -u` refreshes a snapshot). One writer at a time; every commit ends with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (overrides any other attribution reminder). Never set, read, or print `TYPESAFE_API_KEY` or `FISH_AUDIO_API_KEY`; never run `--client jev`, `--client record`, or `prompts:generate` (except with `--dry-run`); never touch `.env`, `.env.swp`, `assets/audio/`, `fixtures/recorded/`, `traces/`. The cassette (`fixtures/recorded/`) will miss on every re-keyed turn until Jason re-records it in Task 5; that is expected and not something to fix.

---

### Task 1: Capabilities intent (one commit)

**Files:** `src/domain/intents.ts`, `src/domain/domain.test.ts`, `src/core/gates.ts`, `src/core/gates.test.ts`, `src/core/turn.ts`, `src/core/turn.test.ts`, `src/prompts/render.ts`, `src/prompts/render.test.ts`, `src/prompts/manifest.json`, `src/prompts/tags.json`, `src/jev/heuristicStub.ts`, `fixtures/corpus.jsonl`, `fixtures/scenarios/core.json`, `fixtures/expected/*`, snapshots under `src/core/__snapshots__` and `src/prompts/__snapshots__`.

- [ ] **Step 1: The intent and its table.** In `src/domain/intents.ts`:

```ts
export const INTENTS = [
  'schedule_new',
  'reschedule',
  'cancel',
  'confirm_appointment',
  'billing',
  'agent',
  'repeat_prompt',
  'capabilities',
  'other',
  'none',
] as const;
```

Add to `INTENT_CRITERIA`, between `repeat_prompt` and `other`:

```ts
  capabilities: 'Asks what the system can do, what it is, what the options are, or how to use it, as in what can you do, what are my options, or what is this',
```

Add to `INTENT_LABELS` in the same position: `capabilities: 'hear what I can do',`. After `INTENT_MENU`:

```ts
/**
 * Intents answered with a prompt and a return to the question the caller was on (spec 2026-09-24
 * §2.1). The gate fires them the way it fires repeat_prompt; the turn plays the prompt as an ack
 * and resumes. A deployment adds one here without the gate or the turn naming it.
 */
export const INFORMATIONAL_INTENTS: Partial<Record<Intent, string>> = { capabilities: 'capabilities' };
```

`src/domain/domain.test.ts`: the first test becomes `'has the ten intents from the spec'` with `'capabilities'` between `'repeat_prompt'` and `'other'`. Add:

```ts
  it('maps every informational intent to a prompt and none of them to a form', () => {
    for (const [intent, promptId] of Object.entries(INFORMATIONAL_INTENTS)) {
      expect(isFormIntent(intent)).toBe(false);
      expect(typeof promptId).toBe('string');
    }
  });
```

(import `INFORMATIONAL_INTENTS`). Run `pnpm vitest run src/domain`.

- [ ] **Step 2: Gate.** In `src/core/gates.ts`, import `INFORMATIONAL_INTENTS` from `../domain/intents`. Add to `Verdict`, after `replay`:

```ts
  | ({ kind: 'inform'; promptId: string } & Frustrated)
```

In gate 8, outside a form, after the `repeat_prompt` line:

```ts
    else if (INFORMATIONAL_INTENTS[label] !== undefined && top.p >= t.INTENT_IMPLICIT) { routeVerdict = { kind: 'inform', promptId: INFORMATIONAL_INTENTS[label]! }; outcome = 'inform'; }
```

Inside a form, after its `repeat_prompt` line:

```ts
    else if (INFORMATIONAL_INTENTS[label] !== undefined && top.p >= t.INTENT_SWITCH) { routeVerdict = { kind: 'inform', promptId: INFORMATIONAL_INTENTS[label]! }; outcome = 'inform'; }
```

Nothing else changes: the summary resolution consumes only `proceed`/`queue`/`intent_failed`, the unanswered-confirmation rescue maps only those three, and `withFrustration` stamps the default branch, so an `inform` verdict wins over a pending confirmation and carries a rung, as the spec's §2.2 says. (At the transfer offer, gate 6 settles every non-yes as a decline before gate 8 runs, so "what can you do" at the offer declines it; that is the offer's existing rule and stays.)

Tests in `src/core/gates.test.ts`, in the top-level `describe('evaluateGates')`:

```ts
  it('answers an informational intent with its prompt, at the implicit band outside a form and the switch band inside', () => {
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ capabilities: 0.65, none: 0.35 }) })).verdict).toEqual({ kind: 'inform', promptId: 'capabilities' });
    expect(run(newSession('s', 0), baseAnswers({ intent: choice({ capabilities: 0.5, none: 0.5 }) })).verdict).toEqual({ kind: 'intent_failed' });
    const s = setForm(newSession('s', 0), 'reschedule');
    const answering = choice({ answering: 0.9, adding: 0.05, replacing: 0.05 });
    expect(run(s, baseAnswers({ intent: choice({ capabilities: 0.9, none: 0.1 }), intentChange: answering })).verdict).toEqual({ kind: 'inform', promptId: 'capabilities' });
    expect(run(s, baseAnswers({ intent: choice({ capabilities: 0.7, none: 0.3 }), intentChange: answering })).verdict).toEqual({ kind: 'proceed' });
    expect(run(s, baseAnswers({ intent: choice({ capabilities: 0.9, none: 0.1 }), intentChange: answering })).rows.find((g) => g.gate === 'intent')).toMatchObject({ outcome: 'inform:capabilities', decided: true });
  });

  it('lets an informational intent win over a pending summary and an unanswered confirmation, and carries a rung', () => {
    const summary = setForm(newSession('s', 0), 'reschedule');
    summary.pendingConfirmation = { target: 'form', form: 'reschedule', attempts: 0 };
    summary.promptedFor = 'confirm';
    const answering = choice({ answering: 0.9, adding: 0.05, replacing: 0.05 });
    expect(run(summary, baseAnswers({ intent: choice({ capabilities: 0.9, none: 0.1 }), intentChange: answering, confirmsYes: noul(0.1), confirmsNo: noul(0.1) })).verdict).toEqual({ kind: 'inform', promptId: 'capabilities' });
    const explicit = newSession('s', 0);
    explicit.pendingConfirmation = { target: 'intent', intent: 'cancel', answers: {}, text: 'maybe cancel' };
    explicit.promptedFor = 'intent';
    expect(run(explicit, baseAnswers({ intent: choice({ capabilities: 0.8, none: 0.2 }), confirmsYes: noul(0.1), confirmsNo: noul(0.1) })).verdict).toEqual({ kind: 'inform', promptId: 'capabilities' });
    const angry = run(newSession('s', 0), baseAnswers({ intent: choice({ capabilities: 0.8, none: 0.2 }), frustration: score({ none: 0.1, mild: 0.2, high: 0.7 }) }));
    expect(angry.verdict).toEqual({ kind: 'inform', promptId: 'capabilities', frustration: 'ack' });
  });
```

Run `pnpm vitest run src/core/gates.test.ts`; expect the new tests to pass and `pnpm typecheck` to fail only in `turn.ts` (unhandled `inform` case), which Step 3 fixes.

- [ ] **Step 3: Turn.** In `src/core/turn.ts`, add `resume` above `declineTransfer` and rewrite `declineTransfer` to use it:

```ts
/**
 * Back to wherever the call was, without counting a turn against the caller: a pending
 * confirmation asked again, an open form's next question, or the plain intent question. The
 * declined transfer offer and an informational intent (spec 2026-09-24 §2.3) both come back
 * through here, because in both the caller answered something, just not the question asked.
 */
function resume(s: Session, t: Thresholds, acks: Ack[], disambiguate: FillResult['disambiguate'] = null): Decision {
  if (s.pendingConfirmation) return reaskConfirmation(s, t, acks, false);
  if (s.form) return continueForm(s, acks, disambiguate);
  // Before any task is started the form loop has nothing to ask: the plain intent question comes
  // back, not the "Sorry, I didn't catch that" retry.
  return prompt('ask_intent', 'intent', {}, acks);
}

/**
 * The offer turned down: by a no, by an answer that is neither a yes nor a no, or by a second
 * silence. It is not offered again on this call, and the caller goes back to the question they
 * were on -- declining costs them no attempt, since they did answer the question we asked.
 */
function declineTransfer(s: Session, t: Thresholds, pc: TransferConfirmation, acks: Ack[]): Decision {
  s.transferDeclined = true;
  // A confirmation the offer displaced comes back rather than being dropped: an explicit intent
  // confirm still holds the caller's request, and a summary still holds its attempt count.
  s.pendingConfirmation = pc.resume ?? null;
  return resume(s, t, acks);
}
```

In `handleVerdict`, after `case 'replay':`:

```ts
    case 'inform': {
      // The answer plays as an ack in front of the question the caller was on. What else the
      // breath carried still fills, as on the queue verdict; no attempt counter moves.
      const fill = fillSlots(s, answers, ctx, s.form ? slotsFor(s.form) : allSlots());
      return { decision: resume(s, t, [{ promptId: verdict.promptId, vars: {} }, ...fill.acks], fill.disambiguate), events: fill.events };
    }
```

Tests in `src/core/turn.test.ts`, a new `describe('capabilities')` after the frustration block (it uses `HAPPY`, `afterTurns`, `say`, `started`, `identify`, `ANSWERING`, `NAME_ANSWERS`, all already there):

```ts
describe('capabilities', () => {
  const CAPABILITIES: Ack = { promptId: 'capabilities', vars: {} };
  // 0.9 clears INTENT_SWITCH (0.85) inside a form as well as INTENT_IMPLICIT outside one.
  const ASKS = choice({ capabilities: 0.9, other: 0.06, none: 0.04 });

  it('describes itself at the greeting and asks the open question again, without counting', () => {
    const r = say(started(), 'what can you do', { intent: ASKS });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_intent', target: 'intent', acks: [CAPABILITIES] });
    expect(r.session.intentAttempts).toBe(0);
    expect(r.session.form).toBeNull();
    expect(spokenText(r.decision)).toBe('I can help you schedule, reschedule, cancel, or confirm an appointment, or connect you to billing. You can just tell me what you need in your own words, and if you\'d rather talk to a person, say so anytime. How can I help you today?');
  });

  it('describes itself mid-form and lands back on the question it was on', () => {
    let r = say(started(), 'reschedule', { intent: choice({ reschedule: 0.9, none: 0.1 }) });
    r = say(r.session, 'jason stiles', { intentChange: ANSWERING, ...NAME_ANSWERS });
    expect(r.decision).toMatchObject({ promptId: 'ask_dob' });
    r = say(r.session, 'what else can you do', { intent: ASKS, intentChange: ANSWERING });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_dob', target: 'dob', acks: [CAPABILITIES] });
    expect(r.session.slots.dob.attempts).toBe(0);
  });

  it('fills what the same breath carried, then resumes', () => {
    let r = say(started(), 'reschedule', { intent: choice({ reschedule: 0.9, none: 0.1 }) });
    r = say(r.session, 'what can you do, this is jason stiles', { intent: ASKS, intentChange: ANSWERING, ...NAME_ANSWERS });
    expect(r.session.slots.name.value).toBe('jason stiles');
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_dob', acks: [CAPABILITIES] });
  });

  it('describes itself at the summary and re-asks it without counting', () => {
    const r = afterTurns([...HAPPY, { say: 'what can you do', over: { intent: ASKS } }]);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule', target: 'confirm', acks: [CAPABILITIES] });
    expect(r.session.pendingConfirmation).toMatchObject({ target: 'form', form: 'reschedule', attempts: 0 });
  });

  it('is acknowledged like any other prompt when the caller is also frustrated', () => {
    const r = say(started(), 'what the hell can you even do', { intent: ASKS, frustration: score({ none: 0.1, mild: 0.2, high: 0.7 }) });
    expect(r.decision).toMatchObject({ promptId: 'ask_intent', acks: [{ promptId: 'ack_frustration', vars: {} }, CAPABILITIES] });
  });
});
```

Run `pnpm vitest run src/core/turn.test.ts` after Step 4 (the manifest entry is needed for `spokenText`).

- [ ] **Step 4: Prompt and rendering.** In `src/prompts/manifest.json`, after `ack_frustration`:

```json
  "capabilities": { "text": "I can help you schedule, reschedule, cancel, or confirm an appointment, or connect you to billing. You can just tell me what you need in your own words, and if you'd rather talk to a person, say so anytime.", "interruptible": true },
```

In `src/prompts/tags.json` add `"capabilities.0": "[calm]",` in alphabetical position. In `src/prompts/render.ts`, `decisionToFrames`: every ack call `promptFrames(a.promptId, a.vars, false, ctx)` (three of them: `prompt`, `complete`, `handoff`) becomes `promptFrames(a.promptId, a.vars, promptEntry(a.promptId).interruptible, ctx)`. Every ack entry in the manifest is `interruptible: false` except the new one, so only it changes.

Test in `src/prompts/render.test.ts`, in `describe('decisionToFrames')`:

```ts
  it('plays an ack with its own manifest flag, so the long capabilities line can be talked over', () => {
    const frames = decisionToFrames({
      kind: 'prompt', promptId: 'ask_intent', vars: {}, target: 'intent', options: [],
      acks: [{ promptId: 'ack_frustration', vars: {} }, { promptId: 'capabilities', vars: {} }],
    });
    expect(frames.map((f) => (f.type === 'text' ? f.interruptible : f.type))).toEqual([false, true, true]);
  });
```

Refresh snapshots: `pnpm vitest run src/core/questions.test.ts src/prompts/clips.test.ts -u` (the intent criteria and the new clip `capabilities.0` change them; read the diff and confirm only those lines moved). Run `pnpm vitest run src/prompts src/core`.

- [ ] **Step 5: Heuristic stub.** In `src/jev/heuristicStub.ts`, `INTENT_KEYWORDS`, after the `repeat_prompt` row:

```ts
  ['capabilities', /\b(what (can|do) you do|what are you|what (are|is) my options|what can i (do|say|ask)|what is this|what does this do|what else can you do)\b/],
```

(`options` on its own stays with `repeat_prompt`'s "what were the options".)

- [ ] **Step 6: Corpus and scenarios.** Append to `fixtures/corpus.jsonl` (one JSON object per line; the id prefix `cp` is new):

```jsonl
{"id":"cp-01","text":"what can you do","intent":"capabilities","context":"no_form","tags":["capabilities"]}
{"id":"cp-02","text":"what are my options","intent":"capabilities","context":"no_form","tags":["capabilities"]}
{"id":"cp-03","text":"what is this","intent":"capabilities","context":"no_form","tags":["capabilities"]}
{"id":"cp-04","text":"I'd like to learn more about what you are and what you do","intent":"capabilities","context":"no_form","tags":["capabilities"]}
{"id":"cp-05","text":"what else can you do","intent":"capabilities","context":"reschedule","prompted":"dob","tags":["capabilities"]}
```

Append to `fixtures/scenarios/core.json` (inside the array, keep the file's two-space formatting):

```json
  {
    "id": "capabilities-open",
    "steps": [
      { "say": "what can you do" },
      { "say": "I need to reschedule my appointment" }
    ],
    "expect": {
      "decision": "prompt",
      "promptId": "ask_name",
      "form": "reschedule"
    }
  },
  {
    "id": "capabilities-midform",
    "steps": [
      { "say": "I need to reschedule my appointment" },
      { "say": "Jason Stiles" },
      { "say": "what else can you do" }
    ],
    "expect": {
      "decision": "prompt",
      "promptId": "ask_dob",
      "form": "reschedule",
      "slots": { "name": "jason stiles" },
      "text": "I can help you schedule"
    }
  },
  {
    "id": "capabilities-at-summary",
    "steps": [
      { "say": "I need to reschedule my appointment, it's with Dr. Chen sometime next week" },
      { "say": "Jason Stiles" },
      { "say": "March fifth nineteen eighty" },
      { "say": "Tuesday" },
      { "say": "what can you do" }
    ],
    "expect": {
      "decision": "prompt",
      "promptId": "confirm_reschedule",
      "form": "reschedule",
      "text": "Shall I make that change?"
    }
  },
```

The step texts other than the `cp-*` ones already exist in the corpus (`reschedule-happy` uses them), so the fixture stub answers every step from labels. Run `pnpm regress`: expect the three new scenarios to pass their expectations and `cp-*` to show as new; then `pnpm regress --update` and `pnpm regress` clean. `pnpm test` and `pnpm typecheck` clean. Commit `feat(core): a capabilities intent answers what the line can do and resumes the question`.

---

### Task 2: Provider help (one commit)

**Files:** `src/domain/slots/types.ts`, `src/domain/slots/provider.ts`, `src/domain/slots/provider.test.ts`, `src/core/session.ts`, `src/core/session.test.ts`, `src/core/thresholds.ts`, `src/core/fia.ts`, `src/core/fia.test.ts`, `src/core/turn.ts`, `src/core/turn.test.ts`, `src/prompts/manifest.json`, `src/prompts/tags.json`, `src/prompts/render.test.ts`, `src/jev/corpus.ts`, `src/jev/corpus.test.ts`, `src/jev/fixtureStub.ts`, `src/jev/defaults.ts`, `src/jev/heuristicStub.ts`, `fixtures/corpus.jsonl`, `fixtures/scenarios/core.json`, `fixtures/expected/*`, snapshots.

- [ ] **Step 1: Types, state, threshold.** `src/domain/slots/types.ts`, `SlotOutcome`:

```ts
  | { kind: 'invalid'; reason: string; raw: string }
  /** The caller said whether they know the value rather than saying it; play this prompt in place of the question (spec 2026-09-24 §3.3). */
  | { kind: 'help'; promptId: string };
```

`src/core/session.ts`, `SlotState` gains `/** help prompts already played for this slot on this call; each plays at most once */ helped: string[];`. `emptySlot()` returns `helped: []`; `cloneSlot` returns `{ ...s, helped: [...s.helped], window: s.window ? { ...s.window } : null }`. `src/core/thresholds.ts`, under `// slots`: `SLOT_HELP: 0.6,`. In `src/core/session.test.ts`, the test `'cloneSession copies slot windows'` also sets `s.slots.provider.helped = ['provider_list']` and asserts the clone's `slots.provider.helped` equals it and is not the same array (`not.toBe`). In `src/core/turn.ts` `slotRows`, `passed` includes `outcome.kind === 'help'`.

- [ ] **Step 2: Provider slot.** In `src/domain/slots/provider.ts`, add to `questions()` after `providerUnsure`:

```ts
      providerNameStatus: {
        type: 'choice',
        instructions: "Read asr.text and node.promptJustPlayed. The caller was asked whether they have the provider's name. Do they say whether they know it, without naming a provider?",
        criteria: {
          neither: 'Names a provider, or says nothing about whether they know the name',
          has_name: "Says yes, that they have or know the provider's name, without saying the name",
          no_name: "Says no, or that they don't know, don't have, can't remember, or were never told the provider's name, or asks who the doctors are",
        },
      },
```

(`neither` first: a stub that knows nothing about the question answers its first label.) In `fill`, the two `absent` returns for no named provider become `return helpOutcome(answers, t);`, with, above `providerSlot`:

```ts
/** Prompts for the two ways a caller answers "Do you have the name of the provider?" without a name. */
const HELP_PROMPTS: Record<string, string> = { has_name: 'ask_provider_name', no_name: 'provider_list' };

/** No provider was named: did the caller say whether they know the name? (spec 2026-09-24 §3.3) */
function helpOutcome(answers: AnswerMap, t: Thresholds): SlotOutcome {
  const s = answers.providerNameStatus;
  const [top] = isChoice(s) ? rankProbabilities(s.probabilities) : [];
  const promptId = top && top.p >= t.SLOT_HELP ? HELP_PROMPTS[top.label] : undefined;
  return promptId ? { kind: 'help', promptId } : { kind: 'absent' };
}
```

(import `AnswerMap` from `../../jev/types` and `Thresholds` from `../../core/thresholds`.) Tests in `src/domain/slots/provider.test.ts`:

```ts
  it('asks the name-status choice with neither first', () => {
    const q = providerSlot.questions(ctx);
    expect(q.providerNameStatus?.type).toBe('choice');
    if (q.providerNameStatus?.type === 'choice') expect(Object.keys(q.providerNameStatus.criteria)).toEqual(['neither', 'has_name', 'no_name']);
  });

  it('asks for help when no provider is named and the caller says whether they know the name', () => {
    const none = choice({ none: 0.9, chen: 0.1 });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ no_name: 0.8, neither: 0.15, has_name: 0.05 }) }, ctx)).toEqual({ kind: 'help', promptId: 'provider_list' });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ has_name: 0.7, neither: 0.2, no_name: 0.1 }) }, ctx)).toEqual({ kind: 'help', promptId: 'ask_provider_name' });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ no_name: 0.5, neither: 0.5 }) }, ctx)).toEqual({ kind: 'absent' });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ neither: 0.9, no_name: 0.1 }) }, ctx)).toEqual({ kind: 'absent' });
    expect(providerSlot.fill({ provider: none }, ctx)).toEqual({ kind: 'absent' });
  });

  it('lets a named provider win over the status', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.9, none: 0.1 }), providerNameStatus: choice({ has_name: 0.9, neither: 0.1 }) }, ctx))
      .toMatchObject({ kind: 'filled', value: 'chen' });
  });
```

The existing `'asks the roster choice plus an unsure question'` test still passes. Run `pnpm vitest run src/domain/slots/provider.test.ts`.

- [ ] **Step 3: fillSlots carries help.** In `src/core/fia.ts`, `FillResult` gains:

```ts
  /** A help prompt to play in place of the question, for the slot the caller was just asked (spec 2026-09-24 §3.3). */
  help: { slot: SlotId; promptId: string } | null;
```

In `fillSlots`: `let help: FillResult['help'] = null;`, a new case in the switch:

```ts
      case 'help': {
        // Honoured only for the slot the caller was asked for, and once per prompt per call; anywhere
        // else it is a turn without progress, so the ladder walks as it would for a miss.
        if (session.promptedFor !== spec.id || slot.helped.includes(outcome.promptId) || help !== null) break;
        slot.helped.push(outcome.promptId);
        help = { slot: spec.id, promptId: outcome.promptId };
        progress = true;
        break;
      }
```

and `return { session, events, acks, disambiguate, progress, help };`. Fix the doc comment on `progress` to add "or asked for help". Tests in `src/core/fia.test.ts` (use its existing session and context helpers; the provider slot is `SLOTS.provider` from `../domain/slots`):

```ts
describe('fillSlots help', () => {
  const NO_NAME = { provider: choice({ none: 0.9, chen: 0.1 }), providerNameStatus: choice({ no_name: 0.9, neither: 0.1 }) };

  it('carries help for the prompted slot once, as progress, and records it on the slot', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.promptedFor = 'provider';
    const first = fillSlots(s, NO_NAME, ctx, [SLOTS.provider]);
    expect(first.help).toEqual({ slot: 'provider', promptId: 'provider_list' });
    expect(first.progress).toBe(true);
    expect(first.events).toEqual([{ slot: 'provider', outcome: { kind: 'help', promptId: 'provider_list' } }]);
    expect(s.slots.provider.helped).toEqual(['provider_list']);
    const again = fillSlots(s, NO_NAME, ctx, [SLOTS.provider]);
    expect(again.help).toBeNull();
    expect(again.progress).toBe(false);
  });

  it('ignores help for a slot that was not asked', () => {
    const s = setForm(newSession('s', 0), 'reschedule');
    s.promptedFor = 'name';
    const r = fillSlots(s, NO_NAME, ctx, [SLOTS.provider]);
    expect(r.help).toBeNull();
    expect(r.progress).toBe(false);
    expect(s.slots.provider.helped).toEqual([]);
  });
});
```

`fia.test.ts` already imports `fillSlots`, `newSession`, `setForm`, `SLOTS` and `choice`; its context helper is a function, so write `ctx()` where the block above says `ctx`.

- [ ] **Step 4: The form loop plays it.** In `src/core/turn.ts`, `continueForm` gains a fourth parameter and a branch after the readback check:

```ts
function continueForm(s: Session, acks: Ack[], disambiguate: FillResult['disambiguate'], help: FillResult['help'] = null): Decision {
  ...
  const readback = pendingSlotConfirmation(s);
  if (readback) { ... }
  // The caller said whether they know the answer rather than answering: the slot's help prompt
  // takes the question's place this once, and the attempt count does not move (spec 2026-09-24 §3.3).
  if (help) return prompt(help.promptId, help.slot, {}, acks);
  const next = nextPrompt(s);
```

Pass `fill.help` where a fill result is at hand: `enterForm` (`continueForm(s, [...acks, ...fill.acks], fill.disambiguate, fill.help)`), `case 'queue'`, `case 'proceed'`, and `resume` gains `help: FillResult['help'] = null` as a fourth parameter passed through to `continueForm` and supplied from `case 'inform'`. The `disambiguate` parameter's inline type is replaced by `FillResult['disambiguate']` (same shape). `case 'proceed'` needs no other change: help set `progress`, so `failAttempt` is not reached.

Turn tests, a new `describe('provider help')` in `src/core/turn.test.ts`:

```ts
describe('provider help', () => {
  const NO_NAME = choice({ no_name: 0.9, has_name: 0.05, neither: 0.05 });
  const HAS_NAME = choice({ has_name: 0.9, no_name: 0.05, neither: 0.05 });
  const KIM = choice({ kim: 0.92, none: 0.08 });

  /** A reschedule with the caller identified, so the provider question is up. */
  function atProvider(): TurnResult {
    const r = say(started(), 'reschedule', { intent: choice({ reschedule: 0.9, none: 0.1 }) });
    const at = identify(r.session);
    expect(at.decision).toMatchObject({ promptId: 'ask_provider', target: 'provider' });
    return at;
  }

  it('reads the list when the caller has no name, then fills from it, without counting', () => {
    let r = say(atProvider().session, 'no', { intentChange: ANSWERING, providerNameStatus: NO_NAME });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'provider_list', target: 'provider', acks: [] });
    expect(r.session.slots.provider).toMatchObject({ attempts: 0, helped: ['provider_list'] });
    r = say(r.session, 'dr kim', { intentChange: ANSWERING, provider: KIM });
    expect(r.session.slots.provider.value).toBe('kim');
    expect(r.decision).toMatchObject({ promptId: 'ask_date' });
  });

  it('asks which doctor after a bare yes', () => {
    let r = say(atProvider().session, 'yes', { intentChange: ANSWERING, providerNameStatus: HAS_NAME });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider_name', target: 'provider' });
    expect(r.session.slots.provider.attempts).toBe(0);
    r = say(r.session, 'dr kim', { intentChange: ANSWERING, provider: KIM });
    expect(r.decision).toMatchObject({ promptId: 'ask_date' });
  });

  it('fills in one turn when the yes carries the name', () => {
    const r = say(atProvider().session, 'yes, dr kim', { intentChange: ANSWERING, providerNameStatus: HAS_NAME, provider: KIM });
    expect(r.session.slots.provider.value).toBe('kim');
    expect(r.decision).toMatchObject({ promptId: 'ask_date' });
  });

  it('treats a second no after the list as a miss, so the ladder walks', () => {
    let r = say(atProvider().session, 'no', { intentChange: ANSWERING, providerNameStatus: NO_NAME });
    r = say(r.session, 'I still do not know', { intentChange: ANSWERING, providerNameStatus: NO_NAME });
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_provider_retry', target: 'provider' });
    expect(r.session.slots.provider.attempts).toBe(1);
    r = say(r.session, 'no idea', { intentChange: ANSWERING, providerNameStatus: NO_NAME });
    expect(r.decision).toMatchObject({ promptId: 'ask_provider_dtmf' });
  });

  it('plays each help prompt once: a yes after the list still asks which doctor, a second yes is a miss', () => {
    let r = say(atProvider().session, 'no', { intentChange: ANSWERING, providerNameStatus: NO_NAME });
    r = say(r.session, 'oh yes I do', { intentChange: ANSWERING, providerNameStatus: HAS_NAME });
    expect(r.decision).toMatchObject({ promptId: 'ask_provider_name' });
    r = say(r.session, 'yes', { intentChange: ANSWERING, providerNameStatus: HAS_NAME });
    expect(r.decision).toMatchObject({ promptId: 'ask_provider_retry' });
  });

  it('ignores help on a slot that was not asked', () => {
    const r = say(started(), 'reschedule', { intent: choice({ reschedule: 0.9, none: 0.1 }) });
    const at = say(r.session, 'I do not know the doctor', { intentChange: ANSWERING, providerNameStatus: NO_NAME });
    expect(at.decision).toMatchObject({ promptId: 'ask_name_retry', target: 'name' });
    expect(at.session.slots.provider.helped).toEqual([]);
  });

  it('shows help as a passed slot row', () => {
    const r = say(atProvider().session, 'no', { intentChange: ANSWERING, providerNameStatus: NO_NAME });
    expect(r.rows.find((g) => g.gate === 'slot:provider')).toMatchObject({ outcome: 'help', passed: true, value: null });
  });
});
```

- [ ] **Step 5: Prompts.** In `src/prompts/manifest.json`, change `ask_provider` and add two entries after `ask_provider_dtmf`:

```json
  "ask_provider": { "text": "Do you have the name of the provider?", "interruptible": true },
  "ask_provider_retry": { "text": "Sorry, which doctor is it with? For example, Dr. Patel.", "interruptible": true },
  "ask_provider_dtmf": { "text": "Using the keypad: for Dr. Chen press 1, Dr. Cheng 2, Dr. Patel 3, Dr. Okafor 4, Dr. Nguyen 5, Dr. Rossi 6, Dr. Kim 7, Dr. Alvarez 8.", "interruptible": true },
  "ask_provider_name": { "text": "Which doctor is it with?", "interruptible": true },
  "provider_list": { "text": "Our providers are Dr. Chen, Dr. Cheng, Dr. Patel, or Dr. Okafor; Dr. Nguyen, Dr. Rossi, Dr. Kim, or Dr. Alvarez. Which one is your appointment with?", "interruptible": true },
```

`src/prompts/tags.json`: `"ask_provider_name.0": "[calm]"`, `"provider_list.0": "[calm]"`. In `src/prompts/render.test.ts`, `describe('keypad prompts match the tables they read from')`:

```ts
  it('reads every provider in roster order in the spoken list', () => {
    const text = manifest.provider_list.text;
    let cursor = -1;
    for (const p of PROVIDERS) {
      const at = text.indexOf(`Dr. ${p.name}`, cursor + 1);
      expect(at, `${p.name} is listed after the previous provider`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(text.split(';')).toHaveLength(2);
  });
```

Refresh the clips snapshot (`pnpm vitest run src/prompts/clips.test.ts -u`) and the questions snapshot (`pnpm vitest run src/core/questions.test.ts -u`); confirm the diffs are the two new clips, the changed `ask_provider.0` text, and the new question.

- [ ] **Step 6: Harness label.** `src/jev/corpus.ts`: `CorpusEntry` gains `/** the caller says whether they know the provider's name without saying it (spec 2026-09-24 §3.2) */ providerNameStatus?: 'has_name' | 'no_name';`, `ENTRY_KEYS` gains `'providerNameStatus'`, and after the `providerUnsure` type check:

```ts
    if (entry.providerNameStatus !== undefined && entry.providerNameStatus !== 'has_name' && entry.providerNameStatus !== 'no_name') {
      throw new Error(`corpus ${entry.id}: providerNameStatus must be has_name or no_name`);
    }
```

and, in the form-context block beside the `providerUnsure` slot check:

```ts
      if (entry.providerNameStatus && !formSlots.includes('provider')) {
        throw new Error(`corpus ${entry.id}: slot provider is not on form ${form}`);
      }
```

`src/jev/corpus.test.ts`, in the `tentative, change and providerUnsure` test, add two lines:

```ts
    expect(parseCorpus('{"id":"i","text":"no I don\'t","intent":"none","context":"reschedule","prompted":"provider","providerNameStatus":"no_name"}\n')[0]?.providerNameStatus).toBe('no_name');
    expect(() => parseCorpus('{"id":"j","text":"x","intent":"none","context":"reschedule","providerNameStatus":"maybe"}\n')).toThrow(/has_name or no_name/);
```

`src/jev/fixtureStub.ts`, in the choice branch of `labeledAnswer` after `changeSlot`:

```ts
    if (id === 'providerNameStatus') return choiceAnswer(sharp(labels, entry.providerNameStatus ?? 'neither', sharpness));
```

`src/jev/heuristicStub.ts`, a new case in the choice switch:

```ts
      case 'providerNameStatus': {
        const named = PROVIDERS.some((p) => new RegExp(`\\b${p.name.toLowerCase()}\\b`).test(text));
        const winner = named ? 'neither'
          : has(text, /\b(no|nope|don'?t know|do not know|not sure|no idea|don'?t have|do not have|can'?t remember|who are the|which doctors)\b/) ? 'no_name'
          : has(text, /^(yes|yeah|yep|i do)\b/) ? 'has_name' : 'neither';
        return choiceAnswer(sharp(labels, winner, 0.9));
      }
```

- [ ] **Step 7: Corpus and scenarios.** Append to `fixtures/corpus.jsonl` ("yes" and "no" alone already exist at `no_form`, and texts must be unique, so these are the longer forms a caller also says):

```jsonl
{"id":"ph-01","text":"no I don't","intent":"none","context":"reschedule","prompted":"provider","providerNameStatus":"no_name","tags":["provider_help"]}
{"id":"ph-02","text":"I don't know","intent":"none","context":"reschedule","prompted":"provider","providerNameStatus":"no_name","tags":["provider_help"]}
{"id":"ph-03","text":"I don't have it","intent":"none","context":"reschedule","prompted":"provider","providerNameStatus":"no_name","tags":["provider_help"]}
{"id":"ph-04","text":"who are the doctors","intent":"none","context":"reschedule","prompted":"provider","providerNameStatus":"no_name","tags":["provider_help"]}
{"id":"ph-05","text":"yes I do","intent":"none","context":"reschedule","prompted":"provider","providerNameStatus":"has_name","tags":["provider_help"]}
{"id":"ph-06","text":"yes, it's Dr. Chen","intent":"none","context":"reschedule","prompted":"provider","slots":{"provider":"chen"},"tags":["provider_help"]}
{"id":"ph-07","text":"I still don't know","intent":"none","context":"reschedule","prompted":"provider","providerNameStatus":"no_name","tags":["provider_help"]}
```

Append scenarios:

```json
  {
    "id": "provider-no-name",
    "steps": [
      { "say": "I need to reschedule my appointment" },
      { "say": "Jason Stiles" },
      { "say": "March fifth nineteen eighty" },
      { "say": "I don't know" },
      { "say": "Dr. Kim" }
    ],
    "expect": {
      "decision": "prompt",
      "promptId": "ask_date",
      "form": "reschedule",
      "slots": { "provider": "kim" }
    }
  },
  {
    "id": "provider-has-name",
    "steps": [
      { "say": "I need to reschedule my appointment" },
      { "say": "Jason Stiles" },
      { "say": "March fifth nineteen eighty" },
      { "say": "yes I do" },
      { "say": "Dr. Kim" }
    ],
    "expect": {
      "decision": "prompt",
      "promptId": "ask_date",
      "form": "reschedule",
      "slots": { "provider": "kim" }
    }
  },
  {
    "id": "provider-no-twice",
    "steps": [
      { "say": "I need to reschedule my appointment" },
      { "say": "Jason Stiles" },
      { "say": "March fifth nineteen eighty" },
      { "say": "I don't know" },
      { "say": "I still don't know" }
    ],
    "expect": {
      "decision": "prompt",
      "promptId": "ask_provider_retry",
      "form": "reschedule",
      "text": "Sorry, which doctor is it with?"
    }
  },
```

Run `pnpm regress`; the `ph-*` entries and new scenarios show as new, and the existing `pv-*` entries at `prompted: provider` are unchanged (a named provider still wins). `pnpm regress --update`, then `pnpm regress`, `pnpm test`, `pnpm typecheck` clean. Commit `feat(core): the provider question asks whether the caller has the name, and reads the list when they do not`.

---

### Task 3: Intent acknowledgment on every form entry (one commit)

**Files:** `src/domain/intents.ts`, `src/core/turn.ts`, `src/core/turn.test.ts`, `src/core/state.test.ts`, `src/prompts/manifest.json`, `src/prompts/clips.test.ts`, `src/prompts/render.test.ts`, `fixtures/scenarios/core.json`, `fixtures/expected/*`, snapshots.

- [ ] **Step 1: Labels and text.** `src/domain/intents.ts`, `INTENT_LABELS`:

```ts
  schedule_new: 'schedule a new appointment',
  reschedule: 'reschedule your appointment',
  cancel: 'cancel your appointment',
  confirm_appointment: 'confirm your appointment',
  billing: 'talk to billing',
```

`src/prompts/manifest.json`: `"ack_intent": { "text": "I'd be happy to help you {intentLabel}.", "interruptible": false },`.

- [ ] **Step 2: Every entry acks.** In `src/core/turn.ts`:

```ts
/** "I'd be happy to help you ...": every form entry is said out loud (spec 2026-09-24 §4). */
function ackIntent(form: FormId): Ack {
  return { promptId: 'ack_intent', vars: { intentLabel: INTENT_LABELS[form] } };
}
```

`enterForm` loses its `confirm` parameter (both callers pass a value it no longer reads: drop the argument at `case 'confirmed'` and `case 'route'`), and its acks line becomes:

```ts
  setForm(s, form);
  // Queued after setForm, so the queue is read against the form actually being entered.
  // A task added on this same utterance is promised before the one being started is named.
  const acks: Ack[] = [...enqueue(s, queue), ackIntent(form)];
```

Update the comment above `switching` (the variable goes away with it): entering a form is always said out loud, however sure the intent was, so the caller hears which task started. In `handleDtmf`'s menu branch: `return { decision: continueForm(s, [ackIntent(option.intent)], null), rows: [] };`.

- [ ] **Step 3: Tests.** Run `pnpm vitest run src/core src/prompts` and fix every expectation the ack changes; they fall into these groups, and each fix is mechanical:

  - `acks: []` right after a route or menu pick becomes `acks: [{ promptId: 'ack_intent', vars: { intentLabel: 'reschedule your appointment' } }]` (or the form's label). Define at the top of `turn.test.ts` (adding `type FormId` to the existing `../domain/intents` import): `const ACK = (form: FormId): Ack => ({ promptId: 'ack_intent', vars: { intentLabel: INTENT_LABELS[form] } });` and use it.
  - The frustration test `'acknowledges the first frustrated turn before the question'` expects `acks: [ACK_FRUSTRATION, ACK('reschedule')]` in that order.
  - Old label strings (`'ask about billing'`, `'reschedule an appointment'`, `'cancel an appointment'`) in `turn.test.ts`, `state.test.ts`, `clips.test.ts`, `render.test.ts` become the new ones.
  - The frames test `'renders play frames when the turn context carries clips'` gains the ack frame, if it enters a form.

  Add one test to `describe('turn')`:

```ts
  it('acknowledges every form entry: a confident route, a menu pick, and a yes to the explicit check', () => {
    const routed = say(started(), 'reschedule', { intent: choice({ reschedule: 0.95, none: 0.05 }) });
    expect(routed.decision).toMatchObject({ promptId: 'ask_name', acks: [ACK('reschedule')] });
    expect(spokenText(routed.decision)).toBe("I'd be happy to help you reschedule your appointment. What's your first and last name?");
    let menu = say(started(), 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    menu = say(menu.session, 'blah', { intent: choice({ none: 0.7, other: 0.3 }) });
    menu = resolve(menu.session, dtmfFrames('3')[0]!, null, tc);
    expect(menu.decision).toMatchObject({ promptId: 'ask_name', acks: [ACK('cancel')] });
    let explicit = say(started(), 'maybe cancel', { intent: choice({ cancel: 0.5, none: 0.5 }) });
    explicit = say(explicit.session, 'yes', { confirmsYes: noul(0.9), confirmsNo: noul(0.1) });
    expect(explicit.decision).toMatchObject({ promptId: 'ask_name', acks: [ACK('cancel')] });
  });
```

  and to the over-answer test, assert the chain order: `acks: [ACK('reschedule')]` followed by the provider ack only if the fill was implicit (it is not at 0.91, so `[ACK('reschedule')]`); add a case with `provider: choice({ chen: 0.5, none: 0.4, cheng: 0.1 })` expecting `[ACK('reschedule'), { promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }]`.

- [ ] **Step 4: Fixtures.** `fixtures/scenarios/core.json`: any `expect.text` that quotes an old label or "Sure, I can help" changes to the new wording (grep for `ask about billing`, `an appointment`, `Sure, I can`). Refresh the clips snapshot (`pnpm vitest run src/prompts/clips.test.ts -u`; the five vocabulary rows and `ack_intent.0` change). `pnpm regress`: every scenario and corpus entry that enters a form now differs by the ack; `pnpm regress --update`; `pnpm regress`, `pnpm test`, `pnpm typecheck` clean. Commit `feat(core): every form entry is acknowledged; intent labels reworded to follow "help you"`.

---

### Task 4: Docs (one commit)

**Files:** `README.md`, this plan.

- [ ] **Step 1: README.** In order:
  - **A call, end to end**: after the caller's opener, the system line becomes `I'd be happy to help you reschedule your appointment. What's your first and last name?` and the provider question, where it appears, reads `Do you have the name of the provider?`.
  - **Text harness**: `217` becomes `229` labeled outcomes and `75` becomes `81` scenarios.
  - **Regression**, the labels paragraph: add `providerNameStatus` (`has_name` or `no_name`: the caller says whether they know the provider's name without saying it, at the provider question) to the list of labels the stub answers from.
  - **Confirmation and multi-intent**: `"Now, let's ask about billing."` becomes `"Now, let's talk to billing."`, `"Sure, we'll ask about billing after this."` becomes `"Sure, we'll talk to billing after this."`, `"do you want to cancel an appointment?"` becomes `"do you want to cancel your appointment?"`. Add two paragraphs at the end of the section:

    > Every form entry is acknowledged, however confident the intent was: "I'd be happy to help you reschedule your appointment." plays before the first question, after a keypad pick, and after a "yes" to the explicit check. A caller who asks what the line can do, at any point, hears "I can help you schedule, reschedule, cancel, or confirm an appointment, or connect you to billing. You can just tell me what you need in your own words, and if you'd rather talk to a person, say so anytime." and is then asked the question they were on again: the open question at the start, the current slot question mid-form, the summary at the summary. It costs no attempt. `capabilities` is one row in `INFORMATIONAL_INTENTS`; another informational intent is another row.
    >
    > The provider question asks "Do you have the name of the provider?" A name in the answer fills as before ("yes, Dr. Chen"). A bare "yes" is answered with "Which doctor is it with?"; a "no", an "I don't know", or "who are the doctors" is answered with the list: "Our providers are Dr. Chen, Dr. Cheng, Dr. Patel, or Dr. Okafor; Dr. Nguyen, Dr. Rossi, Dr. Kim, or Dr. Alvarez. Which one is your appointment with?" Neither counts as an attempt, and each plays at most once per call; a second "I don't know" after the list is an ordinary miss, so the retry line, the keypad list, and the transfer follow as they always did. The slot decides this through a `help` outcome the form loop plays in place of its question; any slot can return one.
  - **Recorded prompts**, after the frustration paragraph:

    > The demo polish adds three clips — `capabilities.0`, `provider_list.0`, `ask_provider_name.0` — and re-records `ask_provider.0` ("Do you have the name of the provider?"), `ack_intent.0` ("I'd be happy to help you"), and the vocabulary clips `intent.schedule_new`, `intent.reschedule`, `intent.cancel`, `intent.confirm_appointment` and `intent.billing` for their new labels. `pnpm prompts:check` reports 3 missing and 7 stale until those are recorded (Task 5 of `docs/superpowers/plans/2026-09-24-demo-polish.md`).
  - **Live-call checklist**: step 7's expectation becomes `"I'd be happy to help you reschedule your appointment. What's your first and last name?"`; step 17's two quoted lines take the new billing label; add a step 24:

    > 24. The demo caller's path: at the greeting say "I'd like to learn more about what you are and what you do". Expect the capabilities line and then "How can I help you today?" with no attempt spent. Say "I'd like to reschedule": expect "I'd be happy to help you reschedule your appointment. What's your first and last name?" Give the name and birthday; at "Do you have the name of the provider?" say "no": expect the list, split in two runs of four. Say "Dr. Kim" and expect the day question. On another call say "yes" at the provider question and expect "Which doctor is it with?"

- [ ] **Step 2: Deviations.** Append `## Deviations recorded during execution` to this plan listing every place the implementers departed from the plan or spec (including the offer-declines-on-capabilities note from Task 1 Step 2 and the `ask_provider` options that stayed empty: `node.options` is for menus and disambiguations, and a yes/no there would change nothing the model reads). Commit `docs: demo polish (capabilities, provider help, intent acknowledgment)`.

---

### Task 5 (Jason)

- [ ] `pnpm prompts:check` reports 3 missing, 7 stale. `pnpm prompts:generate` for the missing; `pnpm prompts:generate --only ask_provider.0 --force`, and the same for `ack_intent.0`, `intent.schedule_new`, `intent.reschedule`, `intent.cancel`, `intent.confirm_appointment`, `intent.billing`. Listen to `provider_list.0` for the pause at the semicolon; if the voice runs through it, regenerate with a period in place of the semicolon (edit the manifest, and the roster test still passes).
- [ ] `pnpm regress --client record` for the full re-record (every key changed), then `pnpm regress --client recorded` and read the diff against the labels. Expect the usual handful of known disagreements plus anything the new questions surface; the `ph-*` entries are the ones to read first, since `providerNameStatus` is new to the model.
- [ ] Restart `pnpm serve` and walk checklist step 24 on the phone.
