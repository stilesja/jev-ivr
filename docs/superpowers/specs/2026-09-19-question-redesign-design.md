# Design: Question redesign, multi-intent chaining, and slot confirmation

Date: 2026-09-19
Status: approved for planning
Parent: `JEV-IVR-HANDOFF.md` §6; builds on `2026-09-18-text-harness-design.md`
(core, corpus, regression) and `2026-09-18-real-model-regression-design.md`
(cassette). The findings it addresses come from the first real-model run,
recorded in `fixtures/recorded/jev-1.13.0.jsonl` and summarized in the plan
`2026-09-18-real-model-regression.md`.

## 1. Scope

The first real run showed that most disagreements between Jev and the corpus
labels are not threshold problems. Jev's intent Choice says which intent, not
how committed the caller is; the intelligibility question rejects digit
strings; the member-ID span instruction is read literally; hedged or dual
provider names fill at full confidence; a mid-form "can I also ask about my
bill" replaces the current task. This sub-project fixes the questions, adds
the two flow features those fixes need (queue-and-chain for added intents,
explicit confirmation of the member ID), extends the spoken-number converter
to chunked numbers, and corrects the scenarios and labels whose premise Jev
does not share. It ends with a re-recorded cassette and a re-recorded
baseline.

Out of scope: moving any existing threshold (the next sub-project sweeps
them against the new cassette), recorded audio, and the server's client-kind
list.

## 2. Questions

Question ids are for code; the wording is what Jev sees. All wording below
is normative.

### 2.1 `intentTentative` (Noul, always on; new)

Instructions: "Read asr.text. Does the caller express their request
tentatively, with words such as maybe, I guess, I think, possibly, or might,
rather than stating it plainly?"

Criteria:
- `true`: "The hedge is about what the caller wants done, as in maybe cancel
  it or I guess I need to cancel"
- `false`: "The request is stated plainly, even if the caller hedges about a
  detail such as a date, a provider name, or a number"

Consumed by the intent gate (§3). Threshold `INTENT_TENTATIVE`, placeholder
0.5.

### 2.2 `intentChange` (Choice, in-form only; replaces `intentSecondary`)

Asked only when `session.form` is set. `intentSecondary` is removed from the
schema, the stub, and the trace.

Instructions: "Read asr.text. The caller is in the middle of the task
described by `activeFormLabel` and was just asked `node.promptJustPlayed`.
Which best describes this utterance?"

Criteria:
- `answering`: "Answers or reacts to the question that was just asked,
  restates the current task, or says something incidental; anything that is
  not a request for a different task"
- `adding`: "Asks for an additional task to be handled as well, while
  keeping the current one, for example with also, as well, and another
  thing, or after this"
- `replacing`: "Abandons the current task in favour of a different one, for
  example with never mind, forget that, instead, or actually I just want"

`activeFormLabel` is a new `TurnState` field, the spoken intent label
already in state (`INTENT_LABELS`), used in place of `activeForm.label`
because `activeForm` is the form id string. Threshold `INTENT_CHANGE`,
placeholder 0.6: below it, the turn is treated as `answering`.

### 2.3 `intelligible` (rewording)

Instructions: "Read asr.text. Is the text words the caller actually said,
rather than garbled fragments or background noise?"

Criteria:
- `true`: "Any real utterance, including a single word, a yes or no, a
  name, a number, or a string of digits"
- `false`: "Garbled fragments, transcribed noise, or nothing but a filler
  sound such as um or uh"

### 2.4 `memberIdSpan` (rewording)

Instructions: "Read asr.text. Which of these spans is the member ID the
caller states? Choose the span that covers the whole number as spoken,
including number words like forty-four or three hundred fifty-five and
modifiers like double or triple. Do not include words that are not part of
the number. Choose none if no span is a member ID."

The `none` criterion text stays "No span of asr.text is a member ID".

### 2.5 `providerUnsure` (Noul, with the provider slot; new)

Instructions: "Read asr.text. Is the caller unsure which provider they
mean, or unsure of that provider's name?"

Criteria:
- `true`: "The caller hedges about the provider, as in it might be Dr. Kim
  or Dr. Rossi I think, or offers two names for one provider, as in Dr.
  Chen or Cheng, I am not sure"
- `false`: "The caller names a provider plainly, or names none. A caller
  correcting themselves, as in Dr. Chen, not Dr. Cheng, is sure, and so is
  a caller who hedges only about what they want done, as in maybe cancel it
  with Dr. Chen"

