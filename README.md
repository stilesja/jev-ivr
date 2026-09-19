# jev-ivr

A mixed-initiative voice IVR front end driven by a fast, calibrated,
non-generative decision model (TypeSafe's Jev), demonstrated on a healthcare
scheduling flow. See `JEV-IVR-HANDOFF.md` for the thesis and
`docs/superpowers/specs/` for the design.

Status: Phase 3a (phone line over Twilio ConversationRelay); Phase 0–1 merged.
No Jev API key yet; the harness runs against a deterministic stub keyed on a
labeled corpus.

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

In the REPL, type an utterance, `dtmf:44718293` to send keypad digits, or
`/reset` to start a new call. The corpus has 154 labeled utterances and there
are 35 scenarios available for multi-turn testing.

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

Corpus entries carry four kinds of label the stub answers from: the intent
and slots, `tentative` (the caller hedges the request, so it is confirmed
explicitly), `change` (`adding` or `replacing`, for an in-form utterance
that asks for another task), and `providerUnsure` (a hedged or dual provider
name is read back). An entry with none of the last three is a plain,
committed answer to the current question. The parser rejects unknown
fields, mistyped labels, and a labeled slot that is not on the entry's form.

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

The server puts the same decision core on a Twilio number. Prompts are
spoken by Twilio's TTS from the manifest text; recorded audio comes later.

    cp .env.example .env      # fill in PUBLIC_HOST, TWILIO_AUTH_TOKEN, HANDOFF_NUMBER
    set -a; source .env; set +a
    pnpm server

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
`TODAY_OVERRIDE` pins the date for a demo.

### Confirmation and multi-intent

A hedged request ("maybe cancel it") is confirmed before anything happens:
"Just to check, do you want to cancel an appointment?" The slots spoken in
that utterance are kept and filled once the caller says yes. A spoken
member ID is always read back, "Your member ID is 4471 8293. Is that
right?"; a "no" goes straight to the keypad, a second "no" or repeated
silence hands off, and digits typed on the keypad need no readback. A
request added mid-task ("can I also ask about my bill") is acknowledged
once and queued: the current task finishes, its summary is spoken without
a goodbye, and the call moves on with "Now, let's ask about billing." The member
ID carries over; provider and date are asked again, because an added task
is a different appointment. "Never mind, I have a question about my bill"
replaces the current task instead, and "actually, just cancel it instead"
keeps the appointment's provider and date because it is the same
appointment. A task that ends in a handoff (billing) always runs last, and
the `end` frame's handoff data lists the forms completed and any still
queued.

### Live-call checklist

1. `ngrok http --domain=PUBLIC_HOST 3000` in one terminal; `pnpm server` in another.
2. In the Twilio console, set the number's voice webhook to
   `https://PUBLIC_HOST/voice` (HTTP POST). Nothing else is configured there;
   the TwiML returned by `/voice` carries every ConversationRelay attribute.
3. `curl https://PUBLIC_HOST/health` before dialing. It should answer
   `{"ok":true,"sessions":0,"retained":0}`; anything else means ngrok and the
   server are not actually connected, which is easier to see here than on a call.
4. Call the number. You should hear the greeting within a second.
5. Say: "I need to reschedule my appointment, it's with Dr. Chen sometime next
   week." Expect: "What's your member ID?"
6. Spoken ID: say the eight digits. Expect the readback and then the window
   question, as one turn: "Member ID four four seven one, eight two nine three.
   Which day next week works for you?" (the digits are spaced out before they
   reach TTS, which would otherwise read "4471 8293" as two large numbers).
7. Keypad ID: on a second call, press the eight digits instead. Expect the
   window question on its own, with no readback — keypad entry is unambiguous,
   so there is nothing to implicitly confirm.
8. Say "Tuesday". Expect the confirmation and the call ends.
9. Call again and say "agent". Expect the transfer to `HANDOFF_NUMBER`.
10. Call again, say "what are your hours" three times. Expect the open
    reprompt, the keypad menu, then the transfer.
11. Call again, get as far as the member ID question, then kill `pnpm server`
    (Ctrl-C) and start it again. ConversationRelay's session fails, `/cr-action`
    reconnects, and the caller hears the last prompt again. Repeat the kill more
    than `RECONNECT_LIMIT` times on one call: the next callback stops
    reconnecting, apologizes, and dials `HANDOFF_NUMBER`.
12. Replay the call: `pnpm cli --replay traces/<CallSid>.frames.jsonl`
    and compare its decisions with `traces/<CallSid>.jsonl`.

Things to note on the first real call, per the spec's open questions: whether
`speechModel="flux"` is accepted with partial prompts off, how long Deepgram
takes to finalize a turn, whether an interrupted prompt also arrives as a
`prompt`, and how TTS reads the member ID and provider names.

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
  with `last: false` is logged and dropped rather than run as a turn, since the
  TwiML has partial prompts off.
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
  file names are sanitized from the call SID, not used verbatim.
- Frame logs contain caller phone numbers (`From`/`To`) and error stacks, so
  treat `traces/` as sensitive and don't share its contents raw.

## Layout

    src/domain        intents, forms, slot specs, provider roster
    src/core          state, question set, gate ladder, form loop, extraction, turn
    src/jev           client interface, stubs, SDK client
    src/channel       ConversationRelay frame types
    src/prompts       prompt manifest and rendering
    src/trace         JSONL trace record
    src/run           runTurn, client builder, local-date clock (shared by the CLI and the server)
    src/server        Twilio ConversationRelay server: config, http, ws, adapter, sessions
    src/harness-text  CLI, runner, metrics, regression
    fixtures          corpus, scenarios, recorded outcomes

## DTMF baseline

`src/domain/dtmf-baseline.json` counts caller turns under a conventional
keypad tree: main menu, ID entry, ID confirm, provider menu, date entry, date
confirm, final confirm. The metrics summary reports observed turns against it.
