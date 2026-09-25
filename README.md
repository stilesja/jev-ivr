# jev-ivr
> **Read the full write-up:** [Jev IVR: A Phone Line You Can Talk To](https://stiles.one/jev-ivr/)
>
> More of my work: [Hedge build log](https://stiles.one/hedge/build/) | [Essays on AI](https://stiles.one/essays/)

A mixed-initiative voice IVR front end driven by a fast, calibrated,
non-generative decision model (TypeSafe's Jev), demonstrated on a healthcare
scheduling flow. See `JEV-IVR-HANDOFF.md` for the thesis and
`docs/superpowers/specs/` for the design.

Status: Phase 3a (phone line over Twilio ConversationRelay); Phase 0–1 merged.
No Jev API key yet; the harness runs against a deterministic stub keyed on a
labeled corpus.

## A call, end to end

    System   Thanks for calling Stiles Family Medical Practice. How can I help you today?
    Caller   I need to reschedule my appointment, it's with Dr. Chen sometime next week.
    System   I'd be happy to help you reschedule your appointment. What's your first and last name?
    Caller   Jason Stiles.
    System   And your date of birth?
    Caller   March fifth, nineteen eighty.
    System   next week. Which day works for you?
    Caller   Tuesday.
    System   Your appointment with Dr. Chen is on Wednesday, September 23 at 9:15 AM.
             It would move to Tuesday, September 22 at 8:30 AM, for Jason Stiles,
             born March 5th, 1980. Shall I make that change?
    Caller   Yes.
    System   Your appointment is moved to Tuesday, September 22 at 8:30 AM. Goodbye.

The four scheduling forms (`schedule_new`, `reschedule`, `cancel`,
`confirm_appointment`) identify the caller by first-and-last name and date of
birth, asked in that order before the provider and the date. `billing` asks for
a member ID instead, and hands off. The name and the two dates are spoken by
TTS, never played from a clip: a recorded clip only ever carries the fixed text
around them.

## Setup

Node 20+ and pnpm required.

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
    pnpm cli --replay traces/<CallSid>.frames.jsonl   # replay a call's frame log

A replay re-resolves relative dates against the call's own date, taken from its
setup line; `--today` overrides that, which is what you want when you are
checking today's behaviour against an old recording rather than reproducing it.

In the REPL, type an utterance, `dtmf:44718293` to send keypad digits,
`/silence` (or an empty line) to run a silence turn — as if the caller said
and pressed nothing — or `/reset` to start a new call. A scenario step can be
`{ "silence": true }` for the same thing. The corpus has 241 labeled
outcomes and there are 89 scenarios available for multi-turn testing.

## Regression

    pnpm regress                       # stub: diff outcomes against fixtures/expected
    pnpm regress --update              # re-record the baseline after an intended change (stub only)
    pnpm regress --client record       # real model; records every answer into fixtures/recorded
    pnpm regress --client recorded     # replay the recording offline; a miss is a failed turn
    pnpm regress --client jev          # real model, nothing recorded
    pnpm regress --client heuristic    # keyword stub, for comparison

Outcomes include the final decision, prompt id, deciding gate, filled slots,
and implicit-confirm acks, so a threshold change that only alters spoken
confirmations still shows up in the diff.

The baseline in `fixtures/expected/` is what the decision core does given
label-perfect answers from the fixture stub. Every other client diffs against
that same baseline, so each line is either the model disagreeing with a
corpus label or a threshold mapping a real distribution wrongly. `--update`
is refused for any client but the stub, including `heuristic`; the baseline
means "the labels", and only the stub re-records it.

Corpus entries carry several kinds of label the stub answers from: the
intent and slots, `tentative` (the caller hedges the request, so it is
confirmed explicitly), `change` (`adding` or `replacing`, for an utterance
that asks for another task, including at the summary), `providerUnsure` (a
hedged or dual provider name is read back), `providerNameStatus`
(`has_name` or `no_name`: the caller says whether they know the provider's
name without saying it, at the provider question), `confirm` (`yes`, `no`, or
`unanswered`: how an utterance at the summary answers it), `changeSlot`
(`name`, `dob`, `provider`, `date`, or `memberId`: which detail the caller
names when asked what to change), `secondIntent` (a second form intent named alongside
the main one, `no_form` entries only), `timeOfDay` (`morning`, `midday`, or
`afternoon`: a part of the day the caller volunteers, on scheduling forms and
on openers whose intent is a scheduling form), and `timePreference`
(`earlier`, `later`, or `different`: a move along the day's openings, at a
scheduling summary). An entry with none of the optional
labels is a plain, committed answer to the current question. Contexts add
`confirm_<form>` for the summary turn, alongside a plain form or `no_form`:
`confirm_schedule_new`, `confirm_reschedule`, `confirm_cancel`, and
`confirm_confirm_appointment` (billing hands off and has no summary). The
parser rejects unknown fields, mistyped labels, a labeled slot that is not
on the entry's form, and a `confirm`/`changeSlot`/`secondIntent` label on
the wrong kind of context. An entry's text must also be unique once
normalized (lowercased, punctuation stripped): the fixture stub looks
entries up by that text, so two entries that normalize the same are
ambiguous and the parser rejects the second one.

A scheduling-form entry labels the two identity slots the way the caller says
them. `slots.name` is the span as spoken ("Jason Stiles"), and must be one of
the candidate word spans of the entry's normalized text, because `nameSpan` is
a Choice over exactly those spans. `slots.dob` is `{ month, day, year? }`: the
month as one of the slot's own month labels (`march`, not "Mar"), the day as
`"1"`..`"31"` (not "5th"), and the year as a number span of the text
("nineteen eighty", "eighty"). Month and day come together or not at all; a
year on its own is what a caller answers "And what year?" with. Billing entries
keep `slots.memberId`. Every one of those is checked against the vocabulary the
questions actually offer, so a label no answer could pick fails the load naming
the entry id instead of going quietly unread as a `none` at run time.

Every run ends with a summary: corpus outcomes matching the baseline,
scenarios passing their own expectation and matching the baseline, a cost
line when real answers were involved (request count, input tokens, dollars;
tagged `[replayed]` when every answer came from the cassette, in which case
the figure is what the recording cost, not what the run cost), ask latency
p50/p95, and a `cassette misses N` line when any turn missed the recording.
Diff lines and the summary go to stdout; progress for live runs goes to
stderr, so `pnpm regress --client recorded > diff.txt` captures a clean
artifact.

### The answer cassette

`fixtures/recorded/<model>.jsonl` holds one line per distinct request,
keyed by a hash of the request state and questions, with the model's
answers and token usage. It contains corpus text and model output only, no
caller data, and is committed. One file per pinned model version: a line
whose `model` differs from the pin fails the load at startup, and a live
answer from another model aborts the run without recording. A model bump
means a new file, not an edit.

Changing a prompt's text re-keys the turns that follow it in the cassette
(the `date_narrow_window` rewrite to "{window}. Which day works for you?"
did), so scenario turns after it need a `pnpm regress --client record` run
to fill the gap.

Recording, from the repo root:

    set -a; source .env; set +a
    pnpm regress --client record --threshold JEV_TIMEOUT_MS=15000

- Run at default thresholds, except `JEV_TIMEOUT_MS`. The default is a
  phone-turn budget; a recording run should not drop answers to a slow
  tail, and this threshold never reaches a gate or the request key, so
  raising it cannot change what is recorded. Every other `--threshold`
  override changes what an earlier turn decided, and that state is part of
  the next turn's key; recording under overrides fills the file with a
  second, parallel set of lines.
- Prove the key before the batch: one utterance in `pnpm cli --client jev`
  is enough. An invalid key fails every turn as a client error; the
  summary then shows `client errors N` and a live run aborts after three
  in a row.
- Ctrl-C is safe. Every answer is appended as it arrives, and the run order
  is fixed (corpus in file order, then scenarios), so re-running `record`
  replays what is already there and pays only for the rest.
- A free lower bound on the request count: `pnpm regress --client recorded`
  with no cassette prints `cassette misses N`, and N is the number of live
  requests the recording will make at minimum (scenarios run further once
  real answers keep the call going).
- A corrupt line fails the load naming the file and line number. The file
  is append-only by design: delete the line and record again rather than
  editing it.
- `pnpm cli --client record` appends to the same file. Interactive
  exploration therefore grows the cassette with lines the regression run
  never replays; that is harmless but worth knowing.
- Once the cassette is committed, `pnpm test` validates it: the client
  builder's tests construct a `recorded` client, which loads and checks
  every line.

Threshold tuning then runs against `--client recorded`: no network, no
cost, and the diff shrinks as the thresholds fit the real distributions. A
tuned threshold that alters an earlier turn changes later turns' state and
misses the cassette; run `record` again to fill the gaps.

### Tuning

    pnpm sweep                     # sensitivity table, recommended thresholds, moves, misses
    pnpm sweep --apply             # also rewrite src/core/thresholds.ts and write docs/tuning/<date>-sweep.md
    pnpm sweep --only INTENT_ROUTE,SLOT_CHOICE_FILL
    pnpm sweep --json out.json

The sweep runs offline against the cassette. A candidate threshold set is
scored by how many corpus entries reproduce the label baseline's decision
(decision kind, prompt, form, slots, handoff reason, queued intents) plus
how many scenarios pass their own expectation; acks and the deciding gate
only break ties, and fewer cassette misses breaks a further tie. A
candidate that changes the stub's own outcomes is rejected outright, since
the label baseline is only meaningful while the stub reproduces it.

Each threshold is swept over a 0.05 grid with the others held fixed; the
recommended value is the middle of the widest plateau at the best score, so
the result sits away from cliffs. In the grid strip `#` marks the best
score, `+` the same decisions with a worse tiebreak, `~` one decision below
best, `-` further below, `x` a value the ordering constraints forbid and `!`
one that breaks the stub baseline, so a strip of only `#` and `+` means the
corpus never sees that threshold change an answer. Some findings are
reported but never applied: a best score reached at a single grid point (a
cliff); a plateau that runs to the edge of the grid (unbounded, meaning the
corpus has no evidence on that side); a threshold whose whole grid scores
the same (insensitive); and a threshold with only one legal value under the
ordering constraints (pinned). Every applied move lists the entries it
flipped, decisions and tiebreaks apart, and the report says whether the
descent converged and how many candidates it evaluated. Thresholds the sweep
will not move on its own live in `EXCLUDED` in `src/harness-text/sweepSpace.ts`
with the judgment that took each one out; they are left out of the default
`--only` set, named with their reason in every report, and still sweepable by
asking for them explicitly.

A move can push a multi-turn scenario off the recorded path; such scenarios
are unscored for that candidate and listed as misses. Record them once with
`pnpm regress --client record`, run `pnpm sweep` again to confirm, and
commit the thresholds with the report. A cassette miss on a single-turn
corpus entry means the recording is stale, and the sweep stops.

## Phone line (Twilio ConversationRelay)

The server puts the same decision core on a Twilio number. Prompts play
from recorded clips where one exists and fall back to Twilio's TTS for the
rest (see "Recorded prompts" below).

    cp .env.example .env      # fill in PUBLIC_HOST, TWILIO_AUTH_TOKEN, HANDOFF_NUMBER
    set -a; source .env; set +a
    pnpm serve                # not "pnpm server": that is pnpm's own store-server command and exits silently

Routes: `POST /voice` (the number's voice webhook), `POST /cr-action`
(ConversationRelay's connect callback), `GET /health`, and the WebSocket at
`wss://PUBLIC_HOST/conversation`.

Config is validated at startup: `PORT` must be in range, `HANDOFF_NUMBER`
must be an E.164 number like `+15551234567`, `PUBLIC_HOST` must be a bare
hostname (no scheme, no path, no trailing slash), and `TIMEZONE`, if set,
must be an IANA zone like `America/Los_Angeles`. Startup prints the resolved
config with secrets shown only as a length and fails with one line naming the
first missing or malformed variable.

Dates are resolved in `TIMEZONE` (default: the host's zone), so a caller at
8pm Pacific who says "tomorrow" means the next calendar day where they are,
not where UTC has already got to. `SESSION_TTL_MS` is how long an idle call
session is kept, `SESSION_MAX_AGE_MS` the hard cap on any one session.
`TODAY_OVERRIDE` pins the date for a demo. `DASHBOARD` is `on` (the default) or
`off`, and anything else fails startup; `off` serves no dashboard (see
"Dashboard" below). `CLIPS` is `off` (the default) or `on`. Off, no recorded clip
plays and ConversationRelay's TTS voice speaks every prompt, so the fixed
text, the names and the dates all come from one voice with no seams between
clips; `TTS_PROVIDER` and `TTS_VOICE` choose that voice. On plays the
recorded clips, with TTS only for the names and dates. The clip files are
left in place either way and `pnpm prompts:check` still reports on them.

`JEV_TIMEOUT_MS` is how long one request to Jev may take (default 1500) before
the turn gives up on it, plays "Sorry for the delay. You can also use your
keypad." and keeps the prompt open; a second failure in a row hands off. The SDK
retries once inside that budget, so a turn the model never answers costs the
caller up to twice it. A typical live ask takes about half a second; `.env.example`
sets 2500 to ride out a slow minute at the API. The harness takes the same
budget as `--threshold JEV_TIMEOUT_MS=...` (see "Regression").

No input: if the caller says and presses nothing after a prompt finishes
playing, the server treats the silence as an unanswered turn on whatever was
just asked — the same ladder a garbled answer walks: "I didn't hear
anything." then the question again, then the keypad offer, then an agent.
That first re-ask is the plain question, not the "Sorry, ..." retry text: the
apology is reserved for a turn where the caller said something that missed,
not for one where nothing was said at all.
The wait is `NO_INPUT_MS` (default 7 seconds) after the prompt's estimated
playback time — from the clip's WAV header for a recorded clip, or 2.5 words
per second for TTS text — and is approximate by design, so a wrong estimate
moves the wait by a second or two, not by the length of the prompt. Any
speech, a partial result, a keypad digit, or a barge-in cancels the wait and
starts a fresh one, so a caller who is audibly there is never cut off
mid-thought. A fresh wait that has nothing of its own to play still runs from
the end of the prompt that was already playing, so a cough a second into a
long menu does not put the re-ask on top of the rest of it.
`NO_INPUT_MS=0` disables it. The TwiML carries
`partialPrompts="true"` for this and only this: a partial tells the server the
caller has started speaking so the wait stops at the first syllable, but a
turn still runs only on the final transcript. A reconnect that replays the
last prompt starts a wait on it too. `interruptSensitivity="low"` and
`ignoreBackchannel="true"` are set because speakerphone room noise was
interrupting prompt playback and leaving the caller in silence until the
no-input timer fired; low sensitivity requires confident, longer speech to
interrupt, and backchannels never do. If three turns in a row throw, the
apology is still spoken but the wait stops re-arming, so a model that is down
cannot leave the line apologizing every few seconds; the server log says
`N consecutive turn failures, no-input wait stopped`.

Every slot walks that ladder, but the middle rung is the slot's own. `dob`
offers the keypad — "Please enter your date of birth on the keypad: two digits
for the month, two for the day, and four for the year." — and reads the eight
digits as MMDDYYYY under the same validity rules as a spoken answer. `name` has
no keypad rung at all, because a keypad cannot take a name: its ladder is the
retry text ("Sorry, I need your first and last name."), the retry text again,
then an agent. A birthday said without a year narrows instead of failing:
"March fifth" is answered with "And what year?", and a year on its own finishes
the slot. Saying the same partial again is not an answer and not progress —
"March fifth" at "And what year?", or "next week" at "next week. Which day
works for you?" — so it counts a failed attempt and walks the ladder rather
than asking the same question forever.

### Confirmation and multi-intent

A hedged request ("maybe cancel it") is confirmed before anything happens:
"Just to check, do you want to cancel your appointment?" The slots spoken in
that utterance are kept and filled once the caller says yes.

Every form that fills its last slot ends with a summary question instead of
finishing outright:

- `confirm_schedule`: "Dr. Chen has an opening on Tuesday, September 22 at
  8:30 AM. That would be for Jason Stiles, born March 5th, 1980. Shall I book
  it?"
- `confirm_reschedule`: "Your appointment with Dr. Chen is on Wednesday,
  September 23 at 9:15 AM. It would move to Tuesday, September 22 at 8:30 AM,
  for Jason Stiles, born March 5th, 1980. Shall I make that change?"
- `confirm_cancel`: "Your appointment with Dr. Chen is on Wednesday, September
  23 at 9:15 AM. It would be cancelled, for Jason Stiles, born March 5th,
  1980. Shall I cancel it?"
- `confirm_appointment_details`: "I found your appointment with Dr. Chen.
  It's on Wednesday, September 23 at 9:15 AM, for Jason Stiles, born March
  5th, 1980. Is that the one?"

Saying "yes" completes the form with a short line naming the booked time:
"You're booked for Tuesday, September 22 at 8:30 AM." for a new appointment,
"Your appointment is moved to Tuesday, September 22 at 8:30 AM." for a
reschedule. A correction — "no, Thursday", "no, Thursday with Dr. Alvarez",
"no, it's Jason Miles", "no, born March 6th 1980", or a bare "Thursday" on its
own — refills the named slot(s) and asks the summary again with the new
values.
Naming a detail without giving its new value re-asks that detail's own
question: "the name" is answered with "What's your first and last name?", "the
birthday" with "And your date of birth?". A bare "no" asks "What should I
change?" once per summary; answering that with another bare "no" still counts
as a turn spent on the confirmation, so repeated bare no's walk the same ladder
as an unanswered turn: a re-ask, then the keypad ("Press 1 to confirm, or 2 to
change something."), then an agent. An utterance that is neither yes/no nor a
slot value or name is itself an unanswered turn and follows that same ladder.
So is a correction to the value the summary just read back: "no, it's Jason
Miles" changes the name and asks the summary again, while "no, it's Jason
Stiles" against a summary that already says Jason Stiles changes nothing and
spends a turn on the ladder — the corpus keeps that pair as `fc-13` and
`fc-21`. The name, the date of birth and the member ID all fill silently —
no ack, no readback of their own — and are confirmed only in the summary, where
they can be corrected like any other slot. A form that ends in a handoff
(billing) has no summary; the slots collected so far ride along in the handoff
data instead.

An `AppointmentDirectory` seam (`src/domain/directory.ts`) backs the summary
with a booking and, on a scheduling form, an offer. Confirm, cancel and
reschedule read back the booking the directory found, with its time: the
`{existing}` span in the examples above. Schedule and reschedule never ask
the caller for a time; instead they offer an opening the directory found on
the caller's day, the `{when}` span, and the caller moves it rather than
naming a time outright. A part of the day the caller volunteers, anywhere on
the form and never asked for (the three-hour windows are 8 to 11 for morning,
11 to 2 for midday, and 2 to 5 for afternoon), picks the first opening inside
that window, or the nearest one to it with an ack first: "The closest I have
to the afternoon is 12:30 PM." At the summary, "earlier", "later", or "that
time doesn't work" moves the offer one opening at a time; at either end of
the day's openings the index does not move and the caller hears "That's the
earliest opening that day." or "That's the latest opening that day." instead,
since neither end wraps. Those two lines are the plain-no path in disguise:
each one still counts a turn on the summary's ladder, so two refusals at the
same end reach the keypad prompt just as two bare no's would. The whole
summary is read once; after that, a re-read that only moves the day or the
time says just that: "Friday, October 2 at 1:00 PM. Does that work?", so the
edge reads "That's the earliest opening that day. Friday, October 2 at 1:00
PM. Does that work?" It is still the summary's question, so yes books it and
the keypad and ladder work as before; a change of doctor, name or birthday
brings the whole summary back. At a booking summary, a confident earlier,
later or different time that names no new day is taken as a time request even
when the model also reads it as changing the date ("Do you have a later
appointment that day?"). A correction to the day or the doctor rebuilds both
the offer and the found booking from the new values. The demo directory invents every booking and every day's openings
deterministically from a hash of the caller's name, birthday and provider, so
the same caller hears the same appointment on every call; a real deployment
backs `AppointmentDirectory` with its own scheduling system instead. One
rough edge: "no, the morning" when the offer is already in the morning has
nothing to move, so it falls back to the plain-no path and asks "What should
I change?" rather than acknowledging that the time is already in the window
asked for.

A request added mid-task ("can I also ask about my bill") is acknowledged
once and queued: the current task completes with its short line, and the
call moves on with "Now, let's talk to billing." The name,
the date of birth and the member ID carry over; provider and date are asked
again, because an added task is a different appointment. Billing chained after
a scheduling form therefore asks for the member ID before it hands off: the
scheduling form never collected one. "Never mind, I have a question about my bill"
replaces the current task instead, and "actually, just cancel it instead"
keeps the appointment's provider and date because it is the same
appointment. A task that ends in a handoff (billing) always runs last, and
the `end` frame's handoff data lists the forms completed and any still
queued.

An opening utterance that names two tasks queues the second one the same
way: "I need to reschedule my appointment with Dr. Alvarez for next
Thursday, and also I have a question about my bill" is acknowledged with
"Sure, we'll talk to billing after this." before the first question is
even asked, as long as the first task routes plainly. A hedged opener
("maybe reschedule, and also my bill") confirms the first task explicitly
instead and drops the second; the caller can add it again once the form is
open.

A caller who sounds frustrated is walked up three rungs rather than
transferred outright. The first frustrated turn on a call is acknowledged —
"I understand, let's get this sorted." plays before whatever the turn would
have said anyway — and the call goes on. The second frustrated turn (and any
later one, unless the offer was already declined) asks instead of answering:
"Would you like me to connect you to a person, or keep going?" Saying yes
transfers, with reason `frustrated`. Saying no, "keep going", or anything
else that is neither a yes nor a no declines the offer — the offer is not
made again this call — and the caller goes back to the question they were on;
content spoken in that same breath still counts, so "keep going, it's Dr.
Chen" fills the provider on its way past. Two silences at the offer count the
same as a decline. A third frustrated turn, or a second one after a decline,
transfers directly with "Let me get you to someone who can help." The
wording never claims a problem the system does not otherwise know about — it
reacts to how the caller sounds, not to a guess at what's wrong.

Every form entry is acknowledged, however confident the intent was: "I'd be
happy to help you reschedule your appointment." plays before the first
question, after a keypad pick, and after a "yes" to the explicit check. A
caller who asks what the line can do, at any point, hears "I can help you
schedule, reschedule, cancel, or confirm an appointment, or connect you to
billing. You can just tell me what you need in your own words, and if you'd
rather talk to a person, say so anytime." and is then asked the question
they were on again: the open question at the start, the current slot
question mid-form, the summary at the summary, the keypad menu if that was
up. It costs no attempt. `capabilities` is one row in
`INFORMATIONAL_INTENTS`; another informational intent is another row.

The provider question asks "Do you have the name of the provider?" A name
in the answer fills as before ("yes, Dr. Chen"). A bare "yes" is answered
with "Which doctor is it with?"; a "no", an "I don't know", or "who are the
doctors" is answered with the list: "Our providers are Dr. Chen, Dr. Cheng,
Dr. Patel, or Dr. Okafor; Dr. Nguyen, Dr. Rossi, Dr. Kim, or Dr. Alvarez.
Which one is your appointment with?" Neither counts as an attempt, and each
plays at most once for the slot; a second "I don't know" after the list is
an ordinary miss, so the retry line, the keypad list, and the transfer
follow as they always did. The slot decides this through a `help` outcome
the form loop plays in place of its question; any slot can return one.

### Recorded prompts

    pnpm -s prompts:sheet > clips.tsv # every clip id with the exact text to record (-s keeps pnpm's banner out)
    pnpm prompts:check                # which clips are present under AUDIO_DIR, and which are stale
    pnpm prompts:generate             # generate every missing clip with Fish Audio (FISH_AUDIO_API_KEY, FISH_VOICE)
    pnpm prompts:generate --only greeting.0 --candidates 3 --force   # audition variants under assets/audio/candidates/
    pnpm prompts:generate --pick greeting.0-2      # promote a candidate to the clip and record it
    pnpm prompts:generate --dry-run --voice Hannah --only greeting.0 # print the request; no key, no network

After the name-and-date-of-birth change, `pnpm prompts:check` reports 10
missing clips and 8 stale ones. The missing ones are the six new prompts —
`ask_name`, `ask_name_retry`, `ask_dob`, `ask_dob_retry`, `ask_dob_year`,
`ask_dob_dtmf` — and the new closing segment of each of the four summary
questions; the stale ones are the segments that shifted under them, since
clip ids are positional: index by index, each summary's tail now reads "for"
and "born" around the two new variables. All four summaries are
therefore re-recorded. The member-ID prompts (`ask_memberId`,
`ask_memberId_retry`, `ask_memberId_dtmf`) stay as they are: billing still asks
for an ID. So does `ack_memberId`, which exists for the `by-confidence`
readback policy and is unreachable while the member ID is a summary-policy slot
on a form that has no summary. See Task 7 of
`docs/superpowers/plans/2026-09-20-name-dob.md` for the exact commands.

The frustration acknowledgment and transfer offer add two clips —
`ack_frustration.0` ("I understand, let's get this sorted.") and
`offer_transfer.0` ("Would you like me to connect you to a person, or keep
going?") — and re-record `handoff_frustrated.0` for its new text ("Let me
get you to someone who can help."). `pnpm prompts:check` reports 2 missing
and 1 stale until those are recorded (Task 3 of
`docs/superpowers/plans/2026-09-22-frustration-escalation.md`).

The demo polish adds three clips, `capabilities.0`, `provider_list.0` and
`ask_provider_name.0`, and re-records `ask_provider.0` ("Do you have the
name of the provider?"), `ack_intent.0` ("I'd be happy to help you"), and
the vocabulary clips `intent.reschedule`, `intent.cancel`,
`intent.confirm_appointment` and `intent.billing` for their new labels.
`pnpm prompts:check` reports 3 missing and 6 stale until those are recorded
(Task 5 of `docs/superpowers/plans/2026-09-24-demo-polish.md`).

The short re-read of a moving offer adds one clip, `confirm_time.0` ("Does
that work?"), which matters only with `CLIPS=on`. The appointment-slots
change adds seven clips (`slot_edge_earlier.0`,
`slot_edge_later.0`, `slot_nearest.0` and `.1`, and the vocabulary clips
`daypart.morning`, `daypart.midday`, `daypart.afternoon`) and re-records the
four summaries (`confirm_schedule`, `confirm_reschedule`, `confirm_cancel`,
`confirm_appointment_details`) and the two completions
(`schedule_confirmed`, `reschedule_confirmed`) for the found booking and the
offered time. `pnpm prompts:check` reports 10 missing clips
(`confirm_reschedule.5`, `confirm_cancel.4`, `confirm_appointment_details.4`,
`slot_edge_earlier.0`, `slot_edge_later.0`, `slot_nearest.0`,
`slot_nearest.1`, `daypart.morning`, `daypart.midday`, `daypart.afternoon`),
17 stale ones (`confirm_schedule.0`-`.3`, `confirm_reschedule.1`-`.4`,
`confirm_cancel.1`-`.3`, `confirm_appointment_details.0`-`.3`,
`schedule_confirmed.0`, `reschedule_confirmed.0`), and `confirm_schedule.4`
as unused, until those are recorded (Task 6 of
`docs/superpowers/plans/2026-09-24-appointment-slots.md`).

Clips live in `assets/audio/` (or `AUDIO_DIR`) as `<clipId>.wav` or `.mp3`
and are discovered by filename; adding one needs no manifest edit. A clip
id is a fixed segment of a prompt (`ack_provider.0`, the text before the
provider name) or a vocabulary value (`provider.chen`, `intent.cancel`,
`window.next_week`). The caller's name, their date of birth, the appointment
date and the member ID are always spoken by TTS, never played from a clip, and
always at a clause boundary so the voice change is not inside a sentence. The sheet's
`open` note means the segment precedes a variable: the generator records it
without a falling intonation by sending it with a trailing comma in the
request text (`--plain-open` turns that off for the whole run; combine it
with `--only <id> --force` to drop the comma for one clip at a time). Bare
punctuation after a variable is never recorded.

Fixed clip ids are positional, so editing a template can make an existing
clip say the wrong thing. The generator writes `assets/audio/recorded.json`
(clip id → the text it recorded) and `pnpm prompts:check` reports a clip as
`stale` when that text no longer matches the sheet; regenerate it with
`--only <id> --force`. `--pick <id>-<n>` promotes an auditioned candidate to
the final clip and records it in the sidecar, deleting the other candidates
generated for that id. Fish streams its TTS responses, so the WAV headers
that come back carry placeholder RIFF/data sizes; the generator repairs them
on download, and `pnpm prompts:generate --repair-wav` fixes clips that were
generated before this existed.

The server discovers clips once at startup (restart it after adding one),
serves them at `https://PUBLIC_HOST/audio/<file>`, and logs coverage; any segment without a clip falls back to TTS for that
segment only, and adjacent TTS segments are merged so prosody survives.
Each clip URL carries a `?v=<hash>` content hash of the file's bytes, so a
clip regenerated under the same filename gets a new URL and is never played
back from Twilio's day-long cache of the old one.
Clips are generated with Fish Audio's `s2.1-pro` model and the voice named
in `FISH_VOICE`. Set `FISH_VOICE` to the voice's id from its page URL
(`fish.audio/m/<id>/`), not its title: Fish's library is public and titles
are shared across voices, so a title can match more than one; the generator
prints which voice it resolved (or refuses to run if the title is
ambiguous). A tag prefixes every clip (per clip in
`src/prompts/tags.json`). Tags come from Fish's documented S2 bracket-tag
inventory, checked into `src/prompts/fishTags.json` and enforced by a test;
free-form phrases are accepted by the API but untested against the web
tool's picker, so set one per clip in `tags.json` only after hearing the
inventory version. Fish Audio is not a ConversationRelay TTS
provider, so set `TTS_PROVIDER` and `TTS_VOICE` (Google, Amazon, or
ElevenLabs) to the closest voice to keep the seams on names, birthdays,
member IDs and dates as quiet as possible.

### Dashboard

A page that shows what the system is doing during a call, served by the same
server at `https://PUBLIC_HOST/dashboard` (or `http://localhost:3000/dashboard`
on the machine running the server). It reads what the trace already records and
never influences a turn.

The left column is the call as the caller had it: the conversation line by line
with the prompt id beside each system line and quiet markers between turns
(silence, keypad digits, an interrupt, a reconnect, a transfer), and under it the
form state — the active form, its slots as chips that go empty, partial, then
filled, and a line each for the pending confirmation, a queued task and the slot
being asked. The right column is that turn's question batch grouped by role
(`gates`, `intent`, `confirmation` while one is pending, then one group per slot
on the form), each row the question id with its probability as a bar and its
threshold as a tick, with the top options and their probabilities under a
decisive choice row; quiet groups collapse to a count and open on click, and the
bottom line names the gate that decided, the slots that moved and the next
prompt.

Two modes from the toolbar. **Live** subscribes to the server's event stream and
follows the most recent call, so a page opened mid-call catches up on what it
missed. **Replay** picks a finished call from `traces/` and walks it: Space plays
and pauses, ArrowRight steps one event, ArrowLeft steps back, Home resets to the
start of the call. Play runs at the call's recorded pace, with a 1x/2x/4x speed
select and a five-second cap on any gap — except for the beat, which is how long
the outgoing question batch is held on screen with empty bars before the answers
fill in (800 ms by default, adjustable in the toolbar; live it is the model's own
~170 ms, which is too fast to see). A replayed call is drawn with today's
threshold ticks, not the ones it was recorded under, which the toolbar says.

`DASHBOARD=off` turns the page off: no bus, nothing published, and every
`/dashboard` route 404s.

The page shows only what the trace stores, and every caller number is masked to
its last four digits — on the setup frame, on the `/cr-action` webhook's fields
and on every record the trace route returns — before it leaves the server.

### Live-call checklist

1. `ngrok http --domain=PUBLIC_HOST 3000` in one terminal; `pnpm serve` in another.
2. In the Twilio console, set the number's voice webhook to
   `https://PUBLIC_HOST/voice` (HTTP POST). Nothing else is configured there;
   the TwiML returned by `/voice` carries every ConversationRelay attribute.
3. `curl https://PUBLIC_HOST/health` before dialing. It should answer
   `{"ok":true,"sessions":0,"retained":0}`; anything else means ngrok and the
   server are not actually connected, which is easier to see here than on a call.
4. Open `https://PUBLIC_HOST/dashboard` full screen at 1920 by 1080 before you
   dial, and watch it during the call: it should say `waiting for a call`, then
   `live · …NNNN` on the setup frame. Leave it open for the whole call. A call
   left idle long enough for the server's `sweep` to evict its session ends on
   the page as `ended · error`, which is the only way an evicted live call is
   reported there.
5. Call the number. You should hear the greeting within a second.
6. Call again and stay quiet after the greeting: expect "I didn't hear
   anything." then the question again, then the keypad menu, then the
   transfer to `HANDOFF_NUMBER` — the same ladder step 19 walks by saying
   something unrecognized instead. Partial results are on: watch the server
   log for the one-per-connection "dropped a non-final prompt" line while you
   speak, and confirm that starting to talk during a long pause stops the
   re-ask rather than racing it.
7. Say: "I need to reschedule my appointment, it's with Dr. Chen sometime next
   week." Expect: "I'd be happy to help you reschedule your appointment.
   What's your first and last name?"
8. Say "Jason Stiles". Expect "And your date of birth?" — the name fills
   silently, with no readback of its own; it is confirmed only in the summary
   (step 10).
9. Say "March fifth, nineteen eighty". Expect the window question on its own,
   again with no readback: "next week. Which day works for you?"
10. Say "Tuesday". Expect the summary question: "Your appointment with Dr. Chen
    is on Wednesday, September 23 at 9:15 AM. It would move to Tuesday,
    September 22 at 8:30 AM, for Jason Stiles, born March 5th, 1980. Shall I
    make that change?" Listen to how the year comes out: a lone
    four-digit run is left to TTS to read as a year, so it should say "nineteen
    eighty", not "one nine eight zero".
11. Call again and give the birthday without a year: say "Jason Stiles", then
    "March fifth". Expect "And what year?"; answer "nineteen eighty" and expect
    the day question to follow.
12. Keypad birthday: call again, get to "And your date of birth?", and stay
    quiet twice. Expect the question again, then "Please enter your date of
    birth on the keypad: two digits for the month, two for the day, and four
    for the year." Press `03051980` and expect the day question. There is no
    keypad rung for the name: staying quiet three times at "What's your first
    and last name?" transfers instead.
13. Call again and say all of it at once: "I need to reschedule my appointment
    with Dr. Chen next week, this is Jason Stiles, born March 5th 1980."
    Expect the day question directly — "next week. Which day works for you?" —
    with neither the name nor the birthday asked. (This narrowed phrasing holds
    on the live line. Typed into the REPL, the heuristic stub drops the window
    once a year is present and asks the plain day question instead.)
14. Call again, repeat through step 10, then stay quiet at the summary
    question: expect "I didn't hear anything." then the summary question
    again, then the keypad offer ("Press 1 to confirm, or 2 to change
    something."), then the transfer.
15. Call again, repeat through step 10, then say "yes". Expect "Your
    appointment is moved to Tuesday, September 22 at 8:30 AM." then "Goodbye.", and the call ends: the server leaves the socket open after `end` so Twilio can
    finish the queued clips, and Twilio closes it and hits `/cr-action` with
    `SessionStatus=ended`.
16. Call again, repeat through step 10, then say "no, Thursday" instead of
    "yes". Expect only the new day and time, "Thursday, September 24 at
    <time>. Does that work?", since only the day changed. Then try "no, it's
    Jason Miles": expect the whole summary again with the new name. Say "yes" to finish.
17. Call again and say: "I need to reschedule my appointment with Dr.
    Alvarez for next Thursday, and also I have a question about my bill."
    Expect "Sure, we'll talk to billing after this." before the name
    question. Give the name and birthday, say "yes" at the summary, and expect
    "Now, let's talk to billing." followed by "What's your member ID?" — a
    chained billing task collects its own ID before the handoff, because the
    scheduling form never asked for one.
18. Call again and say "I have a question about my bill" on its own. Expect
    "I'd be happy to help you talk to billing. What's your member ID?", the eight digits spoken or keyed, then the
    billing handoff: billing is the one form that still identifies the caller
    by member ID.
19. Call again and say "agent". Expect the transfer to `HANDOFF_NUMBER`.
20. Call again, say "what are your hours" three times. Expect the open
    reprompt, the keypad menu, then the transfer.
21. Call again, get as far as the date-of-birth question, then kill `pnpm serve`
    (Ctrl-C) and start it again. ConversationRelay's session fails, `/cr-action`
    reconnects, and the caller hears the last prompt again. Repeat the kill more
    than `RECONNECT_LIMIT` times on one call: the next callback stops
    reconnecting, apologizes, and dials `HANDOFF_NUMBER`.
22. Replay the call: `pnpm cli --replay traces/<CallSid>.frames.jsonl`
    and compare its decisions with `traces/<CallSid>.jsonl`.
23. Call again and say "this is ridiculous, I need to reschedule" at the
    greeting. Expect "I understand, let's get this sorted." before the name
    question. Give the name, then be frustrated again at the birthday
    question ("this is ridiculous, I already gave you my birthday"): expect
    the offer, "Would you like me to connect you to a person, or keep
    going?" Say "keep going" and expect the birthday question again. On
    another call, repeat through the offer and say "yes": expect "Let me get
    you to someone who can help." then the transfer to `HANDOFF_NUMBER`. Be
    frustrated on a turn that also answers the question ("this is ridiculous,
    Jason Stiles") so the acknowledgment is followed by the next question
    rather than the retry text. Expect the cassette to re-key every turn that
    follows a first-rung outburst: the acknowledgment becomes part of the
    prompt the model sees.
24. The demo caller's path: at the greeting say "I'd like to learn more about
    what you are and what you do". Expect the capabilities line and then
    "How can I help you today?" with no attempt spent. Say "I'd like to
    reschedule": expect "I'd be happy to help you reschedule your
    appointment. What's your first and last name?" Give the name and
    birthday; at "Do you have the name of the provider?" say "no": expect
    the list, split in two runs of four. Say "Dr. Kim" and expect the day
    question. On another call say "yes" at the provider question and expect
    "Which doctor is it with?"
25. Call again and say "Book me with Dr. Chen next Thursday afternoon". Give
    the name and birthday. Expect the summary to offer an afternoon opening,
    not just any opening on Thursday.
26. On that same call, say "earlier" at the offer. Expect only the new time,
    one opening earlier: "Thursday, September 24 at 11:15 AM. Does that
    work?" (Dr. Chen's Thursday openings are 10:00 AM, 11:15 AM and 4:15 PM).
    Say "earlier" twice more: the second lands on 10:00 AM, and the third
    plays "That's the earliest opening that day." before the same short
    question. Try "Do you have a later appointment that day?" too: expect the
    next opening, not the day question.
27. Call again, reschedule with Dr. Chen through the day question, say
    "later" at the offer, then "yes". Expect the completion to name the
    moved-to time: "Your appointment is moved to Tuesday, September 22 at
    <time>."
28. Call again and say "confirm my appointment with Dr. Chen". Give the name
    and birthday. Expect "I found your appointment with Dr. Chen. It's on
    ..." reading back the booking the directory found, not a bare "Is that
    the one?"
29. Call again to reschedule with Dr. Chen and, at the day question, say
    "sometime around lunchtime". Expect the day question again, since a part
    of the day on its own does not answer it. Then say "Tuesday" and expect the
    summary to offer the midday opening.

Things to note on the first real call, per the spec's open questions: whether
`speechModel="flux"` is accepted alongside partial prompts, how long Deepgram
takes to finalize a turn, whether an interrupted prompt also arrives as a
`prompt`, and how TTS reads a name, a birthday, the member ID and the provider
names. Watch the opener's latency too: the turn outside a form now asks 32
questions rather than 26 — `nameGiven`, `nameSpan`, `dobGiven`, `dobMonth`,
`dobDay`, `dobYear` are all on it — which costs a fraction of a cent but
several hundred more output tokens on the longest turn of the call. That is the
turn to check against `JEV_TIMEOUT_MS` before trusting the default.

### Operational notes

- ConversationRelay never reconnects on its own. The `/cr-action` callback
  reconnects a session only while the call is still live (`CallStatus
  in-progress` and the session hasn't ended); the caller hears the last
  prompt again, up to `RECONNECT_LIMIT` attempts before it dials
  `HANDOFF_NUMBER`. If the caller hung up (`SessionStatus completed`) the
  callback just hangs up rather than reconnecting or dialing.
- A WebSocket upgrade without a live per-call token is refused at the HTTP
  level (401, before the socket is accepted): the token must be well formed
  *and* currently minted for some call, and `setup` then checks it against that
  specific call SID. A connection that is accepted but never sends a setup
  message is closed after ten seconds. The token travels in the WebSocket URL,
  so it appears in ngrok's request inspector and in anything else that logs
  URLs; there is one live token per call, replaced on every re-mint, and it expires in ten minutes, but treat those
  logs accordingly.
- Ten unparsable inbound messages close the socket with 1007. A prompt message
  with `last: false` is logged and dropped rather than run as a turn: partial
  prompts are on so they can cancel the no-input wait, not so they can be
  scored. The operator log says so once per connection; the frame log records
  every one.
- Ten consecutive unrecognized outbound messages close the socket (Twilio
  error 64105). The adapter sends only the five documented message types.
- Signature validation needs `PUBLIC_HOST` to match the ngrok domain exactly.
  `SIGNATURE_CHECK=off` is for local tests only and prints a warning: with it
  off, anyone who can reach the URL can drive sessions and end live calls,
  because `/voice` and `/cr-action` will accept their forged callbacks.
- Every inbound socket message is logged, including ones the adapter ignores
  (wrong call, after the call ended, before setup, and so on).
- `GET /health` reports `sessions` (calls that can still speak to someone) and
  `retained` (ended calls held for a minute afterwards, so a late callback finds
  them). A `retained` count that keeps climbing means calls are not ending.
- Every call writes `traces/<CallSid>.jsonl` (trace records) and
  `traces/<CallSid>.frames.jsonl` (raw socket messages and webhooks); the
  file names are sanitized from the call SID, not used verbatim. A record also
  carries three optional fields the dashboard reads — `queued` (the queued
  forms), `pendingConfirmation` and `promptedFor` (what the turn's prompt asked
  for). They were added for the dashboard, so a trace recorded before them
  replays without them: the queue, pending and asking lines are simply absent.
- Frame logs contain caller phone numbers (`From`/`To`) and error stacks, so
  treat `traces/` as sensitive and don't share its contents raw.
- Startup logs `no-input: 7000 ms after playback (N clip durations)` (the
  default `NO_INPUT_MS`, and how many clips under `AUDIO_DIR` had a WAV
  header the server could measure), or `no-input: off` when `NO_INPUT_MS=0`.

## Layout

    src/domain        intents, forms, slot specs, provider roster
    src/core          state, question set, gate ladder, form loop, extraction, turn
    src/jev           client interface, stubs, SDK client
    src/channel       ConversationRelay frame types
    src/prompts       manifest, segments.ts, clips.ts (clip discovery), rendering, sheet.ts
                      (recording sheet), generate.ts, tags.json (Fish Audio clip generation)
    src/trace         JSONL trace record
    src/run           runTurn, client builder, local-date clock (shared by the CLI and the server)
    src/server        Twilio ConversationRelay server: config, http, ws, adapter, sessions
    src/server/dashboard  the live call dashboard: events, bus, observer, routes,
                          view.js (the pure reducer), page.html, fixtures
    src/harness-text  CLI, runner, metrics, regression
    fixtures          corpus, scenarios, recorded outcomes
    assets/audio      recorded prompt clips (<clipId>.wav/.mp3), discovered by filename

## DTMF baseline

`src/domain/dtmf-baseline.json` counts caller turns under a conventional
keypad tree: main menu, birthday entry, birthday confirm, provider menu, date
entry, date confirm, final confirm. The metrics summary reports observed turns
against it.

A keypad tree cannot take a name, so the scheduling branches now key in a
birthday where they used to key in a member ID; billing keeps the ID entry. The
turn counts are unchanged (7, 7, 5, 5 for the scheduling forms, 3 for billing),
and the file holds counts only — which is why the ID-to-birthday swap is
recorded here rather than in the JSON. The metric that moves is what the voice
path gets for those turns: it collects a name as well, in the same number of
turns.
