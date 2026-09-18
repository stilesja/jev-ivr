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

    pnpm regress            # diff outcomes against fixtures/expected
    pnpm regress --update   # re-record after an intended change

Outcomes include the final decision, prompt id, deciding gate, filled slots, and implicit-confirm acks, so a threshold change that only alters spoken confirmations still shows up in the diff.

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
  URLs; it is single-use per call and expires in ten minutes, but treat those
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