Threshold `PROVIDER_UNSURE`, placeholder 0.5.

## 3. Gate ladder and routing

### 3.1 Outside a form

After today's bands pick a route verdict from the intent probability, if
`intentTentative >= INTENT_TENTATIVE` and the verdict is `route` with
confirm `none` or `implicit`, the confirm becomes `explicit`. A tentative
`agent` or `repeat_prompt` is unaffected. The gate row records
`route_explicit:tentative` as the outcome so the trace shows why.

### 3.2 Inside a form

The in-form branch of the intent gate becomes:

1. Read `intentChange`. If its top label's probability is below
   `INTENT_CHANGE`, or the label is `answering`, the verdict is `proceed`
   regardless of the intent answer, with outcome `answering`.
2. `adding`: if the intent answer's top label is a form intent other than
   the active form, and its probability is at least `INTENT_IMPLICIT`, the
   verdict is the new `{ kind: 'queue', intent }` with outcome
   `queue:<intent>`. `agent` while adding is still a handoff. Otherwise
   `proceed`.
3. `replacing`: today's switch logic unchanged (`INTENT_SWITCH` for a silent
   switch, `INTENT_IMPLICIT` for an explicit one), except that a tentative
   replacement always confirms explicitly, as in §3.1.

`intentSecondary` no longer influences anything (it never did).

### 3.3 Explicit intent confirmation keeps the original utterance

`PendingConfirmation` for an intent gains `answers: AnswerMap` and
`text: string`, the routing utterance's slot answers and text. On
`confirmed`, `enterForm` fills slots from those stashed answers, not from
the "yes" turn's answers, so "maybe cancel it with Dr. Chen" followed by
"yes" enters the cancel form with the provider filled. The confirmation
turn's own slot answers are ignored (a caller saying "yes, Dr. Chen" is
rare and the next prompt catches it).

## 4. Queue and chain

### 4.1 Session

`Session.queued: FormIntent[]`, initially empty. A `queue` verdict appends
the intent unless it equals the active form or is already queued. The turn
speaks `ack_queued` ("Sure, we'll {intentLabel} after this.") as an ack
before the current prompt, but only when the intent was newly added to the
queue; an utterance that repeats an already-queued intent gets no second
ack. The slot fill for the turn proceeds as `proceed` would (the same
utterance may also answer the current question).

An intent added while an intent or slot confirmation is pending is queued
and acked the same way, and the confirmation itself is re-asked rather than
dropped, without counting an attempt: the caller talked past the yes/no
question to add a request, not to dodge it, so the retry ladder does not
move.

### 4.2 Completion

Completion prompts lose their trailing " Goodbye." and a new `goodbye`
prompt ("Goodbye.") carries it. The `complete` decision renders as before
(completion text, goodbye, `end` with reason `completed`) when the queue is
empty.

When the queue is non-empty, `completeForm` instead shifts the next intent
and returns a `prompt` decision whose acks are the completion text and
`bridge_next` ("Now, {intentLabel}."), followed by the next form's first
ask. The session enters the next form with `memberId` carried over
(value, display, confirmed) and `provider` and `date` cleared. If the next
form's completion is a handoff (billing), the form is entered and its
remaining slots asked as usual; the handoff happens at its completion.
Entering the next form removes it from the queue, the same as any other
switch into a form, so a queued intent cannot also be started a second time
from the queue. Because a form whose completion is a handoff ends the call,
a handoff-completion intent in the queue is always picked last, after every
intent whose completion is a prompt; only when nothing else is left does
the queue hand the caller over. When the intent being bridged into was
queued on this very turn, the completion line drops its own `ack_queued`
for that intent, so the caller does not hear "we'll get to billing after
this" immediately followed by "now, billing."

Handoff `end` frames' `handoffData` gains `completed: FormId[]`, the forms
finished on this call, and `queued: FormId[]`, intents the caller added
that the call never started, each omitted when empty, so the agent screen
can show what was already done and what is still owed.

### 4.3 Outcome and trace

The regression `Outcome` gains `queued: Intent[]` so a queued intent is
visible in the diff. The trace record already carries the session.

## 5. Slot confirmation policy

`SlotSpec` gains `spokenConfirm: 'always' | 'by-confidence'`. `memberId` is
`always`; `provider` and `date` are `by-confidence` (today's behavior,
extended by §5.3).

