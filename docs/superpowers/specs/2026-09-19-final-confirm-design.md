# Design: Final confirm, silent member ID, and a second intent on the first utterance

**Date:** 2026-09-19
**Status:** approved in conversation; implementation plan to follow
**Depends on:** question redesign (2026-09-19), recorded prompts (2026-09-19, PR #7)

## 1. Scope

Three changes to the turn flow, all on the path from the last filled slot to the end of the call.

1. **Final confirm.** A form no longer completes the moment its last slot fills. The caller hears a summary phrased as a question and answers it. Yes completes the form as today. No, or a correction, reopens the named slot and the summary is asked again. Unanswered turns follow the existing confirm ladder. Every form gets the confirm, regardless of how its slots were filled.
2. **Silent member ID.** The member ID is no longer confirmed on its own. It fills silently (no explicit "Is that right?", no implicit "Member ID ..." ack) and is confirmed once, in the summary, where it can be corrected like any other slot. The `always` confirmation policy stays available for slots; the member ID stops using it.
3. **Second intent on the first utterance.** An opening utterance that names two tasks ("reschedule ... and also a question about my bill") queues the second one, the way an in-form "also" does today. Until now only in-form turns were asked whether the caller was adding a task, so the second intent was dropped.

Out of scope: "repeat that" in the recorded voice; barge-in across multi-frame prompts; the intent confirmation bands; any change to how slots are extracted.

## 2. The final confirm turn

### 2.1 State

`PendingConfirmation` gains a third variant:

```ts
| { target: 'form'; form: FormId }
```

It is set by the turn that fills the last required slot, in place of completing. While it is pending, `promptedFor` is `'confirm'` for attempt accounting and DTMF (see 2.4), and the summary prompt is what `lastPromptText` carries.

### 2.2 Flow

When `nextPrompt` reports `complete` and no form confirmation is pending:

- set `pendingConfirmation = { target: 'form', form }`;
- speak any acks from this turn, then the form's confirm prompt (§5) with the current slot displays as variables.

On the next turn with a form confirmation pending, the confirm questions (§6) are read in this order:

1. **Yes** (`confirmYes` at or above `CONFIRM_YES`, and at least `confirmNo`): clear the pending state and run `completeForm` exactly as today. The completion line (shortened, §5) plays, then goodbye and the end frame, or the bridge into the next queued intent.
2. **Correction present** (any slot fills from this utterance, whether or not the caller also said "no"): apply the fills the way a mid-form turn does, including windows and provider disambiguation, clear the confirm's attempt count, and re-ask. If a slot only narrowed (a date window), the narrowing question is asked and the summary returns once that slot fills. If a slot needs disambiguation, that prompt is asked first, likewise. Two or three slots may change in one utterance ("no, Thursday with Dr. Alvarez").
3. **No, nothing usable** (`confirmNo` at or above `CONFIRM_NO`, no fill): keep the pending state and ask `ask_change`. The next utterance is read for slot values first (case 2) and then for a slot name (§6, `changeSlot`): a name reopens that slot with its normal question (`ask_provider`, `ask_date`, `ask_memberId`), the slot's value is cleared, and the summary returns when it fills. An utterance that is neither a value nor a name counts as an unanswered turn (case 4).
4. **Unanswered:** the existing confirm-unanswered ladder (§2.4).

"Agent", high frustration, and a replaced intent are handled before the confirm questions, as on every other turn. An added intent ("yes, and also my bill") is queued and the yes proceeds.

### 2.3 Corrections and the member ID

All three slots can be corrected at the summary. A corrected member ID fills silently like the first one and is read back in the next summary. There is no separate readback for it.

### 2.4 Attempts, keypad, and handoff

The confirm is a prompt target (`'confirm'`), and the existing ladder applies with no new counter:

| unanswered turn | response |
| --- | --- |
| 1 | re-ask the summary question |
| 2 | `confirm_dtmf`: "Press 1 to confirm, or 2 to change something." DTMF 1 completes; 2 asks `ask_change`; any other digit is invalid and counts |
| 3 | handoff, reason `max-attempts` |

A "no" is not an unanswered turn. A correction that lands resets the count. Repeated bare "no"s with nothing usable count as unanswered turns after the first `ask_change`, so three of them in a row hand off.

The summary prompt is interruptible; `ask_change` and `confirm_dtmf` are not.

## 3. Member ID confirmation policy

`SlotSpec.spokenConfirm` gains a third value:

```ts
spokenConfirm: 'always' | 'by-confidence' | 'summary';
```

`summary` fills the slot without an ack or a readback; it is confirmed by the final confirm. The member ID uses `summary`. `always` keeps its current behavior for any slot that opts in; nothing uses it after this change. `by-confidence` is unchanged for provider and date.

The detect and span thresholds still apply: an ID the model cannot find or that has the wrong length is still a retry, not a silent bad fill.

## 4. Second intent on the first utterance

On an out-of-form routing turn the intent Choice names the task the utterance is mostly about. A new Choice, `secondIntent`, is asked on the same turn:

> If the caller asks for a second, different task in addition to the main one, which is it? Choose none when there is only one task.

Options: the form intents plus `none`. When its top option is a form intent other than the routed one, at or above `INTENT_SECOND`, and the route verdict is `route` (not tentative, not disambiguated), the second intent is queued and the caller hears `ack_queued` before the first question, exactly as an in-form "also" does. When the route is tentative or disambiguated, the second intent is ignored on that turn; the caller can add it once the form is open.

`agent` and `billing` as the second task queue as they do today (a handoff-completing form runs last).

## 5. Prompts

New, all recordable (variables spoken by TTS, at clause boundaries):

| id | text | interruptible |
| --- | --- | --- |
| `confirm_schedule` | "You'd be booked with {provider} on {date}, member ID {memberId}. Shall I book that?" | true |
| `confirm_reschedule` | "Your appointment with {provider} would move to {date}, member ID {memberId}. Shall I make that change?" | true |
| `confirm_cancel` | "Your appointment with {provider} would be cancelled, member ID {memberId}. Shall I cancel it?" | true |
| `confirm_appointment_details` | "That's your appointment with {provider} on {date}, member ID {memberId}. Is that the one?" | true |
| `ask_change` | "What should I change?" | true |
| `confirm_dtmf` | "Press 1 to confirm, or 2 to change something." | false |

Changed: the completion lines no longer repeat the details the caller just confirmed. `schedule_confirmed` becomes "You're booked."; `reschedule_confirmed` "Your appointment is moved."; `cancel_confirmed` "Your appointment is cancelled."; `appointment_details` keeps its details (it is the answer to the caller's question). `confirm_memberId` is removed from the manifest along with its use.

Clips: the new fixed segments and the shortened completions go through `pnpm prompts:generate`; `prompts:check` flags the old completion clips as stale.

## 6. Questions and thresholds

- `confirmYes` / `confirmNo`: unchanged, asked whenever any confirmation is pending.
- Slot questions (`memberIdSpan`, `provider`, `providerUnsure`, `date`): also asked while a form confirmation is pending, so a correction fills from the same utterance.
- `changeSlot` (Choice, new): asked only while a form confirmation is pending. "The caller was asked what to change. Which detail do they name: the doctor, the day, or the member ID? Choose none if they give a value instead of naming a detail, or name nothing." Options `provider | date | memberId | none`. Threshold `SLOT_CHANGE` (initial 0.6, in the sweep space).
- `secondIntent` (Choice, new): asked on out-of-form routing turns (§4). Threshold `INTENT_SECOND` (initial 0.6, in the sweep space).
- `intentChange` stays in-form only.

## 7. Corpus, labels, and scenarios

Labels:

- A new context `confirm_<form>` for utterances spoken at the summary, with fields `confirm: 'yes' | 'no' | 'unanswered'`, optional `slots` (the corrected values) and optional `changeSlot`.
- `no_form` entries gain an optional `secondIntent`.
- The two member-ID-confirm scenarios and their corpus entries are relabeled to the summary turn; `confirm_memberId` disappears from expected outcomes everywhere.

Scenarios (new or changed): final-confirm-yes for each of the four forms; no-then-name-slot; no-with-value ("no, Thursday"); no-with-two-values ("no, Thursday with Dr. Alvarez"); no-with-window ("no, next week", narrowing then summary); member-ID correction at the summary; unanswered to re-ask; unanswered to keypad 1; unanswered to keypad 2 then change; three unanswered to agent; queued intent bridged after yes; second intent on the first utterance queued and handed off after the confirm; every existing scenario that reached a completion gains the confirm turn.

The label baseline (stub) is re-recorded. The cassette turns after each form's last slot re-key; Jason records them at the end.

## 8. DTMF baseline

Unchanged. `dtmf-baseline.json` already counts a final confirm; the voice path now has the same turn on the happy path, so the metrics comparison is like for like.

## 9. Testing

- Core unit tests for every branch of §2.2 and the ladder in §2.4, plus the `summary` policy in `fillSlots` and `pendingSlotConfirmation`.
- Gate tests for `secondIntent` at, above, and below threshold, and with a tentative route.
- Segment and seam tests cover the new prompts automatically; the recordable snapshot updates.
- Server end-to-end: the worked example gains the confirm turn and the yes.
- `pnpm regress` after the label re-record shows changes only on turns at or after a form's last slot and on the two-intent opening utterance.

## 10. README

The worked example and the live-call checklist gain the confirm turn ("Shall I make that change?" → "yes"), the correction example, and the two-task opening line. The confirmation section describes the summary as the single readback and the member ID's silent fill.
