# Design: Name and date of birth in place of the member ID

**Date:** 2026-09-20
**Status:** approved in conversation; implementation plan to follow
**Depends on:** final confirm (PR #8), no-input handling (PR #9)

## 1. Scope

A clinic line identifies a caller by first and last name and date of birth, not a member ID. The four scheduling forms (`schedule_new`, `reschedule`, `cancel`, `confirm_appointment`) ask `name` then `dob` before their own slots. The `billing` form keeps `memberId`, which is what an insurer-style question uses; that keeps the digit collection, spoken-number chunking, mask, and keypad path live in a real flow with real corpus coverage.

Both new slots use the `summary` confirmation policy: silent fill, read back once in the summary, correctable there.

Out of scope: spelling a name letter by letter; matching against patient records; a phone-number slot; any member-ID prompt on the scheduling forms.

Framework note: the two slots are ordinary `SlotSpec`s. The word-span candidate generator and the filler-word list are general pieces; the prompt texts and the form order are app content.

## 2. Slots

### 2.1 `name`

- **Value:** the transcript span the model picks as the caller's full name, normalized to single spaces; **display:** title-cased ("jason stiles" → "Jason Stiles").
- **Questions:** `nameGiven` (Noul: does the caller state their own name?) and `nameSpan` (Choice over the name candidate spans plus `none`: "Which of these spans is the caller's full name as they say it, first and last? Do not include words like my name is.").
- **Candidates:** `candidateWordSpans(text)`: every 1- to 3-token n-gram that contains no digit or number word, does not start or end with a filler or function word (a small list kept with the span code: my, name, is, it's, this, the, a, an, and, um, uh, i, i'm, for, with, to, of, please, hi, hello, yes, no, calling), deduplicated in document order, capped at the same `MAX_SPANS`.
- **Fill:** absent when `nameGiven` is below `SLOT_DETECT`; invalid `no_span` when the Choice picks `none`; otherwise filled with the span, confidence the Choice's probability. Single-word names are accepted (a caller who says only "Jason" is not re-asked; the summary shows what was heard).
- **Keypad:** none. The ladder is retry, retry again, agent (the `dtmf` rung re-asks with the retry text). `SlotSpec.dtmf` becomes optional; `applyDtmf` treats a slot without it as `no_target`.
- **Retry text:** "Sorry, I need your first and last name."

### 2.2 `dob`

- **Value:** ISO date `YYYY-MM-DD`; **display:** "March 5th, 1980" (ordinal day, full year).
- **Questions:** `dobGiven` (Noul: does the caller state their date of birth?), `dobMonth` (Choice over months + none), `dobDay` (Choice over 1..31 + none), `dobYear` (Choice over the number candidate spans + none: "Which span is the year of the caller's birth, if they say one, as in nineteen eighty or eighty"). Distinct ids from the appointment date's questions, since both can occur in one utterance; the instructions say "the caller's date of birth" in each.
- **Year normalization:** the span is converted with the existing spoken-number code; a two-digit year maps to 19xx or 20xx, whichever is in the past and makes the caller at most 120 years old.
- **Fill:** absent when `dobGiven` is below `SLOT_DETECT`; month and day present but no year → `window` outcome carrying `{ month, day }` (the slot narrows, and the next prompt is `ask_dob_year`; a year alone then completes it); full date → filled when it is a real calendar date, in the past, and the year is at or after 1900, else invalid (`future`, `impossible`, `no_year`).
- **Keypad:** 8 digits, MMDDYYYY, same validity rules.
- **Retry text:** "Sorry, I need your date of birth: month, day, and year."

The narrowing reuses the `window` machinery shape: `SlotState.window`'s type widens from `DateWindow | null` to a per-slot partial (`DateWindow` for the appointment date, `{ month, day }` for `dob`), `SlotOutcome`'s `window` outcome carries whichever partial the slot produces, and `askSlot` dispatches on the slot id: `date_narrow_window` for the date, `ask_dob_year` for `dob`. The date slot's use of the field is unchanged. A silence or an unintelligible answer at `ask_dob_year` walks the ladder on the `dob` slot.

## 3. Forms and order

```
schedule_new:        name, dob, provider, date
reschedule:          name, dob, provider, date
cancel:              name, dob, provider
confirm_appointment: name, dob, provider
billing:             memberId
```

`SlotId` gains `name` and `dob`; `ALL_SLOTS` orders them first. A queued form carries `name` and `dob` over the way `memberId` carried over (`completeForm` clears only the form-specific slots).

## 4. Prompts

New: `ask_name` "What's your first and last name?", `ask_name_retry`, `ask_dob` "And your date of birth?", `ask_dob_retry`, `ask_dob_year` "And what year?", `ask_dob_dtmf` "Please enter your date of birth on the keypad: two digits for the month, two for the day, and four for the year." (`ask_name_dtmf` does not exist.)

Summaries:

| id | text |
| --- | --- |
| `confirm_schedule` | "You'd be booked with {provider} on {date}, for {name}, born {dob}. Shall I book that?" |
| `confirm_reschedule` | "Your appointment with {provider} would move to {date}, for {name}, born {dob}. Shall I make that change?" |
| `confirm_cancel` | "Your appointment with {provider} would be cancelled, for {name}, born {dob}. Shall I cancel it?" |
| `confirm_appointment_details` | "That's your appointment with {provider}, for {name}, born {dob}. Is that the one?" |

`name` and `dob` join `SPOKEN_VARS` (TTS-spoken, never clips); each is followed by a comma or period, so the seam rule holds. `ack_memberId` stays (billing does not ack it either, since the member ID is a summary-policy slot; it remains for the `by-confidence` policy).

`changeSlot` gains `name` and `dob` criteria ("The name", "The date of birth"), ordered `name, dob, provider, date, memberId`, filtered by the form's slots as today.

## 5. Corpus, scenarios, baseline, cassette

- Corpus: scheduling-form entries that carried a member ID are relabeled to a name and/or birthday utterance with `slots.name` (the span) and `slots.dob` (`{ month, day, year? }`); billing entries keep `memberId`. New entries: names alone ("Jason Stiles", "it's Jason Stiles", "my name is Jason Stiles"), names in the opener, birthdays with and without a year ("March fifth nineteen eighty", "March 5th"), a year alone at `ask_dob_year`, keypad birthdays (scenario steps), invalid birthdays (a future date, February 30th), and summary corrections ("no, it's Jason Stiles", "the name", "no, born March 6th").
- The fixture stub answers `nameGiven`/`nameSpan` and `dobGiven`/`dobMonth`/`dobDay`/`dobYear` from the labels, like the member-ID span today; the heuristic stub gets keyword rules good enough for scenario steps.
- Scenarios: every existing scenario that gave a member ID on a scheduling form gives a name and a birthday instead; new ones for the year follow-up, keypad birthday, invalid birthday retry, name corrections at the summary, and the billing form still taking a member ID.
- Placeholders for seeded contexts: `name` "Jason Stiles", `dob` 1980-03-05.
- The label baseline is re-recorded. The cassette is a full re-record (new questions on nearly every turn).

## 6. DTMF baseline

A keypad tree cannot take a name. `dtmf-baseline.json` swaps the ID entry and ID confirm turns for birthday entry and birthday confirm; the counts stay as they are for the scheduling forms (7, 7, 5, 5) and billing (3). The metric will show names as a voice-only advantage: the voice path collects a name in the same turn count.

## 7. Server, prompts, clips

No server changes. The six new prompt clips are recorded; the four summary prompts are re-recorded (their fixed segments change); `prompts:check` reports the stale ones. The member-ID prompts stay (billing uses them).

## 8. Tests

- Span generator: word spans, filler filtering, cap, no number words.
- `name`: fill from labels, title-casing, single-word acceptance, `none` → invalid, no keypad.
- `dob`: full date, month-day narrowing to the year prompt, year alone completing, two-digit years, future and impossible dates invalid, keypad parse and its validity, display.
- Flow: name then dob then provider; the year follow-up; silence and retries at `ask_dob_year`; summary corrections of name and birthday; a queued form keeps name and dob; billing still asks the member ID.
- Harness: labels parse, stubs answer, scenarios pass; `pnpm regress` after the re-record shows changes on every scheduling turn that previously handled a member ID, and nowhere else.

## 9. README

The worked example, the confirmation section, the regression label paragraph, the live-call checklist (say your name and birthday in the opener; give a birthday without a year and answer the year prompt), and the clip list.
