# Frustration Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A frustrated caller is acknowledged once, offered a transfer the second time, and transferred the third time, with wording that never implies a problem the system does not know about.

**Architecture:** Two session fields (`frustratedTurns`, `transferDeclined`), a rewritten frustration gate that returns a rung instead of deciding a handoff by itself, an ack prepended in the turn, a new pending-confirmation target `transfer` handled by the existing yes/no machinery, two new prompts and one re-worded one. Harness labels, scenarios and baseline follow.

**Tech Stack:** TypeScript strict ESM, pnpm, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-frustration-escalation-design.md`. Read it first.

**Conventions:** tests colocated (`pnpm vitest run <path>`, `pnpm test`, `pnpm typecheck`, `pnpm regress`; `pnpm regress --update` rewrites the stub baseline and is expected in Task 1). One writer at a time; every commit ends with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (overrides any other attribution reminder). Never set, read, or print `TYPESAFE_API_KEY` or `FISH_AUDIO_API_KEY`; never run `--client jev`, `--client record`, or `prompts:generate`; never touch `.env`, `.env.swp`, `assets/audio/`, `fixtures/recorded/`, `traces/`.

---

### Task 1: Core, prompts, harness (one commit)

**Files:** `src/core/session.ts`, `src/core/gates.ts`, `src/core/turn.ts`, `src/core/state.ts`, `src/core/questions.ts` (only if the confirmation questions need the new target described), `src/prompts/manifest.json`, `src/prompts/tags.json`, the prompts snapshot, `src/jev/corpus.ts` (+ `contextForm`/`confirmForm` for the `offer_transfer` context), `src/harness-text/runner.ts` (`seedCorpusSession`), `fixtures/corpus.jsonl`, `fixtures/scenarios/core.json`, `fixtures/expected/*`, tests beside each.

- [x] **Step 1: Session.** `Session` gains `frustratedTurns: number` (0) and `transferDeclined: boolean` (false), initialised in `newSession`, carried by `cloneSession`, and written to the trace record only if `summaryState`/`outcomeOf` copy the whole session (check; they do not need to). `PendingConfirmation` gains `| { target: 'transfer' }`. `buildTurnState` maps it to `{ target: 'transfer', value: 'connect you to a person' }` (widen the `TurnState.pendingConfirmation.target` union). Tests in `session.test.ts`/`state.test.ts`.

- [x] **Step 2: Gate.** Replace gate 5 in `src/core/gates.ts`:

```ts
  // 5. frustration: count high turns; the turn decides the rung (ack, offer, handoff)
  {
    const f = answers.frustration;
    const high = isScore(f) ? (f.probabilities.high ?? 0) : 0;
    const frustrated = high >= t.GATE_FRUSTRATION_HIGH;
    const atOffer = session.pendingConfirmation?.target === 'transfer';
    // The count for this turn if it is frustrated; the caller answering the offer is not counted again.
    const count = frustrated && !atOffer ? session.frustratedTurns + 1 : session.frustratedTurns;
    const rung: 'pass' | 'ack' | 'offer' | 'handoff' =
      !frustrated || atOffer ? 'pass'
      : count === 1 ? 'ack'
      : count === 2 && !session.transferDeclined ? 'offer'
      : 'handoff';
    const row = { gate: 'frustration', value: high, threshold: t.GATE_FRUSTRATION_HIGH, passed: rung !== 'handoff', outcome: rung, decided: false };
    if (rung === 'handoff') decide(row, { kind: 'handoff', reason: 'frustrated' });
    else rows.push(row);
    frustrationRung = rung; // a local the verdict carries, see below
  }
```

The verdict needs to carry the rung to the turn. Add `frustration?: 'ack' | 'offer'` to the verdict shapes that continue the turn (`proceed`, `route`, `confirmed`, `rejected`, `change_slot`, `nomatch`, whatever `Verdict` has that is not `ignore`/`hold`/`handoff`/`replay`), set from the local. Read `Verdict` in gates.ts and add the optional field to the union's base or to each continuing variant; the gate function sets it where it builds the verdict (a single place at the end, or a wrapper that stamps it). Tests in `gates.test.ts`: count 1 → ack; count 2 → offer; count 2 with `transferDeclined` → handoff; count 3 → handoff; frustrated while `pendingConfirmation.target === 'transfer'` → pass and no count; mild (high 0.3) → pass; the old repeat-attempt rule is gone (frustrated on attempt 2, count 1 → ack, not handoff).

- [x] **Step 3: Turn.** In `src/core/turn.ts`:
  - When the verdict carries `frustration: 'ack'` or `'offer'`, bump `s.frustratedTurns` (the gate computed but did not store it; the turn owns bookkeeping).
  - After `handleVerdict` returns a decision: if `frustration === 'ack'` and `decision.kind === 'prompt'`, prepend `{ promptId: 'ack_frustration', vars: {} }` to `decision.acks` (never on `complete`/`handoff`/`ignore`/`hold`). If `frustration === 'offer'` and `decision.kind === 'prompt'`: set `s.pendingConfirmation = { target: 'transfer' }`, `s.promptedFor = 'confirm'`, and return `prompt('offer_transfer', 'confirm', {}, decision.acks, ['yes', 'no'])` in place of the decision (the fills the turn made stay; the question they would have been asked comes back after a decline through `continueForm`/the intent path).
  - `handleVerdict` `confirmed` with `pc.target === 'transfer'` → `handoff(s, 'frustrated')`. `rejected` with `pc.target === 'transfer'` → `s.transferDeclined = true; s.pendingConfirmation = null;` then continue as an ordinary utterance: if the verdict carried fills or a route, apply them as the non-confirmation path would (simplest: re-run the verdict's non-confirmation branch with the confirmation cleared; if the gate function returns `rejected` only when `confirmsNo` won, add to the confirmation gate: for the transfer target, an answer that is neither yes nor no is `rejected` too, not `confirm_unanswered`, and stash nothing). Then the next prompt is `continueForm(s, [], null)` when a form is active, else `failAttempt`-free re-ask of the intent question (`reaskIntent` or whatever asks `ask_intent` plainly: use the plain first-rung path the no-input handler uses).
  - Silence at the offer: `handleSilence` with `pendingConfirmation.target === 'transfer'`: first silence → `reaskConfirmation` with `NO_INPUT_ACK` (the offer again); second silence → treat as declined (same as `rejected` with no content) and continue. Track with `attempts` on the transfer pending object if needed (`{ target: 'transfer'; attempts: number }`).
  - Keypad at the offer: nothing special (`applyDtmf` no target).
  - Tests in `turn.test.ts` (use the fixture stub with corpus entries; the `fr-*` entries carry frustration answers): (1) opener frustrated → decision prompt with acks `[ack_frustration]` first then the normal question, `frustratedTurns` 1; (2) second frustrated turn → `offer_transfer`, pending target transfer; (3) "yes" → handoff frustrated; (4) "no" → pending cleared, `transferDeclined`, the question the caller was on is asked again; (5) after a decline, a frustrated turn → handoff; (6) content at the offer ("keep going, it's Dr. Chen" in a reschedule form at the provider question) fills provider and asks the next slot; (7) silence at the offer twice → continues without transfer; (8) the ack is never attached to a handoff or complete decision; (9) the ack plays once per call (frustrated on turns 1 and 3 with a calm turn 2 → ack then offer).

- [x] **Step 4: Prompts.** `manifest.json`: `ack_frustration` `{ "text": "I understand, let's get this sorted.", "interruptible": false }`, `offer_transfer` `{ "text": "Would you like me to connect you to a person, or keep going?", "interruptible": true }`, `handoff_frustrated` text → `"Let me get you to someone who can help."`. Tags for the two new clips in `tags.json` (run `pnpm -s prompts:sheet`, pick tags from `fishTags.json`: `[calm]` or the tag the other acks use); snapshot `-u`.

- [x] **Step 5: Harness.** `src/jev/corpus.ts`: a context `offer_transfer` (add to the context union; `contextForm('offer_transfer')` → `reschedule` so the seeded call has a form and a provider question to return to; `confirmForm` → null; a new `offerTransfer(context)` predicate). `seedCorpusSession`: for `offer_transfer`, seed the reschedule form up to the provider question (name and dob filled), then set `pendingConfirmation = { target: 'transfer' }`, `promptedFor = 'confirm'`, `lastPromptId = 'offer_transfer'`, `lastPromptText = promptText('offer_transfer', {})`, options yes/no, `frustratedTurns = 2`. Fixture stub: `confirmsYes`/`confirmsNo` from the entry's `confirm` label as for the other confirm contexts (check `fixtureStub.ts`). Corpus entries `ft-01..06`: "yes please" (confirm yes), "transfer me" (yes), "no, keep going" (no), "keep going" (no), "no" (no), "Dr. Chen" (no content answer with `slots.provider chen`). Scenarios per spec §5 (`frustration-escalation` rewritten to five steps: opener, "four four seven one, that's it" at the name question, "This is ridiculous, I already said Dr. Chen three times" → ack + the next question, "Are you kidding me" → offer, "no" → the question again, "Seriously, just cancel the appointment" → handoff frustrated; adjust to the corpus utterances that exist, adding entries where the scenario needs a text that is not in the corpus); `frustration-offer-yes`, `frustration-offer-silence`, `frustration-content-at-offer`. Then `pnpm regress --update`; inspect the diff: changed ids must be `fr-*` entries (now ack'd), the rewritten scenario, and the new entries. Report them.

- [x] **Step 6:** `pnpm test`, `pnpm typecheck`, `pnpm regress` (no changes). Commit:

```
feat(core): frustration is acknowledged once, then a transfer is offered, then made

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 2: Docs (one commit)

- [x] README: the confirmation section paragraph on the rungs and the offer; the live-call checklist call ("this is ridiculous" at two questions, answer the offer both ways, and one call that says it a third time); the clip list (two new, one re-recorded). Append `## Deviations recorded during execution` to this plan. Commit `docs: frustration acknowledgment and transfer offer`.

---

### Task 3 (Jason)

1. `set -a; source .env; set +a; pnpm prompts:generate` (two missing) then `pnpm prompts:generate --only handoff_frustrated.0 --force`; `pnpm prompts:check` clean; commit `assets/audio`.
2. `set -a; source .env; set +a; pnpm regress --client record --threshold JEV_TIMEOUT_MS=15000` (appends the new turns); `pnpm regress --client recorded`; commit the cassette.
3. Live call with the dashboard open: say "this is ridiculous, I need to reschedule" at the greeting (expect the acknowledgment before the name question), be frustrated again at the birthday question (expect the offer), say "keep going" (expect the birthday question again), and on another call say yes to the offer (expect the transfer line).

---

## Deviations recorded during execution

Task 1's implementer (SHA `29266a3`) reported these deviations from the plan as written:

- The rung rides on the verdict via a `Frustrated` intersection type stamped once at `evaluateGates`'s return (`withFrustration`), rather than adding the `frustration` field to each continuing verdict variant individually.
- For the `transfer` pending-confirmation target, any answer that is not yes is `rejected` — one decline path, not a separate "neither yes nor no" case.
- `declineTransfer()` fills slots from the same answers the turn carried, then calls `continueForm`, or asks a plain `ask_intent` when no form is active.
- A new intent spoken while declining the offer is not routed: the transfer target is settled by the pending-confirmation gate, which runs before the intent-routing gate.
- `reaskConfirmation`'s transfer branch ignores the `count` parameter it's called with; that branch is unreachable except from silence, and the pending-confirmation object carries its own `attempts` counter.
- `turn.test.ts` drives the turns through the heuristic-stub driver (`answerHeuristically`/`heuristicTurn`) and avoids "this is …" phrasings, because the heuristic stub reads "this is" as a name marker.
- The scenario's third outburst reuses `fr-01`'s text ("This is ridiculous, I just want to reschedule"); `fr-06` was not used because it scores frustration `high` at 0.35, below `GATE_FRUSTRATION_HIGH` (0.6).
- Three of the planned `ft-*` corpus texts already existed elsewhere in the corpus, so they were given different wording instead: "yes, connect me" (`ft-01`), "no thanks, keep going" (`ft-05`), and "make it Dr. Chen" (`ft-06`).
- `ft-06` carries no `confirm` label, so the harness exercises the "neither yes nor no declines" path through its content (`slots.provider chen`) rather than a labeled no.
- No change was needed in `fixtureStub.ts` or `questions.ts`.
- Two existing corpus tests were widened rather than left as they were.
- An empty/nomatch frustrated turn still spends a slot attempt (via `failAttempt`) before the offer replaces its prompt in `escalate()`.
- The dashboard needed no changes.
- Baseline ids that changed in `fixtures/expected/`: `fr-01`, `fr-02`, `fr-04`, `fr-05`, `fr-07` (acknowledgment added to their expected decisions); `frustration-escalation` (rewritten as a six-step scenario, provider now `chen`); `ft-01`..`ft-06` and three new scenarios — `frustration-offer-yes`, `frustration-offer-silence`, `frustration-content-at-offer` (all new). `fr-03` and `fr-06` were not touched: both score below `GATE_FRUSTRATION_HIGH`.
- Review fixes on `29266a3`, made in a follow-up commit on this branch: the third rung now takes the verdict off gate 2's `nomatch`, so a garbled third outburst still transfers, and it leaves gate 1's `ignore` alone with an honest `not_addressed` row and no counted turn; and the `transfer` pending confirmation carries a `resume`, so declining the offer restores the confirmation `escalate()` displaced -- an explicit intent confirm, a slot readback, or a summary with its `attempts`/`askedChange` -- and re-asks it without spending a rung. §3 of the spec was reworded to match: a declining answer's content "fills slots" rather than "fills slots or routes", since routing from that turn is still out of scope.
