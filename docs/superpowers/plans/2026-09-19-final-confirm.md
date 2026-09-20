# Final Confirm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every form ends with a summary question the caller answers; the member ID fills silently and is confirmed only there; a second task named on the first utterance is queued.

**Architecture:** A third `PendingConfirmation` variant (`target: 'form'`) replaces immediate completion; the confirm gate defers its decision for that variant so an added intent or a correction in the same utterance is not lost; `handleVerdict` gains the yes / correction / ask-change / ladder branches; slots get a `summary` confirmation policy; one new Choice each for "which detail" and "second task"; the fixture stub and corpus grow labels for the confirm turn.

**Tech Stack:** TypeScript strict ESM, pnpm, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-19-final-confirm-design.md`. Read it first. The plan wins on small conflicts; each is marked "Deviation:".

**Conventions for every task:**

- Tests colocated as `*.test.ts`; run one with `pnpm vitest run <path>`, all with `pnpm test`; typecheck with `pnpm typecheck`.
- Extensionless imports; strict TS; `noUncheckedIndexedAccess` is on.
- Commit after every task with the message shown, one task per commit, exactly one writer at a time; every commit message ends with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never set, read, or print `TYPESAFE_API_KEY` or `FISH_AUDIO_API_KEY`; never run `--client jev`, `--client record`, or `prompts:generate` without `--dry-run`. Only Jason runs those (Task 10).
- `pnpm test` stays green after every task. Tasks 1–5 add types, prompts, questions, and labels with no behavior change; Task 6 flips the flow and re-records the stub baseline in the same commit.
- `pnpm regress` after Task 6 must show changes only on turns at or after a form's last slot; after Task 7 also on the two-task opening utterances. Paste the summary block in each report.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/core/thresholds.ts`, `src/harness-text/sweepSpace.ts` | `SLOT_CHANGE`, `INTENT_SECOND` |
| `src/core/session.ts`, `src/core/state.ts` | form-shaped pending confirmation with `attempts`; `promptedFor: 'confirm'`; `currentAttempts` |
| `src/domain/slots/types.ts`, `memberId.ts`, `src/core/fia.ts` | `spokenConfirm: 'summary'` |
| `src/prompts/manifest.json`, `src/prompts/tags.json` | `confirm_<form>`, `ask_change`, `confirm_dtmf`; shortened completions; `confirm_memberId` removed |
| `src/core/questions.ts` | `changeSlot` (form confirm pending), `secondIntent` (no form) |
| `src/jev/corpus.ts`, `src/jev/fixtureStub.ts`, `src/jev/heuristicStub.ts`, `src/harness-text/runner.ts` | `confirm`, `changeSlot`, `secondIntent` labels; `confirm_<form>` contexts seeded |
| `src/core/gates.ts` | deferred confirm decision for form targets; `change_slot` verdict; `queue` on confirm verdicts; `secondIntent` |
| `src/core/turn.ts` | summary instead of completion; yes / correction / ask-change / ladder; DTMF 1 and 2 on the confirm target |
| `fixtures/corpus.jsonl`, `fixtures/scenarios/core.json`, `fixtures/expected/*` | labels, scenarios, re-recorded baseline |
| `README.md`, this plan | docs, deviation record |

---

### Task 1: Thresholds, session and state types, the `summary` policy

**Files:**
- Modify: `src/core/thresholds.ts`, `src/harness-text/sweepSpace.ts`, `src/core/session.ts`, `src/core/state.ts`, `src/domain/slots/types.ts`, `src/domain/slots/memberId.ts` (type only, policy stays `always` until Task 6), `src/core/fia.ts`
- Test: `src/core/session.test.ts`, `src/core/state.test.ts`, `src/core/fia.test.ts`

- [ ] **Step 1: Failing tests.** Append to `src/core/session.test.ts`:

```ts
describe('confirm target', () => {
  it('reports the form confirmation attempts as the current attempts', () => {
    const s = newSession('s', 0);
    s.promptedFor = 'confirm';
    s.pendingConfirmation = { target: 'form', form: 'cancel', attempts: 2 };
    expect(currentAttempts(s)).toBe(2);
    expect(cloneSession(s).pendingConfirmation).toEqual({ target: 'form', form: 'cancel', attempts: 2 });
  });
});
```