### 5.1 Always-confirm flow

`SlotOutcome`'s `filled` variant keeps only `confirm: 'none' | 'implicit'`;
there is no `explicit` outcome. Whether a spoken fill is read back is the
slot's own policy, not the fill outcome: `fillSlots` consults
`SLOTS[id].spokenConfirm`, and for an `always` slot it sets the slot's value
and display with `confirmed: false` and speaks no ack even when the outcome
says `confirm: 'none'`. `continueForm`, before asking the next missing slot,
looks for a filled, unconfirmed `always` slot (`pendingSlotConfirmation`);
if one exists it sets `pendingConfirmation = { target: 'slot', slot, value,
display }` and returns `confirm_<slot>` ("Your member ID is {memberId}. Is
that right?") with spoken options yes and no. Implicit acks for other slots
filled in the same turn are spoken before it.

Verdicts on the next turn reuse the confirmation gate:
- `confirmed`: the slot becomes confirmed; `continueForm` proceeds.
- `rejected`: the slot's value is cleared, `ack_declined` ("Sorry about
  that.") is spoken, and the caller is sent straight to the keypad prompt
  `ask_<slot>_dtmf` (a declined readback means the spoken path failed; the
  ladder does not spend another spoken attempt). Rejection escalates on
  repetition: attempts are bumped so that a second decline following a
  fresh spoken ID hands off rather than reading a third value back.
- `confirm_unanswered`: an unanswered readback follows the same ladder as a
  decline — re-ask first, then the keypad, then handoff — rather than a
  separate policy.

Keypad entry marks the slot confirmed with no question, as `applyDtmf`
already does, and clears any pending confirmation.

A switch away from an active form is always acknowledged with `ack_intent`,
whatever the route's own confidence, because silently swapping the task
underneath the caller is the confusing case; entering a form from outside
one, or an implicit-confidence route, keeps the existing implicit ack.

A pending intent confirmation and a pending slot confirmation never coexist:
slot confirmation is only raised from `continueForm`, which runs after an
intent confirmation has resolved.

### 5.2 Completion readback

Completion prompts keep reading every slot back (the guard test from PR #3
stays). With the member ID confirmed explicitly, the readback is a summary,
not the only chance to object.

### 5.3 Provider hedging

`providerSlot.fill` reads `providerUnsure`. When it is at or above
`PROVIDER_UNSURE`:
- if two providers each have probability at least `SLOT_CHOICE_CONFIRM`, the
  outcome is `disambiguate` between the top two;
- otherwise the outcome is `filled` with `confirm: 'implicit'` whatever the
  top probability.

Below the threshold, today's rules apply.

In practice the second disambiguation clause (unsure and the runner-up at or
above `SLOT_CHOICE_CONFIRM`) is unreachable while normalized probabilities
and `2*SLOT_CHOICE_CONFIRM + SLOT_CHOICE_MARGIN > 1` both hold, since two
choices cannot each clear `SLOT_CHOICE_CONFIRM` without their margin also
clearing `SLOT_CHOICE_MARGIN`, which already disambiguates through the first
clause. It is kept, annotated in the code, and becomes live if a later
threshold sweep lowers either value. Consequently a caller who offers two
names for one provider ("Dr. Chen or Cheng, I'm not sure") but whose model
answer does not split the probability mass between them gets an implicit
readback of the model's top pick, not a disambiguation.

## 6. Chunked spoken numbers

`spokenToDigits` gains `hundred` and `thousand` as multipliers (exported as
`MULTIPLIER_WORDS`) and ignores `and`. A unit or teen before `hundred` or
`thousand` scales; tens and units after it add; a bare "two hundred" is
200. Thousands compose with a trailing hundreds group: "two thousand five
hundred" is 2500, "one thousand two hundred thirty four" is 1234. A spoken
zero after a multiplier is its own digit rather than composing into the
group: "three hundred oh five" is 30005, not 305. Chunks concatenate:
"forty four, one eighty seven, three hundred fifty five" is `44187355`;
"three hundred five" is `305`; "four hundred and twelve" is `412`; "double
four seven one eight two nine three" is unchanged at `44718293`; digit
tokens like "44 187 355" still concatenate. `hundred` or `thousand` alone,
with no other number word, does not qualify a candidate span, so ordinary
phrases like "a hundred percent sure" do not spawn junk spans; the word
still counts within a span that has another number word. The mask decides
acceptability, as today.

## 7. Corpus, labels, and scenarios

### 7.1 Labels

`CorpusEntry` gains optional `tentative: boolean`, `change: 'adding' |
'replacing'`, and `providerUnsure: boolean`. The fixture stub derives the
new questions from them (default false / `answering`), so the stub baseline
keeps meaning "the labels". The `answers` override mechanism is unchanged.

Corrections from the recording: `lc-01` ("I need to do something about my
appointment") is `other`; `lc-05` ("Change it", no form) is `other`, on a
weak real-model plurality (0.44) and may be revisited; `lc-06`
("I'm seeing Dr. Chen, or Cheng, I'm not sure") is intent `none` with
`providerUnsure: true`; `lc-12` ("It might be Dr. Kim") gets
`providerUnsure: true` and its expected outcome becomes an implicit ack, not
a completion; `lc-03`, `lc-08`, `lc-10`, `sw-08` and every entry tagged
`explicit_confirm` or `implicit_confirm` on a hedge get `tentative: true`.

New entries, at least: two chunked-number member IDs, one "three hundred
five" style, two in-form `adding` utterances, two in-form `replacing`
utterances ("never mind, I have a question about my bill"), two hedged
provider utterances, one digit-string member ID in each form context.

### 7.2 Scenarios

Rewritten: `explicit-confirm-yes`, `explicit-confirm-no`,
`confirm-unanswered-reask`, `confirm-unanswered-to-agent`,
`switch-confirm-yes-mid-form`, `switch-confirm-no-resumes-form` keep their
intent but reach the explicit confirm through a tentative utterance, and
expect the stashed-slot behavior of §3.3 where a slot was spoken.
`disambiguate-intent` is replaced by `tentative-two-intents` ("I think I
need to reschedule or maybe cancel" now expects an explicit confirm of the
top intent). `frustration-escalation` uses an utterance the real model
rates `high` at 0.6 or above; the plan picks it with a handful of
`pnpm cli --client jev` spot checks and records the text in the plan.

New: `add-intent-chained` (reschedule, "can I also ask about my bill",
completes, bridges into billing, ends in the billing handoff with
`completed: ['reschedule']`), `replace-intent-mid-form`,
`memberId-confirm-yes`, `memberId-confirm-no-to-keypad`,
`chunked-memberId`, `digit-string-memberId`, `hedged-provider-implicit`,
`hedged-two-providers-disambiguate`, `tentative-carries-slots`.

Every scenario that fills a member ID by voice gains the confirmation turn;
`dtmf-baseline.json` is unchanged because the keypad tree already counted
an ID-confirm turn.

## 8. Thresholds

New placeholders in `thresholds.ts`: `INTENT_TENTATIVE` 0.5,
`INTENT_CHANGE` 0.6, `PROVIDER_UNSURE` 0.5. No existing value moves.

## 9. Prompts

New manifest entries: `ack_queued`, `bridge_next`, `goodbye`,
`confirm_memberId`, `ack_declined` ("Sorry about that."), spoken before the
keypad prompt that follows a declined slot readback. Completion prompts
drop " Goodbye.". The render test
that every completion prompt names every slot of its form stays; a new test
pins that no completion prompt ends the call by itself.

## 10. Testing

- Unit: each question's wording is pinned by a snapshot-style equality test
  on the built schema (so a wording change is a deliberate diff and a
  cassette re-key); gate tests for tentative routing, `answering`,
  `adding`, `replacing`; `fillSlots`/`continueForm` tests for the
  always-confirm flow including rejected-to-keypad; provider tests for
  hedging and dual naming; converter tests for every shape in §6; queue
  tests for dedupe, chain, carry-over, and `completed` in handoff data;
  stub tests for the new labels.
- Regression: `pnpm regress --update` re-records the label baseline once
  the stub understands the new labels; the diff before that update must
  consist only of the intended changes listed in §7.
- Real model: re-record (`pnpm regress --client record --threshold
  JEV_TIMEOUT_MS=15000`) at the end; every changed question re-keys its
  requests, so expect roughly the full corpus to be live again (a few
  cents). Commit the cassette. The run's diff against the new baseline is
  the input to the threshold-sweep sub-project.

## 11. README

Regression section: the new labels and what `--update` now encodes. A short
"Confirmation and multi-intent" subsection under the phone-line notes: what
the caller hears for a tentative request, an added request, and the member
ID readback.
