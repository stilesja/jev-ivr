# Design: Appointment slots (a found booking, an offered time, a time-of-day preference)

**Date:** 2026-09-24
**Status:** implemented on branch appointment-slots; see the plan's deviation record
**Depends on:** demo polish (PR #15)

## 1. Purpose

Confirming, cancelling and rescheduling act on an appointment the system never names, and scheduling books a day with no time. A real line would read the booking back and put the caller into an opening. This adds both, behind one seam a real deployment can back with its scheduling system.

Rules from the brainstorm:

- The caller is never asked for a time. A time is always the system's offer: an opening it "found" on the day the caller gave.
- A time of day (morning, midday, afternoon) is a preference the caller may volunteer at any point on a scheduling form. It is read whenever it is said and never asked for, and no prompt mentions a window the caller did not name.
- At the offer, "earlier", "later", or "that time doesn't work" moves along that day's openings. A specific clock time ("at three") is not understood and is left for later.

## 2. The seam

`src/domain/directory.ts`:

```ts
export interface Booking { date: string; time: string }          // ISO day, "2:45 PM"
export interface AppointmentDirectory {
  /** The caller's existing booking with this provider, or null. */
  find(name: string, dob: string, provider: string): Booking | null;
  /** That provider's open times on that day, in clock order. Empty when the day is full. */
  openings(provider: string, date: string): string[];
}
```

`DemoDirectory` (same file) implements both deterministically from a stable hash of name, birthday and provider, seeded with the call's `todayIso`:

- `find`: the booking is on a weekday one to fourteen days after `todayIso` (weekends skipped), at one of the table times. The demo never returns null; the null path (no booking found) belongs to the framework.
- `openings`: three times per provider-day, drawn without replacement from a fixed table of nine (three in each window) off one hash of provider and date, in clock order. Never empty for the demo, and not always one per window: a day can have two mornings and an afternoon, which is what makes the nearest rule reachable.

`DAYPART_ORDER`, `daypartOf`, `daypartBounds` (same file): three-hour windows over the clinic's day. `morning` is 8:00 to 10:59 AM, `midday` 11:00 AM to 1:59 PM, `afternoon` 2:00 to 4:59 PM. `daypartOf(time)` maps a time to one; `daypartBounds(part)` gives its edges, for the nearest-opening rule. The demo table of nine times has three in each window.

The directory reaches the core through `TurnContext.directory` (beside `render`); `RunOptions` carries it the same way. `DemoDirectory`'s constructor takes the call's `todayIso`; the harness and the server both build `new DemoDirectory(todayIso)`. Pure core, no I/O.

## 3. What the session holds

Two derived values, filled by the turn, never asked for:

```ts
existing: Booking | null;                                     // confirm, cancel, reschedule
offer: { provider: string; date: string; times: string[]; index: number } | null; // schedule, reschedule
daypart: 'morning' | 'midday' | 'afternoon' | null;           // the caller's stated preference
```

`existing` and `offer` are computed from the current slots every time a summary or completion is about to be spoken (`settleBookings`, run inside `resolve`), not just once when the form first becomes full: a confirm, cancel or reschedule form's `existing` is recomputed from the current name, birthday and provider, and a schedule or reschedule form's `offer` is rebuilt from the current provider and date, so a corrected doctor or identity is honoured and not just a corrected date. `offer`'s index starts at the first opening inside `daypart` when one is set and there is such an opening, otherwise at the first opening, and stands as long as neither the provider nor the day changed. `completeForm`'s reset for a chained form clears `offer` and `existing` with the provider and date; `daypart` carries over with the identity slots.

`summaryVars` gains `when` (the offered date and time as one spoken span, "Tuesday, October 6 at 2:45 PM"), `existing` (the found booking the same way) and `time` (the offered time alone). All three are spoken by TTS and end their clause.

## 4. Prompts

| id | text | change |
| --- | --- | --- |
| `confirm_schedule` | {provider} has an opening on {when}. That would be for {name}, born {dob}. Shall I book it? | changed |
| `confirm_reschedule` | Your appointment with {provider} is on {existing}. It would move to {when}, for {name}, born {dob}. Shall I make that change? | changed |
| `confirm_cancel` | Your appointment with {provider} is on {existing}. It would be cancelled, for {name}, born {dob}. Shall I cancel it? | changed |
| `confirm_appointment_details` | I found your appointment with {provider}. It's on {existing}, for {name}, born {dob}. Is that the one? | changed |
| `schedule_confirmed` | You're booked for {when}. | changed |
| `reschedule_confirmed` | Your appointment is moved to {when}. | changed |
| `slot_edge_earlier` | That's the earliest opening that day. | new ack |
| `slot_edge_later` | That's the latest opening that day. | new ack |
| `slot_nearest` | The closest I have to the {daypart} is {time}. | new ack |

`cancel_confirmed` and `appointment_details` are unchanged. Every spoken variable ends a sentence or is followed by punctuation, which the seam test already enforces; `{daypart}` is a vocabulary variable with three clips (`daypart.morning`, `daypart.midday`, `daypart.afternoon`). `SPOKEN_VARS` gains `when`, `existing`, `time`; `VOCAB_VARS` gains `daypart`.

## 5. Questions

Two Choices, both read only.

`timeOfDay`, asked on every out-of-form turn as well as on every turn while a schedule or reschedule form is active (with the slot questions), labels `morning`, `midday`, `afternoon`, `none`: "Read asr.text. Does the caller say what part of the day they want the appointment in?" The instructions exclude a greeting ("good morning") and a bare "earlier" or "later" on their own, neither of which names a part of the day. A window in the answer sets `daypart` at or above `TIME_OF_DAY` (0.6); `none` leaves it alone. It is read on the opener ("with Dr. Chen next Thursday afternoon"), on the day answer, and at the summary ("no, the morning").

`timePreference`, asked only while a schedule or reschedule summary is pending, labels `earlier` (asks for an earlier time, or before the offered one), `later` (a later time, or after it), `different` (says the offered time does not work without a direction), `none` (accepts, declines for another reason, names a day or a part of the day, or says nothing about the time). Threshold `TIME_PREFERENCE` (0.6).

## 6. Moving the offer

At a schedule or reschedule summary, in this order after the yes/no and `changeSlot` reads:

1. A changed date (a correction such as "no, Thursday") rebuilds the offer for the new day, honouring `daypart`, and re-reads the summary. This is the existing correction path with the offer rebuilt in it.
2. Otherwise a `timeOfDay` in the answer sets `daypart` and moves the index to the first opening in that part of the day. If none exists that day, the index moves to the opening closest by clock distance to that window's edge (a caller asking for the afternoon on a day with openings at 9:15, 11:45 and 1:00 gets 1:00 PM) and `slot_nearest` plays before the summary: "The closest I have to the afternoon is 1:00 PM." The same rule applies at the first offer when the caller volunteered a window earlier on the form. A `timeOfDay` that leaves the index where it was does not swallow a `timePreference` said in the same breath ("later, in the morning" at a morning offer still moves later); the daypart is applied first and case 3 still runs when it did not move the index.
3. Otherwise a `timePreference` moves the index: `earlier` one step back, `later` one step forward, `different` one step forward. None of the three wraps: at the last opening, `different` behaves like `later` and stops there rather than circling back to the first, so a caller who turns down every opening reaches the keypad prompt instead of cycling through them forever. At the end of the list in the asked direction the index does not move and `slot_edge_earlier` or `slot_edge_later` plays.

Cases 1 and 2, and a case-3 move that changes the time, are corrections: the summary is re-read with a fresh attempt count, as any correction is today. A case-3 edge, or a `timeOfDay` that leaves the index where it was, is an unchanged summary and counts a turn on the summary's ladder, so two "earlier" at the earliest slot reach the keypad prompt and the caller can still name another day. A preference on a confirm or cancel summary is ignored and the turn is read as today. A daypart is read only from a turn the gates actually score as an answer; it is not taken from a turn that is ignored, held, or unintelligible (a `nomatch`).

Corpus-level truth for the stub: `timeOfDay` and `timePreference` are answered from new labels `timeOfDay` and `timePreference` on the entry.

## 7. Thresholds

`TIME_OF_DAY: 0.6`, `TIME_PREFERENCE: 0.6`, sweepable by the file's rule.

## 8. Harness

- Corpus: opener entries with a window ("book me with Dr. Chen next Thursday afternoon", "reschedule to Tuesday morning"), day answers with a window ("Thursday, in the afternoon"), and `confirm_schedule_new` / `confirm_reschedule` entries: "earlier", "later", "the morning", "afternoon please", "that time doesn't work", "no, Thursday", "no, Thursday morning". Labels `timeOfDay` and `timePreference`.
- Scenarios: schedule with a volunteered afternoon (the first offer is the 4:15 PM opening); reschedule then "later" then yes (the completion names the new time); reschedule with "earlier" at the first opening (edge ack) then "no, Thursday morning" (new day, offer restarts in the morning); "that time doesn't work" four times (three moves to the last opening, then the edge ack, then the keypad prompt); confirm and cancel reading the found booking; a window with no opening that day (`slot_nearest`); a daypart said on a missed day answer and honoured when the day fills.
- Baseline re-recorded from the stub. Cassette: every out-of-form turn re-keys (`timeOfDay` is asked on every opener), every schedule and reschedule turn re-keys (it joins the form's questions) and every summary turn re-keys (prompt text and `timePreference`); confirm and cancel identity turns inside their forms stand. Jason records.
- Demo directory in the harness is seeded from the run's `todayIso`, so a replayed call reproduces its bookings.

## 9. Tests

Directory: determinism, weekday-only bookings within fourteen days, three openings in clock order, daypart mapping. Turn: the found booking on all three summaries; the offer's first index with and without a window; the three moves and both edges; the nearest rule; a day change rebuilding the offer; completions carrying `when`; a chained form clearing the offer and keeping the daypart; confirm and cancel ignoring a preference. Prompts: manifest, seams, tags, sheet, snapshot. Harness: labels, scenarios, baseline.

## 10. Clips

New: `slot_edge_earlier.0`, `slot_edge_later.0`, `slot_nearest.0` and `.1`, `daypart.morning`, `daypart.midday`, `daypart.afternoon`. Re-recorded: the four summaries' segments and the two completions. `prompts:check` names them.

## 11. README

The call walkthrough gains the offered time; the confirmation section gains a paragraph on the directory, the offer, the window preference and the earlier/later moves; the clip list gains section 10; the live-call checklist gains a call that volunteers "Thursday afternoon", says "earlier" at the offer, and one that confirms and hears the found booking.