Append to `src/core/state.test.ts` (match the file's helpers for building a session and calling `buildTurnState`):

```ts
  it('shows a form confirmation to the model as the form label', () => {
    const s = newSession('s', 0);
    s.form = 'reschedule';
    s.pendingConfirmation = { target: 'form', form: 'reschedule', attempts: 0 };
    expect(buildTurnState(s, { text: 'yes', isFinal: true, dtmf: null }, 0).pendingConfirmation).toEqual({ target: 'form', value: 'reschedule an appointment' });
  });
```

Append to `src/core/fia.test.ts` (use the file's existing fixtures for a filled outcome; if it builds specs by hand, add a spec with `spokenConfirm: 'summary'`):

```ts
  it('fills a summary-policy slot silently: no ack, not confirmed, not pending', () => {
    const spec = { ...SLOTS.memberId, spokenConfirm: 'summary' as const };
    const s = newSession('s', 0);
    setForm(s, 'cancel');
    const answers = { containsMemberId: noulAnswer(0.95), memberIdComplete: noulAnswer(0.95), memberIdSpan: choiceAnswer({ 'four four seven one eight two nine three': 0.95, none: 0.05 }) };
    const r = fillSlots(s, answers, ctxFor('four four seven one eight two nine three'), [spec]);
    expect(r.acks).toEqual([]);
    expect(s.slots.memberId).toMatchObject({ value: '44718293', confirmed: false });
    expect(pendingSlotConfirmation(s)).toBeNull();
  });
```

(`ctxFor` is whatever helper the file uses to build a `SlotContext` from text; `choiceAnswer`/`noulAnswer` come from `src/jev/distributions`.) Run the three files; expect type errors and failures.

- [ ] **Step 2: Implement.**

`thresholds.ts`, after `PROVIDER_UNSURE`:
```ts
  // final confirm (spec 2026-09-19 final-confirm §6)
  SLOT_CHANGE: 0.6,
  INTENT_SECOND: 0.6,
```
`sweepSpace.ts`: add `'SLOT_CHANGE', 'INTENT_SECOND'` to `SWEEPABLE` next to `INTENT_CHANGE`; no constraint, no exclusion.

`session.ts`:
```ts
export type PendingConfirmation =
  | { target: 'intent'; intent: Intent; answers: Readonly<AnswerMap>; text: string }   // keep the existing doc comment
  | { target: 'slot'; slot: SlotId; value: string; display: string }
  /** the summary question; attempts counts unanswered turns and resets when a correction lands */
  | { target: 'form'; form: FormId; attempts: number };
```
`promptedFor: 'intent' | 'confirm' | SlotId | null;` and:
```ts
export function currentAttempts(session: Session): number {
  if (session.promptedFor === 'confirm') return session.pendingConfirmation?.target === 'form' ? session.pendingConfirmation.attempts : 0;
  if (session.promptedFor === 'intent' || session.promptedFor === null) return session.intentAttempts;
  return session.slots[session.promptedFor].attempts;
}
```
`state.ts`: `pendingConfirmation: { target: 'intent' | 'form' | SlotId; value: string } | null;` and in `buildTurnState`:
```ts
    pendingConfirmation: session.pendingConfirmation
      ? session.pendingConfirmation.target === 'intent'
        ? { target: 'intent', value: INTENT_LABELS[session.pendingConfirmation.intent] }
        : session.pendingConfirmation.target === 'form'
          ? { target: 'form', value: INTENT_LABELS[session.pendingConfirmation.form] }
          : { target: session.pendingConfirmation.slot, value: session.pendingConfirmation.display }
      : null,
```
`slots/types.ts`: `spokenConfirm: 'always' | 'by-confidence' | 'summary';` with the doc comment gaining `summary: a spoken fill is neither acked nor read back; the final confirm covers it`.

`fia.ts` `fillSlots`, replace the `filled` case body's policy lines:
```ts
        const policy = SLOTS[spec.id].spokenConfirm;
        const readBack = policy === 'always';
        const keepConfirmed = slot.confirmed && slot.value === outcome.value;
        slot.value = outcome.value;
        slot.display = outcome.display;
        slot.confirmed = keepConfirmed || (policy === 'by-confidence' && outcome.confirm === 'none');
        slot.window = null;
        if (policy === 'by-confidence' && outcome.confirm === 'implicit') acks.push({ promptId: `ack_${spec.id}`, vars: { [spec.id]: outcome.display } });
```
(`SLOTS[spec.id]` is how the file reads the policy today; the test passes a spec whose policy differs from `SLOTS.memberId`, so read the policy from `spec.spokenConfirm` instead and keep `SLOTS` only if something else needs it.) `pendingSlotConfirmation` is unchanged: only `always` raises a readback.

`applyDtmf` in `fia.ts`: `if (target === null || target === 'intent' || target === 'confirm') return { kind: 'no_target' };` (the confirm keypad is handled in `turn.ts`, Task 6).

- [ ] **Step 3:** `pnpm vitest run src/core src/domain`, `pnpm typecheck`, `pnpm test`, `pnpm regress` (no changes). Commit:

```bash
git add src/core/thresholds.ts src/harness-text/sweepSpace.ts src/core/session.ts src/core/session.test.ts src/core/state.ts src/core/state.test.ts src/domain/slots/types.ts src/core/fia.ts src/core/fia.test.ts
git commit -m "feat(core): form-shaped pending confirmation, confirm target, summary slot policy, two thresholds

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Prompts and tags

**Files:**
- Modify: `src/prompts/manifest.json`, `src/prompts/tags.json`, `src/prompts/__snapshots__/clips.test.ts.snap` (regenerate), `src/prompts/render.test.ts` if a test enumerates prompt ids

- [ ] **Step 1: Add to the manifest** (keep alphabetical-ish grouping with the other confirm prompts):

```json
  "confirm_schedule": { "text": "You'd be booked with {provider} on {date}, member ID {memberId}. Shall I book that?", "interruptible": true },
  "confirm_reschedule": { "text": "Your appointment with {provider} would move to {date}, member ID {memberId}. Shall I make that change?", "interruptible": true },
  "confirm_cancel": { "text": "Your appointment with {provider} would be cancelled, member ID {memberId}. Shall I cancel it?", "interruptible": true },
  "confirm_appointment_details": { "text": "That's your appointment with {provider} on {date}, member ID {memberId}. Is that the one?", "interruptible": true },
  "ask_change": { "text": "What should I change?", "interruptible": true },
  "confirm_dtmf": { "text": "Press 1 to confirm, or 2 to change something.", "interruptible": false },
```

Deviation: `confirm_appointment` has no date slot (`FORMS.confirm_appointment.slots` is `['memberId', 'provider']`), so its summary cannot say a date. Use `"That's your appointment with {provider}, member ID {memberId}. Is that the one?"` instead of the spec's text.

Do NOT shorten the completion lines or remove `confirm_memberId` yet (Task 6, with the flow). The seam test (`segments.test.ts` "holds across the whole manifest") must pass: every `{memberId}` and `{date}` above is followed by `,` or `.`.

- [ ] **Step 2: tags.json.** Add `[confident]` for every new fixed segment id (`confirm_schedule.0`, `.1`, `.2`; `confirm_reschedule.0`, `.1`, `.2`; `confirm_cancel.0`, `.1`, `.2`; `confirm_appointment_details.0`, `.1`, `.2`; `ask_change.0` `[calm]`; `confirm_dtmf.0` `[calm]`). Get the exact ids from `pnpm -s prompts:sheet | grep -E "confirm_(schedule|reschedule|cancel|appointment_details)|ask_change|confirm_dtmf"`. Keys sorted. The tags test asserts every recordable id has a tag.

- [ ] **Step 3:** `pnpm vitest run src/prompts -u` (updates the recordable snapshot; inspect the diff: only additions), `pnpm typecheck`, `pnpm test`, `pnpm regress` (no changes). Commit:

```bash
git add src/prompts/manifest.json src/prompts/tags.json src/prompts/__snapshots__/clips.test.ts.snap
git commit -m "feat(prompts): summary questions per form, ask_change, confirm keypad prompt

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Questions

**Files:**
- Modify: `src/core/questions.ts`
- Test: `src/core/questions.test.ts` (snapshot tests live in `src/core/__snapshots__/questions.test.ts.snap`; update with `-u` and inspect)

- [ ] **Step 1: Failing tests.** Append:

```ts
  it('asks which detail to change only while a form confirmation is pending', () => {
    const s = newSession('s', 0);
    setForm(s, 'reschedule');
    expect(buildQuestions(s, ctx('the day')).changeSlot).toBeUndefined();
    s.pendingConfirmation = { target: 'form', form: 'reschedule', attempts: 0 };
    const q = buildQuestions(s, ctx('the day'));
    expect(q.changeSlot?.type).toBe('choice');
    expect(Object.keys((q.changeSlot as { criteria: Record<string, unknown> }).criteria)).toEqual(['provider', 'date', 'memberId', 'none']);
    expect(q.confirmsYes).toBeDefined();
    expect(q.provider).toBeDefined();
    expect(q.dateMode).toBeDefined();
  });
  it('asks for a second task only outside a form', () => {
    const s = newSession('s', 0);
    const q = buildQuestions(s, ctx('reschedule and also my bill'));
    expect(q.secondIntent?.type).toBe('choice');
    expect(Object.keys((q.secondIntent as { criteria: Record<string, unknown> }).criteria)).toEqual([...FORM_INTENTS, 'none']);
    setForm(s, 'reschedule');
    expect(buildQuestions(s, ctx('x')).secondIntent).toBeUndefined();
  });
```
(`ctx` is the file's SlotContext helper; import `FORM_INTENTS`.)

- [ ] **Step 2: Implement** in `questions.ts`:

```ts
/** Spec final-confirm §4: a second task named on the opening utterance. Asked only outside a form. */
function noForm(): QuestionMap {
  const criteria: Record<string, string> = {};
  for (const i of FORM_INTENTS) criteria[i] = INTENT_CRITERIA[i];
  criteria.none = 'The caller asks for one task only, or for nothing';
  return {
    secondIntent: {
      type: 'choice',
      instructions: 'Read asr.text. If the caller asks for a second, different task in addition to the main one they ask for, which is it? Choose none when there is only one task.',
      criteria,
    },
  };
}

/** Spec final-confirm §6: which detail the caller names when asked what to change. Asked only while the summary is pending. */
function formConfirmation(): QuestionMap {
  return {
    changeSlot: {
      type: 'choice',
      instructions: 'Read asr.text and node.promptJustPlayed. The caller was read a summary of their appointment and asked to confirm it, or asked what to change. Which detail do they name as wrong or ask to change?',
      criteria: {
        provider: 'The doctor or provider, as in the doctor, not Dr. Chen, or a different doctor',
        date: 'The day or date, as in the day, not Tuesday, or a different day',
        memberId: 'The member ID or member number',
        none: 'They give a new value instead of naming a detail, answer yes or no, or name nothing',
      },
    },
  };
}
```
and in `buildQuestions`: `if (!session.form) Object.assign(q, noForm());` after the slot questions, and `if (session.pendingConfirmation?.target === 'form') Object.assign(q, formConfirmation());` after `confirmation()`. Import `FORM_INTENTS` from `../domain/intents`.

- [ ] **Step 3:** `pnpm vitest run src/core/questions.test.ts -u` (inspect the snapshot diff: two new questions and nothing else changed), `pnpm typecheck`, `pnpm test`, `pnpm regress` (no changes: the stub answers both with quiet `none`). Commit:

```bash
git add src/core/questions.ts src/core/questions.test.ts src/core/__snapshots__/questions.test.ts.snap
git commit -m "feat(questions): changeSlot while the summary is pending; secondIntent outside a form

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Corpus labels, stub answers, heuristic answers, confirm contexts

**Files:**
- Modify: `src/jev/corpus.ts`, `src/jev/fixtureStub.ts`, `src/jev/defaults.ts`, `src/jev/heuristicStub.ts`, `src/harness-text/runner.ts`
- Test: `src/jev/corpus.test.ts`, `src/jev/fixtureStub.test.ts`, `src/jev/heuristicStub.test.ts`, `src/harness-text/runner.test.ts`

- [ ] **Step 1: Failing tests.**

`corpus.test.ts`:
```ts
  it('accepts confirm contexts with confirm, changeSlot, and slot labels, and secondIntent outside a form', () => {
    const [a, b, c] = parseCorpus([
      '{"id":"fc-1","text":"yes","intent":"none","context":"confirm_reschedule","confirm":"yes"}',
      '{"id":"fc-2","text":"no the day","intent":"none","context":"confirm_reschedule","confirm":"no","changeSlot":"date"}',
      '{"id":"fc-3","text":"reschedule and also my bill","intent":"reschedule","context":"no_form","secondIntent":"billing"}',
    ].join('\n'));
    expect(a?.confirm).toBe('yes');
    expect(b?.changeSlot).toBe('date');
    expect(c?.secondIntent).toBe('billing');
  });
  it('rejects confirm labels off a confirm context, changeSlot for a slot not on the form, and secondIntent in a form', () => {
    expect(() => parseCorpus('{"id":"x","text":"yes","intent":"none","context":"reschedule","confirm":"yes"}')).toThrow(/confirm needs a confirm_ context/);
    expect(() => parseCorpus('{"id":"x","text":"the day","intent":"none","context":"confirm_cancel","changeSlot":"date"}')).toThrow(/not on form cancel/);
    expect(() => parseCorpus('{"id":"x","text":"x","intent":"reschedule","context":"reschedule","secondIntent":"billing"}')).toThrow(/secondIntent needs no_form/);
    expect(() => parseCorpus('{"id":"x","text":"x","intent":"none","context":"confirm_billing"}')).toThrow(/unknown context/);
  });
```

`fixtureStub.test.ts` (match the file's way of building a client and a request; questions can come from `buildQuestions` on a seeded session or be written inline):
```ts
  it('answers the confirm questions from confirm, changeSlot, and secondIntent labels', async () => {
    const entries = parseCorpus([
      '{"id":"fc-1","text":"yes","intent":"none","context":"confirm_reschedule","confirm":"yes"}',
      '{"id":"fc-2","text":"no the day","intent":"none","context":"confirm_reschedule","confirm":"no","changeSlot":"date"}',
      '{"id":"fc-3","text":"reschedule and also my bill","intent":"reschedule","context":"no_form","secondIntent":"billing"}',
    ].join('\n'));
    const client = new FixtureStubClient(entries, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const qs = { confirmsYes: { type: 'noul', instructions: '' }, confirmsNo: { type: 'noul', instructions: '' },
      changeSlot: { type: 'choice', instructions: '', criteria: { provider: null, date: null, memberId: null, none: null } },
      secondIntent: { type: 'choice', instructions: '', criteria: { schedule_new: null, reschedule: null, cancel: null, confirm_appointment: null, billing: null, none: null } } } as const;
    const ask = async (text: string) => (await client.ask({ state: { asr: { text } }, questions: qs as never })).answers;
    const a = await ask('yes');
    expect(noulValue(a, 'confirmsYes')).toBeGreaterThan(0.8);
    expect(noulValue(a, 'confirmsNo')).toBeLessThan(0.2);
    const b = await ask('no the day');
    expect(noulValue(b, 'confirmsNo')).toBeGreaterThan(0.8);
    expect((b.changeSlot as { choice: string }).choice).toBe('date');
    const c = await ask('reschedule and also my bill');
    expect((c.secondIntent as { choice: string }).choice).toBe('billing');
    expect((a.secondIntent as { choice: string }).choice).toBe('none');
  });
```

`heuristicStub.test.ts`:
```ts
  it('names a detail for changeSlot from keywords', async () => {
    const q = { changeSlot: { type: 'choice', instructions: '', criteria: { provider: null, date: null, memberId: null, none: null } } } as const;
    const pick = async (text: string) => ((await new HeuristicStubClient().ask({ state: { asr: { text } }, questions: q as never })).answers.changeSlot as { choice: string }).choice;
    expect(await pick('the day')).toBe('date');
    expect(await pick('the doctor')).toBe('provider');
    expect(await pick('my member id')).toBe('memberId');
    expect(await pick('Thursday')).toBe('none');
  });
```

`runner.test.ts`:
```ts
  it('seeds a confirm context with every slot filled and the summary pending', async () => {
    const entry = parseCorpus('{"id":"fc-1","text":"yes","intent":"none","context":"confirm_reschedule","confirm":"yes"}')[0]!;
    const { setup } = await runCorpusEntry(entry, opts);   // use the file's stub RunOptions
    const s = setup.result.session;   // NOTE: seeding is re-applied after setup inside runCorpusEntry; assert on the run's starting state instead if setup does not expose it
    expect(s.form).toBe('reschedule');
    expect(s.slots.date.value).not.toBeNull();
    expect(s.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 0 });
    expect(s.promptedFor).toBe('confirm');
    expect(s.lastPromptId).toBe('confirm_reschedule');
  });
```
(Adapt to how `runCorpusEntry` exposes the seeded session; if only the run result is visible, assert on `run.result.session.form === 'reschedule'` and `lastPromptId` via the trace, or export `seedCorpusSession` for the test.)

- [ ] **Step 2: Implement.**

`corpus.ts`:
```ts
export type CorpusContext = 'no_form' | FormId | `confirm_${FormId}`;
export interface CorpusEntry {
  ...
  context: CorpusContext;
  /** confirm_ contexts only: how the utterance answers the summary question */
  confirm?: 'yes' | 'no' | 'unanswered';
  /** confirm_ contexts only: the detail the caller names when asked what to change */
  changeSlot?: SlotId;
  /** no_form only: a second task named alongside the main one (§4) */
  secondIntent?: FormId;
}
export function confirmForm(context: CorpusContext): FormId | null {
  return context.startsWith('confirm_') ? (context.slice('confirm_'.length) as FormId) : null;
}
/** the form a context runs in: the form itself, or the form behind a confirm_ context */
export function contextForm(context: CorpusContext): FormId | null {
  return context === 'no_form' ? null : (confirmForm(context) ?? (context as FormId));
}
```
Add `'confirm', 'changeSlot', 'secondIntent'` to `ENTRY_KEYS`. Validation, after the existing context check (replace it):
```ts
    const cf = confirmForm(entry.context);
    if (entry.context !== 'no_form' && !(FORM_INTENTS as readonly string[]).includes(cf ?? entry.context)) throw new Error(`corpus ${entry.id}: unknown context ${entry.context}`);
    if (cf !== null && FORMS[cf].completion.kind !== 'prompt') throw new Error(`corpus ${entry.id}: unknown context ${entry.context}`);
    if (entry.confirm !== undefined) {
      if (cf === null) throw new Error(`corpus ${entry.id}: confirm needs a confirm_ context`);
      if (!['yes', 'no', 'unanswered'].includes(entry.confirm)) throw new Error(`corpus ${entry.id}: confirm must be yes, no, or unanswered`);
    }
    if (entry.changeSlot !== undefined) {
      if (cf === null) throw new Error(`corpus ${entry.id}: changeSlot needs a confirm_ context`);
      if (!FORMS[cf].slots.includes(entry.changeSlot)) throw new Error(`corpus ${entry.id}: changeSlot ${entry.changeSlot} is not on form ${cf}`);
    }
    if (entry.secondIntent !== undefined) {
      if (entry.context !== 'no_form') throw new Error(`corpus ${entry.id}: secondIntent needs no_form`);
      if (!(FORM_INTENTS as readonly string[]).includes(entry.secondIntent)) throw new Error(`corpus ${entry.id}: unknown secondIntent ${entry.secondIntent}`);
    }
```
Every later check that uses `FORMS[entry.context]` (prompted, slots, providerUnsure) uses `FORMS[contextForm(entry.context)!]` instead; `prompted` is rejected on a confirm context (`prompted needs a form context`); `change` is rejected on a confirm context too.

`defaults.ts` `QUIET_NOUL`: unchanged (`confirmsYes`/`confirmsNo` 0.1 are there).

`fixtureStub.ts` `labeledAnswer`:
- choice: `if (id === 'changeSlot') return pick(entry.changeSlot);` and `if (id === 'secondIntent') return pick(entry.secondIntent);`
- noul: `if (id === 'confirmsYes') return noulAnswer(entry.confirm === 'yes' ? 0.92 : QUIET_NOUL.confirmsYes!);` and `if (id === 'confirmsNo') return noulAnswer(entry.confirm === 'no' ? 0.92 : QUIET_NOUL.confirmsNo!);`

`heuristicStub.ts`: in the choice switch, `case 'changeSlot': return pick(/\b(day|date|when)\b/.test(text) ? 'date' : /\b(doctor|dr|provider|who)\b/.test(text) ? 'provider' : /\b(member|id|number)\b/.test(text) ? 'memberId' : 'none');` (use the file's `has`/`pick` helpers; `secondIntent` falls to the quiet `none`).

`runner.ts` `seedCorpusSession`:
```ts
const PLACEHOLDER_SLOTS: Record<SlotId, SlotCandidate> = {
  memberId: { value: '00000000', display: '0000 0000' },
  provider: { value: 'patel', display: 'Dr. Patel' },
  date: { value: '2026-09-22', display: 'Tuesday, September 22' },
};

function seedCorpusSession(session: Session, entry: CorpusEntry): Session {
  if (entry.context === 'no_form') return session;
  const form = contextForm(entry.context)!;
  setForm(session, form);
  const confirming = confirmForm(entry.context) !== null;
  for (const id of FORMS[form].slots) {
    if (!confirming && id === (entry.prompted ?? missingSlots(session)[0])) break;
    const p = PLACEHOLDER_SLOTS[id];
    session.slots[id] = { ...emptySlot(), value: p.value, display: p.display, confirmed: !confirming && true };
  }
  if (confirming) {
    session.pendingConfirmation = { target: 'form', form, attempts: 0 };
    session.promptedFor = 'confirm';
    session.lastPromptId = `confirm_${form}`;
    session.lastPromptText = promptText(`confirm_${form}`, summaryVars(session));
    session.lastPromptOptions = ['yes', 'no'];
    return session;
  }
  const slot = entry.prompted ?? missingSlots(session)[0] ?? null;
  session.promptedFor = slot;
  session.lastPromptId = slot ? `ask_${slot}` : null;
  session.lastPromptText = slot ? promptText(`ask_${slot}`, {}) : '';
  return session;
}
```
where `summaryVars(session)` maps each slot id to `session.slots[id].display ?? ''` (export it from `src/core/turn.ts` in Task 6; until then define it locally in `runner.ts` and switch to the export in Task 6). Keep the existing behavior for non-confirm contexts exactly (the loop above must reproduce the current "fill slots before the prompted one" logic; `date` placeholders are only used by confirm contexts, so the earlier "no placeholder" error path goes away).

- [ ] **Step 3:** `pnpm vitest run src/jev src/harness-text`, `pnpm typecheck`, `pnpm test`, `pnpm regress` (no changes). Commit:

```bash
git add src/jev/corpus.ts src/jev/corpus.test.ts src/jev/fixtureStub.ts src/jev/fixtureStub.test.ts src/jev/heuristicStub.ts src/jev/heuristicStub.test.ts src/harness-text/runner.ts src/harness-text/runner.test.ts
git commit -m "feat(harness): confirm contexts and labels; stubs answer changeSlot, secondIntent, and the summary yes/no

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Gates: deferred form-confirm decision, `change_slot`, `secondIntent`

**Files:**
- Modify: `src/core/gates.ts`
- Test: `src/core/gates.test.ts`

- [ ] **Step 1: Failing tests.** Use the file's helpers for a session and an `answers` map (it builds distributions with `choiceAnswer`/`noulAnswer`). Add:

```ts
describe('form confirmation', () => {
  const pending = (): Session => { const s = newSession('s', 0); setForm(s, 'reschedule'); s.pendingConfirmation = { target: 'form', form: 'reschedule', attempts: 0 }; s.promptedFor = 'confirm'; return s; };
  it('confirms on yes and carries an added intent', () => {
    const a = quiet({ confirmsYes: 0.9, intent: { billing: 0.9 }, intentChange: { adding: 0.9 } });
    expect(evaluateGates(pending(), ts(), a, T).verdict).toEqual({ kind: 'confirmed', queue: 'billing' });
  });
  it('rejects on no, with the queue when one was added', () => {
    expect(evaluateGates(pending(), ts(), quiet({ confirmsNo: 0.9 }), T).verdict).toEqual({ kind: 'rejected' });
    expect(evaluateGates(pending(), ts(), quiet({ confirmsNo: 0.9, intent: { billing: 0.9 }, intentChange: { adding: 0.9 } }), T).verdict).toEqual({ kind: 'rejected', queue: 'billing' });
  });
  it('names the slot to change when asked what to change', () => {
    const v = evaluateGates(pending(), ts(), quiet({ changeSlot: { date: 0.9 } }), T).verdict;
    expect(v).toEqual({ kind: 'change_slot', slot: 'date' });
    expect(evaluateGates(pending(), ts(), quiet({ changeSlot: { date: 0.5 } }), T).verdict).toEqual({ kind: 'confirm_unanswered' });
  });
  it('lets a replace, an agent request, or a replay win over the summary', () => {
    expect(evaluateGates(pending(), ts(), quiet({ confirmsYes: 0.9, wantsHuman: 0.95 }), T).verdict).toEqual({ kind: 'handoff', reason: 'live-agent' });
    expect(evaluateGates(pending(), ts(), quiet({ intent: { cancel: 0.95 }, intentChange: { replacing: 0.9 } }), T).verdict).toMatchObject({ kind: 'route', intent: 'cancel' });
  });
  it('still decides slot and intent confirmations at the confirm gate', () => {
    const s = newSession('s', 0); setForm(s, 'cancel');
    s.pendingConfirmation = { target: 'slot', slot: 'memberId', value: '44718293', display: '4471 8293' };
    const r = evaluateGates(s, ts(), quiet({ confirmsYes: 0.9 }), T);
    expect(r.verdict).toEqual({ kind: 'confirmed' });
    expect(r.rows.find((x) => x.gate === 'confirmation')?.decided).toBe(true);
  });
});
describe('second intent on the first utterance', () => {
  it('queues a second form intent on a plain route', () => {
    const v = evaluateGates(newSession('s', 0), ts(), quiet({ intent: { reschedule: 0.95 }, secondIntent: { billing: 0.8 } }), T).verdict;
    expect(v).toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none', queue: 'billing' });
  });
  it('ignores it below threshold, when it repeats the main intent, and on a tentative or explicit route', () => {
    expect(evaluateGates(newSession('s', 0), ts(), quiet({ intent: { reschedule: 0.95 }, secondIntent: { billing: 0.5 } }), T).verdict).toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none' });
    expect(evaluateGates(newSession('s', 0), ts(), quiet({ intent: { reschedule: 0.95 }, secondIntent: { reschedule: 0.9 } }), T).verdict).toEqual({ kind: 'route', intent: 'reschedule', confirm: 'none' });
    expect(evaluateGates(newSession('s', 0), ts(), quiet({ intent: { reschedule: 0.95 }, intentTentative: 0.9, secondIntent: { billing: 0.9 } }), T).verdict).toEqual({ kind: 'route', intent: 'reschedule', confirm: 'explicit' });
  });
});
```
(`quiet(overrides)` = the file's helper that starts from quiet answers; `ts()` a turn state; `T` default thresholds.)

- [ ] **Step 2: Implement.**

`Verdict`:
```ts
  | { kind: 'confirmed'; queue?: FormId }
  | { kind: 'rejected'; queue?: FormId }
  | { kind: 'confirm_unanswered'; queue?: FormId }
  | { kind: 'change_slot'; slot: SlotId }
  | { kind: 'route'; intent: FormId; confirm: 'none' | 'implicit' | 'explicit'; queue?: FormId }
```
(import `SlotId` from `../domain/forms`).

Gate 6 becomes:
```ts
  // 6. pending confirmation. Intent and slot readbacks decide here. The summary (target form)
  // defers: an added intent or a correction in the same breath must not be lost to an early yes/no.
  let confirmationUnanswered = false;
  let formConfirm: 'confirmed' | 'rejected' | null = null;
  if (session.pendingConfirmation) {
    const isForm = session.pendingConfirmation.target === 'form';
    const yes = noulValue(answers, 'confirmsYes');
    const no = noulValue(answers, 'confirmsNo');
    if (yes >= t.CONFIRM_YES && yes >= no) {
      const row = { gate: 'confirmation', value: yes, threshold: t.CONFIRM_YES, passed: true, outcome: 'confirmed', decided: false };
      if (isForm) { formConfirm = 'confirmed'; rows.push(row); } else decide(row, { kind: 'confirmed' });
    } else if (no >= t.CONFIRM_NO) {
      const row = { gate: 'confirmation', value: no, threshold: t.CONFIRM_NO, passed: true, outcome: 'rejected', decided: false };
      if (isForm) { formConfirm = 'rejected'; rows.push(row); } else decide(row, { kind: 'rejected' });
    } else {
      rows.push({ gate: 'confirmation', value: Math.max(yes, no), threshold: t.CONFIRM_YES, passed: false, outcome: 'unanswered', decided: false });
      confirmationUnanswered = true;
    }
  }
```

After gate 8 computes `routeVerdict`/`outcome` (both branches) and before the existing `confirmationUnanswered` rescue, add the second-intent and form-confirm resolution:

```ts
  // Second task on the opening utterance (spec final-confirm §4): only a plain route carries it.
  if (activeForm === null && routeVerdict.kind === 'route' && routeVerdict.confirm === 'none') {
    const [secondTop] = isChoice(answers.secondIntent) ? rankProbabilities(answers.secondIntent.probabilities) : [];
    const second = secondTop && secondTop.label !== 'none' && isFormIntent(secondTop.label) && secondTop.label !== routeVerdict.intent && secondTop.p >= t.INTENT_SECOND ? secondTop.label : null;
    rows.push({ gate: 'secondIntent', value: secondTop?.p ?? null, threshold: t.INTENT_SECOND, passed: second !== null, outcome: second ? `queue:${second}` : 'none', decided: false });
    if (second) routeVerdict = { ...routeVerdict, queue: second };
  }

  // The summary's answer, combined with what the intent gate found (spec final-confirm §2.2):
  // a handoff, replay, or replacing route wins; otherwise yes/no/change/unanswered, carrying an added intent.
  if (session.pendingConfirmation?.target === 'form' && (routeVerdict.kind === 'proceed' || routeVerdict.kind === 'queue' || routeVerdict.kind === 'intent_failed')) {
    const queue = routeVerdict.kind === 'queue' ? routeVerdict.intent : undefined;
    const withQueue = <V extends { kind: string }>(v: V): V & { queue?: FormId } => (queue ? { ...v, queue } : v);
    if (formConfirm === 'confirmed') routeVerdict = withQueue({ kind: 'confirmed' });
    else if (formConfirm === 'rejected') routeVerdict = withQueue({ kind: 'rejected' });
    else {
      const [changeTop] = isChoice(answers.changeSlot) ? rankProbabilities(answers.changeSlot.probabilities) : [];
      const named = changeTop && changeTop.label !== 'none' && changeTop.p >= t.SLOT_CHANGE ? (changeTop.label as SlotId) : null;
      rows.push({ gate: 'changeSlot', value: changeTop?.p ?? null, threshold: t.SLOT_CHANGE, passed: named !== null, outcome: named ? `change:${named}` : 'none', decided: false });
      routeVerdict = named ? { kind: 'change_slot', slot: named } : withQueue({ kind: 'confirm_unanswered' });
    }
    outcome = `summary_${routeVerdict.kind}`;
  }
```
Then the existing rescue (`confirmationUnanswered && (intent_failed || proceed || queue)`) stays for intent/slot targets; guard it with `session.pendingConfirmation?.target !== 'form'` so the form path above is the only one that maps those verdicts. The `intentRow` still pushes/decides as before; `routeVerdict.kind === 'proceed'` is now impossible while a form confirm is pending, so `decide(intentRow, routeVerdict)` records the summary outcome in the table.

Note on ordering: a `rejected` with a correction ("no, Thursday") is decided here as `rejected`; the slot fill happens in `turn.ts` (Task 6), which is why the verdict must not consume the answers.

- [ ] **Step 3:** `pnpm vitest run src/core/gates.test.ts`, `pnpm typecheck`, `pnpm test`, `pnpm regress` (no changes: nothing sets a form confirmation yet, and the stub's `secondIntent` is quiet). Commit:

```bash
git add src/core/gates.ts src/core/gates.test.ts
git commit -m "feat(gates): deferred summary decision with queue and change_slot; second intent on a plain route

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The final confirm flow, silent member ID, shortened completions, baseline re-record

**Files:**
- Modify: `src/core/turn.ts`, `src/domain/slots/memberId.ts` (policy → `summary`), `src/prompts/manifest.json` (completion texts; remove `confirm_memberId`), `src/prompts/tags.json` (remove `confirm_memberId.*`; completion segment ids change), `src/prompts/__snapshots__/clips.test.ts.snap`, `src/prompts/render.test.ts` (tests that used `confirm_memberId`), `fixtures/scenarios/core.json` (existing scenarios that reached a completion), `fixtures/expected/*.json` (re-record), `src/server/server.test.ts`, `src/server/adapter.test.ts` (worked-example expectations), `src/harness-text/runner.ts` (use the exported `summaryVars`)
- Test: `src/core/turn.test.ts`

- [ ] **Step 1: Failing tests** in `turn.test.ts`. The file drives `resolve` with a fixture-stub answer map; use its helpers (`tc`, `newSession`, `promptFrame`, an `answersFor(text)` if present, or build answers with the `quiet()` pattern from `gates.test.ts`). A session "at the summary" is built by running the reschedule happy path: route with provider + window, member ID, day. Tests:

```ts
describe('final confirm', () => {
  it('asks the summary instead of completing, with the member ID filled silently', () => {
    const r = afterTurns(['I need to reschedule my appointment with Dr. Chen next week', 'four four seven one eight two nine three', 'Tuesday']);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule', target: 'confirm', options: ['yes', 'no'] });
    expect(r.decision.vars).toEqual({ memberId: '4471 8293', provider: 'Dr. Chen', date: 'Tuesday, September 22' });
    expect(r.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 0 });
    // the ID turn asked the next question directly: no readback, no ack
    expect(turnAt(1).decision).toMatchObject({ promptId: 'date_narrow_window', acks: [] });
  });
  it('completes on yes with the short completion line and confirmed slots', () => {
    const r = afterTurns([...HAPPY, 'yes']);
    expect(r.decision).toMatchObject({ kind: 'complete', promptId: 'reschedule_confirmed' });
    expect(r.session.slots.memberId.confirmed).toBe(true);
    expect(spokenText(r.decision)).toBe('Your appointment is moved.');
  });
  it('refills a corrected slot from a no and re-asks the summary', () => {
    const r = afterTurns([...HAPPY, 'no, Thursday']);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_reschedule' });
    expect(r.session.slots.date.display).toBe('Thursday, September 24');
    expect(r.session.pendingConfirmation).toEqual({ target: 'form', form: 'reschedule', attempts: 0 });
  });
  it('refills two slots from one correction', () => {
    const r = afterTurns([...HAPPY, 'no, Thursday with Dr. Alvarez']);
    expect(r.decision.vars).toMatchObject({ provider: 'Dr. Alvarez', date: 'Thursday, September 24' });
  });
  it('narrows first when the correction is a window', () => {
    const r = afterTurns([...HAPPY, 'no, next week']);
    expect(r.decision).toMatchObject({ promptId: 'date_narrow_window' });
    expect(r.session.pendingConfirmation).toBeNull();
    expect(afterTurns([...HAPPY, 'no, next week', 'Wednesday']).decision).toMatchObject({ promptId: 'confirm_reschedule' });
  });
  it('asks what to change on a bare no, then reopens the named slot', () => {
    const r = afterTurns([...HAPPY, 'no']);
    expect(r.decision).toMatchObject({ promptId: 'ask_change', target: 'confirm' });
    const r2 = afterTurns([...HAPPY, 'no', 'the day']);
    expect(r2.decision).toMatchObject({ promptId: 'ask_date' });
    expect(r2.session.slots.date.value).toBeNull();
    expect(afterTurns([...HAPPY, 'no', 'the day', 'Friday']).decision).toMatchObject({ promptId: 'confirm_reschedule' });
  });
  it('corrects the member ID at the summary', () => {
    const r = afterTurns([...HAPPY, 'no, my ID is four four seven one eight two nine four']);
    expect(r.decision.vars).toMatchObject({ memberId: '4471 8294' });
  });
  it('walks the unanswered ladder: re-ask, keypad, agent', () => {
    expect(afterTurns([...HAPPY, 'what are your hours']).decision).toMatchObject({ promptId: 'confirm_reschedule' });
    expect(afterTurns([...HAPPY, 'what are your hours', 'what are your hours']).decision).toMatchObject({ promptId: 'confirm_dtmf' });
    expect(afterTurns([...HAPPY, 'what are your hours', 'what are your hours', 'what are your hours']).decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });
  it('takes 1 and 2 on the keypad', () => {
    expect(afterTurnsAndDtmf([...HAPPY, 'what are your hours', 'what are your hours'], '1').decision).toMatchObject({ kind: 'complete' });
    expect(afterTurnsAndDtmf([...HAPPY, 'what are your hours', 'what are your hours'], '2').decision).toMatchObject({ promptId: 'ask_change' });
  });
  it('queues an added intent on yes and bridges after the completion', () => {
    const r = afterTurns([...HAPPY, 'yes, and also my bill']);
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'billing' });
    expect(r.decision.completed).toEqual(['reschedule']);
  });
});
```
`HAPPY` is the three-utterance reschedule path above; `afterTurns` runs them through `resolve` with the heuristic stub (it handles yes/no, weekdays, providers, spoken digits, and the `changeSlot` keywords from Task 4); `turnAt(i)` returns the i-th result. `spokenText` from `src/prompts/render`. The stub's `intentChange` for "yes, and also my bill" needs `adding`: use a fixture entry via `FixtureStubClient` for that one utterance (label `change: 'adding'`, intent `billing`, context `reschedule`... a `confirm_reschedule` context entry cannot carry `change`, so add the entry as context `reschedule` with `change: 'adding'`: the stub looks entries up by text only).

- [ ] **Step 2: Implement `turn.ts`.**

Exports and helpers:
```ts
/** The summary's variables: every slot's display, empty when unfilled. */
export function summaryVars(s: Session): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const id of Object.keys(s.slots) as SlotId[]) vars[id] = s.slots[id].display ?? '';
  return vars;
}

function summaryPrompt(s: Session, form: FormId, acks: Ack[]): PromptDecision {
  return prompt(`confirm_${form}`, 'confirm', summaryVars(s), acks, ['yes', 'no']);
}

/** The form is full: ask the summary question (spec final-confirm §2.2) instead of completing. */
function askSummary(s: Session, form: FormId, acks: Ack[]): Decision {
  // Forms that end in a handoff have nothing to confirm; they hand off as before.
  if (FORMS[form].completion.kind === 'handoff') return completeForm(s, form, acks);
  s.pendingConfirmation = { target: 'form', form, attempts: 0 };
  return summaryPrompt(s, form, acks);
}
```
`completeForm` uses `summaryVars(s)` in place of its local loop and marks every slot confirmed before pushing the form: `for (const id of Object.keys(s.slots) as SlotId[]) if (s.slots[id].value !== null) s.slots[id].confirmed = true;`.

`continueForm`: `if (next.kind === 'complete') return askSummary(s, s.form!, acks);` (was `completeForm`).

`reaskConfirmation` gains the form branch before the intent one:
```ts
  if (pc.target === 'form') {
    if (!count) return summaryPrompt(s, pc.form, acks);
    pc.attempts += 1;
    const step = retryStep(pc.attempts, t);
    if (step === 'agent') { s.pendingConfirmation = null; return handoff(s, 'max-attempts', acks); }
    if (step === 'dtmf') return prompt('confirm_dtmf', 'confirm', {}, acks, ['1', '2']);
    return summaryPrompt(s, pc.form, acks);
  }
```

`failAttempt`: `if (target === 'confirm') return reaskConfirmation(s, t);` as the first line (a confirm target with no pending state cannot happen; guard with `s.pendingConfirmation?.target === 'form'` and fall through to `'intent'` otherwise).

`handleVerdict`:
- `'confirmed'`: at the top, `const queue = verdict.queue;` and a form branch:
```ts
      if (pc.target === 'form') {
        const acks = enqueue(s, queue);
        return { decision: completeForm(s, pc.form, acks), events: [] };
      }
```
- `'rejected'` form branch:
```ts
      if (pc.target === 'form') {
        const acks = enqueue(s, verdict.queue);
        const fill = fillSlots(s, answers, ctx, slotsFor(pc.form));
        if (fill.progress) return { decision: continueForm(s, [...acks, ...fill.acks], fill.disambiguate), events: fill.events };
        // Nothing usable came with the no: ask what to change and keep the summary pending.
        s.pendingConfirmation = pc;
        return { decision: prompt('ask_change', 'confirm', {}, acks), events: fill.events };
      }
```
(`pc` was cleared at the top of the case; re-set it for the ask-change path. `continueForm` after a correction re-runs `askSummary`, which creates a fresh `{attempts: 0}`, which is the reset the spec asks for.)
- new `'change_slot'`:
```ts
    case 'change_slot': {
      s.pendingConfirmation = null;
      const st = s.slots[verdict.slot];
      Object.assign(st, emptySlot(), { attempts: st.attempts });
      return { decision: askSlot(verdict.slot, null, []), events: [] };
    }
```
- `'confirm_unanswered'`: unchanged (it now also serves the form target via `reaskConfirmation`).
- `'proceed'` while a form confirm is pending cannot occur (gates map it), but keep the code as is.
- `'route'` with `verdict.queue`: after `enterForm(...)` returns, queue it: simplest is to pass the queue into `enterForm` as an extra ack: `const acks = enqueue(s, verdict.queue)` before `enterForm`, and have `enterForm` take `extraAcks: Ack[]` prepended to its acks (before `ack_intent`). For an explicit-confirm route the queue is ignored (spec §4).

`enqueue` helper (extract from the existing `queue` case so both use it):
```ts
/** Add an intent the caller asked for on the side; returns the ack to speak, if it was new. */
function enqueue(s: Session, intent: FormId | undefined): Ack[] {
  if (intent === undefined || intent === s.form || s.queued.includes(intent)) return [];
  s.queued.push(intent);
  return [{ promptId: 'ack_queued', vars: { intentLabel: INTENT_LABELS[intent] } }];
}
```

`handleDtmf`, before `applyDtmf`:
```ts
  if (s.promptedFor === 'confirm' && s.pendingConfirmation?.target === 'form') {
    const pc = s.pendingConfirmation;
    s.dtmfBuffer = '';
    if (digit === '1') { s.pendingConfirmation = null; return { decision: completeForm(s, pc.form, []), rows: [] }; }
    if (digit === '2') return { decision: prompt('ask_change', 'confirm', {}, []), rows: [] };
    return { decision: reaskConfirmation(s, tc.thresholds), rows: [] };
  }
```

`bookkeep`: unchanged (`promptedFor = decision.target` already carries `'confirm'`).

`memberId.ts`: `spokenConfirm: 'summary'`.

`manifest.json`: `schedule_confirmed` → `"You're booked."`, `reschedule_confirmed` → `"Your appointment is moved."`, `cancel_confirmed` → `"Your appointment is cancelled."`; `appointment_details` unchanged; delete `confirm_memberId`. `tags.json`: remove `confirm_memberId.0`/`.1`; the completion ids collapse to `.0` (`[relaxed]`); run `pnpm -s prompts:sheet` and fix the keys until the tags test passes. Snapshot `-u`.

`runner.ts`: import `summaryVars` from `../core/turn` and delete the local copy.

- [ ] **Step 3: Scenarios and baseline.** In `fixtures/scenarios/core.json`, every scenario whose last step reached a completion now stops at the summary; append a `{"say": "yes"}` step to each so the expectation (completion, handoff via queue, text) holds. The member-ID confirm scenarios become: `memberId-confirm-yes` → id `summary-yes`, steps `Cancel my appointment` / ID / `Dr. Patel` / `yes`, expect `complete cancel_confirmed`; `memberId-confirm-no-to-keypad` → `summary-no-memberId-corrected`: same, then `no, my member ID is four four seven one eight two nine four`, `yes`; expect `slots.memberId: '44718294'`. Scenarios that checked an ID readback text (`"Member ID four four seven one"`) now check the summary text (`"member ID 4471 8293"` appears in `spokenText` of the summary turn before the `yes` is appended; adjust `expect.text` to the completion line or drop it). Then:

```bash
pnpm regress --update
```
Inspect the diff of `fixtures/expected/*.json`: corpus outcomes change ONLY for entries whose utterance completed a form (their `decision` goes from `complete` to `prompt confirm_<form>`) and for entries on the `memberId` slot (acks/promptId no longer `confirm_memberId`); scenarios change as edited. List every changed corpus id in the report. Server tests: update the worked-example expectations in `src/server/server.test.ts` and `src/server/adapter.test.ts` (they assert the completion turn; add the `yes` turn and the new texts).

- [ ] **Step 4:** `pnpm test`, `pnpm typecheck`, `pnpm regress` (no changes against the new baseline). Commit:

```bash
git add src/core/turn.ts src/core/turn.test.ts src/domain/slots/memberId.ts src/prompts/manifest.json src/prompts/tags.json src/prompts/__snapshots__/clips.test.ts.snap src/prompts/render.test.ts fixtures/scenarios/core.json fixtures/expected src/server/server.test.ts src/server/adapter.test.ts src/harness-text/runner.ts
git commit -m "feat(core): summary question before completion; corrections reopen slots; silent member ID; re-record the label baseline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Corpus entries and scenarios for the new turns

**Files:**
- Modify: `fixtures/corpus.jsonl`, `fixtures/scenarios/core.json`, `fixtures/expected/*.json`

- [ ] **Step 1: Corpus entries** (ids `fc-` for confirm turns, `si-` for second intents; texts must not duplicate existing entries after normalization):

```jsonl
{"id":"fc-01","text":"yes","intent":"none","context":"confirm_reschedule","confirm":"yes"}
{"id":"fc-02","text":"yes that's right","intent":"none","context":"confirm_cancel","confirm":"yes"}
{"id":"fc-03","text":"yep book it","intent":"none","context":"confirm_schedule_new","confirm":"yes"}
{"id":"fc-04","text":"no","intent":"none","context":"confirm_reschedule","confirm":"no"}
{"id":"fc-05","text":"no that's wrong","intent":"none","context":"confirm_reschedule","confirm":"no"}
{"id":"fc-06","text":"no, Thursday","intent":"none","context":"confirm_reschedule","confirm":"no","slots":{"date":{"mode":"weekday","weekday":"thursday"}}}
{"id":"fc-07","text":"no, Thursday with Dr. Alvarez","intent":"none","context":"confirm_reschedule","confirm":"no","slots":{"provider":"alvarez","date":{"mode":"weekday","weekday":"thursday"}}}
{"id":"fc-08","text":"not Chen, Cheng","intent":"none","context":"confirm_reschedule","confirm":"no","slots":{"provider":"cheng"}}
{"id":"fc-09","text":"no, next week","intent":"none","context":"confirm_reschedule","confirm":"no","slots":{"date":{"mode":"window","window":"next_week"}}}
{"id":"fc-10","text":"the day","intent":"none","context":"confirm_reschedule","changeSlot":"date"}
{"id":"fc-11","text":"the doctor","intent":"none","context":"confirm_cancel","changeSlot":"provider"}
{"id":"fc-12","text":"my member ID","intent":"none","context":"confirm_reschedule","changeSlot":"memberId"}
{"id":"fc-13","text":"no, my ID is four four seven one eight two nine four","intent":"none","context":"confirm_reschedule","confirm":"no","slots":{"memberId":{"span":"four four seven one eight two nine four","value":"44718294"}}}
{"id":"fc-14","text":"what are your hours","intent":"other","context":"confirm_reschedule","confirm":"unanswered"}
{"id":"fc-15","text":"yes, and can I also ask about my bill","intent":"billing","context":"confirm_reschedule","confirm":"yes","change":"adding"}
{"id":"si-01","text":"I need to reschedule my appointment with Dr. Alvarez for next Thursday, and also I have a question about my bill","intent":"reschedule","context":"no_form","secondIntent":"billing","slots":{"provider":"alvarez","date":{"mode":"weekday","weekday":"thursday","weekdayQualifier":"next"}}}
{"id":"si-02","text":"Cancel my appointment and then I want to book a new one","intent":"cancel","context":"no_form","secondIntent":"schedule_new"}
{"id":"si-03","text":"I want to reschedule, just reschedule","intent":"reschedule","context":"no_form"}
```
Deviation: `fc-15` needs `change: 'adding'` on a confirm context; relax the Task 4 rule to allow `change` on confirm contexts (it is how an added intent is labeled everywhere else). Check `fc-06`'s date label shape against existing weekday entries in the corpus and match it.

- [ ] **Step 2: Scenarios** (append; `HAPPY` steps = "I need to reschedule my appointment, it's with Dr. Chen sometime next week", "four four seven one eight two nine three", "Tuesday"):

| id | steps after HAPPY | expect |
| --- | --- | --- |
| `summary-reschedule-yes` | yes | complete `reschedule_confirmed`, text "Your appointment is moved." |
| `summary-no-then-day` | no, the day, Friday, yes | complete, slots.date `2026-09-25` |
| `summary-no-with-value` | no, Thursday, yes | complete, slots.date `2026-09-24` |
| `summary-no-two-values` | no, Thursday with Dr. Alvarez, yes | complete, slots.provider `alvarez`, date `2026-09-24` |
| `summary-no-window` | no, next week, Wednesday, yes | complete, slots.date `2026-09-23` |
| `summary-memberId-corrected` | no, my ID is four four seven one eight two nine four, yes | complete, slots.memberId `44718294` |
| `summary-unanswered-reask` | what are your hours | prompt `confirm_reschedule` |
| `summary-unanswered-keypad-1` | what are your hours, what are your hours, dtmf 1 | complete |
| `summary-unanswered-keypad-2` | what are your hours ×2, dtmf 2, the doctor, Dr. Kim, yes | complete, slots.provider `kim` |
| `summary-unanswered-agent` | what are your hours ×3 | handoff `max-attempts` |
| `summary-yes-adds-billing` | yes, and can I also ask about my bill | handoff `billing`, form `billing` |
| `second-intent-first-utterance` | (own steps) si-01 text, four four seven one eight two nine three, yes | handoff `billing`, text "Sure, we'll ask about billing after this." is spoken on turn 1: check with `expect.text` on the LAST turn only, so assert `reason: 'billing'` and `form: 'billing'` |
| `second-intent-tentative-ignored` | "maybe reschedule, and also my bill" (add a corpus entry `si-04` with `tentative: true`, `secondIntent: billing`), yes | prompt `ask_memberId`, form `reschedule`, and `queued` empty is not checkable via expect; assert via a core test in Task 5 instead |

Dates assume `REGRESS_TODAY = 2026-09-18` (a Friday); verify each weekday's ISO date with `describe`/`resolveDate` behavior in an existing date test before pinning.

- [ ] **Step 3:** `pnpm regress --update`, inspect the diff (only the new ids), `pnpm test`, `pnpm typecheck`. Commit:

```bash
git add fixtures/corpus.jsonl fixtures/scenarios/core.json fixtures/expected
git commit -m "fixtures: summary-turn corpus entries and scenarios; second intent on the opening utterance

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: README and the deviation record

**Files:**
- Modify: `README.md`, this plan

- [ ] **Step 1: README.** In `### Confirmation and multi-intent`: replace the member-ID always-confirm paragraph with the summary: every form ends with a summary question ("Your appointment with Dr. Chen would move to Tuesday, September 22, member ID 4471 8293. Shall I make that change?"); yes completes; "no, Thursday" or "no, Thursday with Dr. Alvarez" corrects and re-asks; a bare no asks "What should I change?"; unanswered turns re-ask, then offer 1/2 on the keypad, then hand off; the member ID is filled silently and confirmed there. Add the second-intent paragraph: an opening utterance that names two tasks queues the second ("Sure, we'll ask about billing after this."). In the Regression section's label paragraph, add the `confirm`, `changeSlot`, and `secondIntent` labels and the `confirm_<form>` context. In the live-call checklist, insert the confirm turn after step 8 and the two-task opening line as a new step. Update the worked example wherever it shows the completion turn.

- [ ] **Step 2: Deviation record.** Append `## Deviations recorded during execution` in the format of the previous plans, from the task reports (the `confirm_appointment` summary text without a date; `change` allowed on confirm contexts; anything else reported).

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/plans/2026-09-19-final-confirm.md
git commit -m "docs: final confirm, silent member ID, second intent; record plan deviations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Final review, then Jason's steps

- [ ] Whole-branch review (spec coverage, `pnpm regress` diff limited to the expected turns, no `src/server` source changes beyond tests).

### Task 10 (Jason, not an agent): clips, cassette, live call

1. `pnpm prompts:check` lists 16 new clips as missing (the four summary
   prompts' fixed segments, `ask_change.0`, `confirm_dtmf.0`) and 4
   completion clips as stale (`schedule_confirmed.0`, `reschedule_confirmed.0`,
   `cancel_confirmed.0`, `appointment_details.0` — the last is stale too
   because `appointment_details` was shortened, a deviation from spec §5;
   see the deviation record below). Generate:

```bash
set -a; source .env; set +a; pnpm prompts:generate
set -a; source .env; set +a; pnpm prompts:generate --only schedule_confirmed.0,reschedule_confirmed.0,cancel_confirmed.0,appointment_details.0 --force
```
then `pnpm prompts:check` (67 of 83 → 83 of 83, 0 stale), and remove the 10
clips it reports as `unused`: `confirm_memberId.0`, `confirm_memberId.1`
(the readback prompt is gone), and the now-single-segment completions'
leftover `.1`/`.2` files (`schedule_confirmed`, `reschedule_confirmed`,
`cancel_confirmed`, `appointment_details`).

2. Re-record the cassette (every completing scenario's tail and the two-task openers):

```bash
set -a; source .env; set +a; pnpm regress --client record --threshold JEV_TIMEOUT_MS=15000
```
then `pnpm regress --client recorded` (no misses). Commit `assets/audio`, `assets/audio/recorded.json`, and `fixtures/recorded/jev-1.13.0.jsonl`.

3. Live call: the reschedule path ends with the summary; say "no, Thursday" once, then "yes". A second call opening with "...and also I have a question about my bill" should say "Sure, we'll ask about billing after this." before the ID question and hand off after the yes.

---

## Self-review

- Spec coverage: §2.1 state (Task 1), §2.2 flow and §2.3 corrections (Tasks 5–6), §2.4 ladder and keypad (Task 6), §3 summary policy (Tasks 1, 6), §4 second intent (Tasks 3, 5, 6 route queue, 7), §5 prompts (Tasks 2, 6), §6 questions and thresholds (Tasks 1, 3), §7 labels and scenarios (Tasks 4, 6, 7), §8 baseline unchanged, §9 tests per task, §10 README (Task 8).
- Names used across tasks: `PendingConfirmation` form variant `{ target: 'form', form, attempts }`; `promptedFor: 'confirm'`; `spokenConfirm: 'summary'`; verdicts `confirmed`/`rejected`/`confirm_unanswered` with `queue?`, `change_slot`, `route` with `queue?`; questions `changeSlot`, `secondIntent`; thresholds `SLOT_CHANGE`, `INTENT_SECOND`; corpus fields `confirm`, `changeSlot`, `secondIntent`, contexts `confirm_<form>`; helpers `summaryVars`, `askSummary`, `summaryPrompt`, `enqueue`; prompts `confirm_<form>`, `ask_change`, `confirm_dtmf`.
- Green after every task: Tasks 1–5 change no decisions (verified by `pnpm regress` no changes); Task 6 re-records in the same commit.

---

## Deviations recorded during execution

- **Task 1 (610aee7).** Extra files beyond the task's list: `src/core/turn.ts` gained type guards
  and a `promptedTarget` helper mapping `null`/`'intent'`/`'confirm'` to `'intent'`, needed early so
  later tasks share one place that answers "what is this turn's attempt bucket"; `sweepSpace.test.ts`'s
  sweepable-threshold count moved from 20 to 22 for `SLOT_CHANGE` and `INTENT_SECOND`.
- **Task 2 (6aa3816).** The plan's `confirm_${form}` naming is a map instead: `FormSpec.summaryPromptId`
  (`src/domain/forms.ts`) gives `schedule_new` → `confirm_schedule`, `reschedule` → `confirm_reschedule`,
  `cancel` → `confirm_cancel`, `confirm_appointment` → `confirm_appointment_details`, and `billing` →
  `null` (it hands off, so it has no summary). `confirm_appointment` has no date slot
  (`FORMS.confirm_appointment.slots` is `['memberId', 'provider']`), so its summary cannot say a date;
  its text is `"That's your appointment with {provider}, member ID {memberId}. Is that the one?"`
  instead of the spec's text (spec §5).
- **Task 3 (43e87fc, e7fac8c).** `changeSlot`'s criteria were rewritten to stay disjoint from
  value-giving answers (drop "not Tuesday" / "not Dr. Chen" as examples of naming a detail, since
  those *are* new values) and are filtered to the slots on the form actually being confirmed —
  `confirm_cancel` and `confirm_appointment_details` have no `date` option. `secondIntent`'s criteria
  are prefixed "A second, separate request on top of the main one: …" and its `none` covers a request
  described twice or elaborated on, not just "no second task"; the instructions name the joining cues
  ("and also", "as well", "another thing", "while I have you").
- **Task 4 (9a7c0c7, df1f192).** `confirmForm`/`contextForm` (`src/jev/corpus.ts`) are exact
  membership against a map of `confirm_<form>` → `form` for every form with a `summaryPromptId`, not a
  `startsWith('confirm_')` prefix test — `confirm_appointment` is itself a form (one of `FORM_INTENTS`),
  so a prefix test would misparse it as the confirm context for a nonexistent form named "appointment".
  This makes `confirm_confirm_appointment` the (unusual but valid) summary context for the
  `confirm_appointment` form. `change` (`adding`/`replacing`) is allowed on `confirm_<form>` contexts,
  not only in-form ones — an added intent at the summary ("yes, and can I also ask about my bill") is
  labeled the same way as an in-form "also", so `fc-15` in Task 7 needs it. The corpus already rejected
  two entries whose text is the same after normalization (a pre-existing rule, since the fixture stub
  looks answers up by that text); several of Task 7's drafted ids collide with existing entries under
  it (see below).
- **Task 5 (bdb357f, e85ec5f).** `change_slot` additionally requires the named slot to actually be on
  the active form's slot list (`FORMS[form].slots`), so the verdict can never name a slot the form
  doesn't have. The row credited with deciding a summary turn is the `confirmation` row (yes/no) or the
  `changeSlot` row, not the `intent` row that gate 8 computes — the gates' existing "only if nothing
  decided yet" convention is extended so the debug table and `decidedGate` point at whichever question
  actually settled the summary. `change_slot` carries the `queue` field forward like `confirmed`/
  `rejected` do, so an added intent named at the same time as a correction is not lost. Spec §4 lists
  `agent` as a second task the caller could name, but the `secondIntent` question only offers
  `FORM_INTENTS` (which excludes `agent`); "agent" as a second request still works, just via the
  existing `wantsHuman` gate rather than `secondIntent`.
- **Task 6 (3962773, b6b646b, 0693c16).** `fillSlots` gained a `{ correcting?: boolean }` option: at
  the summary, a window over an already-filled date must reopen that slot even though it already has a
  value, which the ordinary mid-form fill (value only overwrites `null`) would not do. A fill that
  reproduces exactly what the summary just read back (a repeated "Thursday" after the caller was
  already told Thursday) does not count as progress — `correctingFill` snapshots the summary's
  variables and the date window before and after the fill and only accepts it as a correction if
  something actually changed; otherwise it is treated as an unanswered turn, so repeating the same
  value cannot stall the ladder forever. `PendingConfirmation`'s form variant gained `askedChange?:
  boolean`, set the first time `ask_change` is asked; `ask_change` occupies the ladder's first rung
  (`attempts` is bumped to at least 1 when it is asked) so that a bare "no" followed by three more
  bare no's still reaches an agent in four turns total, not seven. The keypad only answers 1/2 while a
  digit is actually advertised — the summary itself ("yes or no"), `confirm_dtmf`, or
  `system_slow_dtmf_hint` (which also mentions the keypad) — a stray digit at `ask_change` answers
  nothing and is ignored rather than counted as a miss. `handoff()`'s data now carries every filled
  slot's display value (`HandoffDecision.slots`), not just the completed forms and the queue, since a
  form that hands off (billing) has no summary of its own to have told the caller anything back — this
  is the only record of what was collected. `appointment_details`'s completion line was shortened to
  "That appointment is confirmed." even though spec §5 says to keep its details (it is the answer to
  the caller's question); the confirm-first flow already reads the details back in
  `confirm_appointment_details` before the caller says yes, so repeating them a second time in the
  completion line felt redundant, but this is a deviation from what the spec says. A summary answer
  that names a detail reopens it, whether or not it is phrased as a no: the confirmation gate reads
  `changeSlot` before it settles for a plain `rejected`, so "no, the doctor is wrong" clears the
  provider and asks `ask_provider` rather than "What should I change?". Only a new value for the
  *named* slot answers the question outright — "the doctor, Thursday" moves the date and still leaves
  the doctor to ask for, and re-speaking the value the summary just read back reopens the slot rather
  than re-arming the summary. A no that carries a value and names nothing ("no, Thursday") is a plain
  correction as before: the date moves and the summary is re-asked. Baseline re-record: 44 corpus outcomes changed (a
  `confirm_memberId` readback became either the next question, a summary, or a billing handoff, and
  every `complete` outcome for a form with a summary became a `prompt confirm_<form>`); only the
  `decision`/`promptId`/`reason` fields moved.
- **Task 7 (5efaaac).** `fc-01` ("yes"), `fc-04` ("no"), and `fc-05` ("no that's wrong") from the
  plan's draft list duplicate existing corpus entries (`cy-01`, `cno-01`, `cno-02`) once normalized, so
  the parser's (pre-existing) duplicate-text check rejects them; they were dropped rather than given
  different text, since the existing entries already cover a plain yes/no. `fc-14` ("what are your
  hours") was dropped for the same reason: it normalizes to the same text as `ot-01`.
- **General.** `SlotSpec.spokenConfirm`'s `'always'` value (spec §3) is now unused by any slot — the
  member ID was its only user and moved to `'summary'`. It stays in the type and keeps unit coverage
  (`reaskConfirmation`'s slot branch, `pendingSlotConfirmation`) since a future slot can still opt into
  it, but doing so needs its own `confirm_<slotId>` prompt manifest entry: `reaskConfirmation` and
  `continueForm` both build that prompt id directly, and the one entry that used to satisfy it,
  `confirm_memberId`, was removed in Task 6.
- **Post-review.** On the real model, the summary-turn correction "not Chen, Cheng" scored
  `addressedToSystem` 0.62 against gate 0.70, `confirmsNo` 0.23, and `provider` none 0.80 / cheng 0.18,
  so it was ignored, while a fuller correction ("no, Thursday with Dr. Alvarez") scored 0.95 / 0.97 /
  1.00 on the same three questions. The fix is wording, not logic: terse fragments that answer the
  system's own question need to read as addressed to it, as a no, and as the corrected name.
  `addressedToSystem` and `confirmsNo` (`src/core/questions.ts`) each gained explicit `true`/`false`
  criteria naming a short answer or correction — a name, a day, a number, a yes or no, or a bare
  correction — as addressed and as a no; `provider`'s instructions (`src/domain/slots/provider.ts`)
  now tell the model that the word not marks the name being rejected and to choose the other one, with
  one example per direction ("not Chen, Cheng" and "Okafor, not Nguyen") so the wording does not lean
  on a single pair. `dateWeekday`, `dateMonth`, `dateDay`, `dateWeekdayQualifier`, `dateRelativeDay`,
  and `dateWindow` (`src/domain/slots/date.ts`) gained the same not-marks-the-rejected-one phrasing,
  since a bare day or month correction is just as plausible as a provider one; `dateMode` was left
  alone, since it classifies the shape of the answer rather than a specific named value, so a "not X,
  Y" correction does not apply to it. A later wording pass tightened the rule further: every question
  with more than two labels gets two examples, one in each order ("not X, Y" and "Y, not X"), resolving
  to two different labels and using values no fixture leans on — never a placeholder value, never an
  id's exact text — while a question with an unordered or three-way label set (`dateWeekdayQualifier`,
  `dateWindow`, `dateRelativeDay`) gets one unloaded example instead, since a second one adds no new
  direction to check. That pass replaced `provider`'s second example (`"Alvarez, not Patel"`) because
  Patel is the placeholder name the corpus's confirm-context stub always fills the form with (visible
  in `fixtures/expected/corpus.json` as every `confirm_reschedule` entry's default `provider`), so an
  example built from it was really a second, disguised copy of the placeholder rather than an
  independent check; `dateDay`'s example moved to numerals ("the 5th", "the 6th", "the 20th", "the
  12th") to match its labels, which are digit strings, not spelled-out ordinals. Four corpus entries
  were added at `confirm_reschedule` to cover the terse forms: `fc-17` ("Cheng, not Chen", no/provider
  cheng), `fc-18` ("Thursday, not Tuesday", no/date thursday), `fc-19` ("it's Cheng", no/provider
  cheng), and `fc-20` ("Dr. Cheng", no/provider cheng) — `fc-20`'s text did not duplicate any existing
  entry after normalization, so it did not need the fallback "make it Dr. Cheng" wording; `fc-19` and
  `fc-20` are labeled `confirm: 'no'` because each replaces the provider the summary read back, which
  `confirmsNo`'s new criterion defines as a no whether or not the caller says the word. Because
  `addressedToSystem` and `confirmsNo` are asked on nearly every turn (`addressedToSystem` is in
  `ALWAYS_ON_IDS`; `confirmsNo` on every confirmation turn), the recorded cassette must be fully
  re-recorded rather than patched for the affected turns.

  A review pass on this wording flagged that the corpus summary always reads back the placeholder
  Dr. Patel, so a real-model score on `fc-08` ("not Chen, Cheng", the example embedded verbatim in
  `confirmsNo`'s and `provider`'s criteria) is not evidence that the class of terse corrections is
  fixed — the model could simply be matching the criteria text back to itself. `fc-17` (the same pair,
  reversed order), `fc-19`, and `fc-20` (no "not" at all, just a replacement value) are the actual
  generalization tests, since none of their text appears in the criteria; `fc-18` ("Thursday, not
  Tuesday") joined that list once the later wording pass moved `dateWeekday`'s examples to "not Monday,
  Friday" and "Saturday, not Sunday", so `fc-18`'s own text no longer appears in any instruction either.
  The same re-record is also expected to move `ns-02`, `ns-03`, and `ns-04` (side speech, a bare "um",
  and a garbled utterance) — `addressedToSystem`'s reworded false criterion ("even when what they say
  is about the call") and the dropped "fragmentary" language from its true criterion could shift a
  borderline score either way, so any change to those three ids on the next cassette must be judged
  against the new wording, not assumed to be a regression.
