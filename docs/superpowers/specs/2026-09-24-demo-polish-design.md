# Design: Demo polish (capabilities, provider help, intent acknowledgment)

**Date:** 2026-09-24
**Status:** approved, awaiting plan
**Depends on:** frustration escalation (PR #14)

## 1. Purpose

Three things a first-time caller ran into on a demo call:

1. He asked what the system could do and heard "Sorry, I didn't catch that." The question scores as the `other` intent, which walks the no-match ladder and costs an attempt.
2. He did not know the doctor's name. "Which provider is the appointment with?" has no answer for that, so a "no" or an "I don't know" is a miss and the list of names only arrives on the keypad rung, two attempts later.
3. His "I'd like to reschedule" went straight into "What's your first and last name?" with no acknowledgment. `ack_intent` exists, but it plays only on the mid-confidence route or a form switch; a confident route enters the form silently.

Each is small. They ship together as one branch because they share a cassette re-record and a clip session.

## 2. Capabilities

### 2.1 Intent

`INTENTS` gains `capabilities`, listed before `other`. It is not a form intent and has no keypad digit.

- Criterion: "Asks what the system can do, what it is, what the options are, or how to use it, as in what can you do, what are my options, or what is this."
- Label: "hear what I can do" (unused by any prompt today; present because every intent has one).

`INFORMATIONAL_INTENTS` in `src/domain/intents.ts` maps an informational intent to the prompt it plays: `{ capabilities: 'capabilities' }`. It is the seam: a deployment adds an informational intent by adding a row, and the gate and turn never name `capabilities` themselves.

### 2.2 Gate

Gate 8 treats an informational intent exactly as it treats `repeat_prompt`: outside a form it fires at `INTENT_IMPLICIT`, inside a form at `INTENT_SWITCH`, and it is checked in the same position (after `agent` and `repeat_prompt`, before the form intents). The verdict is `{ kind: 'inform', promptId }`, row outcome `inform:capabilities`.

An `inform` verdict is not consumed by the summary resolution and not rescued into `confirm_unanswered`, so it wins over a pending confirmation of any target: the caller who asks what the system can do while a yes/no is pending hears the answer and is asked the yes/no again without it counting. Frustration rungs stamp onto it like any other prompt-producing verdict (`withFrustration` leaves it alone only for `ignore`, `hold`, `handoff`, `replay`).

### 2.3 Turn

The turn plays the mapped prompt as an acknowledgment and resumes where the call was. The resume rule is the one `declineTransfer` already implements, extracted into `resume(s, t, acks)` so both use it:

- a pending confirmation is re-asked without counting (`reaskConfirmation(s, t, acks, false)`), which restores the summary, an intent check, a slot readback, or the transfer offer as appropriate;
- an open form asks its next question through `continueForm`, so a pending partial (`ask_dob_year`, `date_narrow_window`) is re-asked as it was;
- otherwise `ask_intent`.

Slots fill first, as on the `queue` verdict: "what can you do, it's Jason Stiles" fills the name and then re-asks the next question. No attempt counter moves.

### 2.4 Prompt

`capabilities`, an acknowledgment: "I can help you schedule, reschedule, cancel, or confirm an appointment, or connect you to billing. You can just tell me what you need in your own words, and if you'd rather talk to a person, say so anytime." Marked `interruptible: true`.

Rendering change: acknowledgments currently play non-interruptible whatever the manifest says. `decisionToFrames` now reads each ack's own manifest flag. Every existing ack entry is `interruptible: false`, so nothing else changes; this one is long enough that a caller should be able to talk over it.

At the opening the caller hears the two sentences and then "How can I help you today?" (`ask_intent`). `nomatch_open` is unchanged.

## 3. Provider help

### 3.1 Prompts

| id | text | change |
| --- | --- | --- |
| `ask_provider` | Do you have the name of the provider? | text changed; options `yes`, `no` |
| `ask_provider_name` | Which doctor is it with? | new |
| `provider_list` | Our providers are Dr. Chen, Dr. Cheng, Dr. Patel, or Dr. Okafor; Dr. Nguyen, Dr. Rossi, Dr. Kim, or Dr. Alvarez. Which one is your appointment with? | new |

`ask_provider_retry` and `ask_provider_dtmf` are unchanged. The list is split in two runs of four so the voice can breathe. A test in `render.test.ts` asserts `provider_list` names every provider from `providers.json` in roster order, as the keypad prompt's test already does.

### 3.2 Question

The provider slot adds a Choice `providerNameStatus`, asked whenever the slot is in scope:

- instructions: "Read asr.text and node.promptJustPlayed. The caller was asked whether they have the provider's name. Do they say whether they know it, without naming a provider?"
- `has_name`: "Says yes, that they have or know the provider's name, without saying the name"
- `no_name`: "Says no, or that they don't know, don't have, can't remember, or were never told the provider's name, or asks who the doctors are"
- `neither`: "Names a provider, or says nothing about whether they know the name"

`providerUnsure` stays as it is.

### 3.3 Outcome

`SlotOutcome` gains `{ kind: 'help'; promptId: string }`. The provider slot's `fill` returns it when no provider is named (the `provider` Choice is `none` or below `SLOT_CHOICE_CONFIRM`) and the status top label is `has_name` or `no_name` at or above the new threshold `SLOT_HELP` (0.6): `ask_provider_name` for `has_name`, `provider_list` for `no_name`. A named provider wins as today, so "yes, Dr. Chen" fills in one turn.

`fillSlots` carries a help outcome out as `FillResult.help: { slot, promptId } | null` and records the event; it is not progress and does not change the slot. `continueForm` honours it only when the slot it names is the one the form would ask next and the prompt has not already played for that slot on this call: it plays the help prompt as the question, target the slot, in place of `ask_<slot>`. The attempt counter does not move. `SlotState` gains `helped: string[]`, the help prompts already played for the slot, cleared by `emptySlot`.

A help outcome on any other slot, or a repeat of a help prompt already played, is an ordinary turn without progress: `case 'proceed'` sees no progress and `failAttempt` runs the ladder as today (retry line, keypad list, transfer). So "no" twice at the provider question means: list, then "Sorry, which doctor is it with? For example, Dr. Patel.", then the keypad, then a person.

The dashboard needs no change: the `slot:provider` gate row shows outcome `help`, passed.

### 3.4 Keypad and silence

A digit at any provider prompt still fills through the slot's `dtmf.parse`. Silence at `ask_provider` walks the existing silence ladder.

## 4. Intent acknowledgment

`ack_intent` becomes "I'd be happy to help you {intentLabel}." and plays on every form entry: `enterForm` adds it for `confirm: 'none'` as well as `'implicit'` and a switch, and `handleDtmf`'s menu pick adds it too (the spoken menu number routes through `enterForm` already). An explicit "yes" to `confirm_intent_explicit` enters through `enterForm` and plays it. A queued task's `ack_queued` still precedes it, and slot acks from the same breath still follow it.

`INTENT_LABELS` changes so the label reads after "help you", "do you want to", "we'll", and "let's":

| intent | label |
| --- | --- |
| schedule_new | schedule a new appointment (unchanged) |
| reschedule | reschedule your appointment |
| cancel | cancel your appointment |
| confirm_appointment | confirm your appointment |
| billing | talk to billing |

## 5. Thresholds

`SLOT_HELP: 0.6`, placed with the other slot thresholds.

## 6. Clips

For Jason to record with `pnpm prompts:generate`; `prompts:check` reports them.

- New: `capabilities.0`, `provider_list.0`, `ask_provider_name.0`.
- Stale (text changed): `ask_provider.0`, `ack_intent.0`, `intent.reschedule`, `intent.cancel`, `intent.confirm_appointment`, `intent.billing`.

## 7. Harness

- **Corpus.** New entries: `cp-*` for the capabilities question at `no_form` ("what can you do", "what are my options", "what is this", "tell me what you are") and inside a form ("what else can you do" at `reschedule`, prompted `dob`), labelled `intent: capabilities`. New `ph-*` entries at context `reschedule`, prompted `provider`: "no", "I don't know", "I don't have it", "who are the doctors", "yes", "yes it's Dr. Chen", "Dr. Chen", labelled with `providerNameStatus` and, where a provider is named, `slots.provider`. The fixture stub answers `providerNameStatus` from the label.
- **Scenarios.** `capabilities-open` (ask, then "I'd like to reschedule", through to the summary); `capabilities-midform` (asked at `ask_dob`, lands back on `ask_dob`); `capabilities-at-summary` (asked at the summary, re-asked without counting); `provider-no-name` ("no" at `ask_provider`, list, "Dr. Kim"); `provider-has-name` ("yes", `ask_provider_name`, "Dr. Kim"); `provider-no-twice` ("no", list, "I still don't know", `ask_provider_retry`).
- **Baseline.** Every scenario that enters a form gains the ack in its expected acknowledgments and the provider prompt text changes, so `fixtures/expected` is re-recorded from the stub.
- **Cassette.** The intent criteria change and the provider slot gains a question, so every key changes: a full re-record (about $0.10), which Jason runs with `pnpm regress --client record`.

## 8. Tests

- Gates: `inform` fires at the two thresholds, wins over a pending confirmation, is not rescued, carries frustration.
- Turn: capabilities resumes each of the three places without counting; slots fill on the same breath; the ack chain order on a confident route with slots; the ack on menu, explicit-yes, and switch entries.
- Provider slot: `help` for each status, a named provider wins, below threshold is `absent`; `fillSlots` carries help without progress; `continueForm` plays it once and the second time is a miss; help on a slot not being asked is ignored.
- Prompts: manifest snapshot, tags, sheet; `provider_list` matches the roster; acks honour their manifest flag.
- Harness: labels, scenarios, baseline; `pnpm regress` clean.

## 9. README

The call walkthrough gains the acknowledgment; the confirmation section gains a paragraph each on the capabilities question and the provider help; the clip list gains section 6; the live-call checklist gains the demo caller's path: ask what it can do, say reschedule, say "no" at the provider question, pick from the list.
