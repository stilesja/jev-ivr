# jev-ivr

A mixed-initiative voice IVR front end driven by a fast, calibrated,
non-generative decision model (TypeSafe's Jev), demonstrated on a healthcare
scheduling flow. See `JEV-IVR-HANDOFF.md` for the thesis and
`docs/superpowers/specs/` for the design.

Status: Phase 0–1 (decision core and text harness). No Jev API key yet; the
harness runs against a deterministic stub keyed on a labeled corpus.

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
    pnpm cli --replay traces/<CallSid>.frames.jsonl --today $(date +%F)   # replay a call's frame log

In the REPL, type an utterance, `dtmf:44718293` to send keypad digits, or
`/reset` to start a new call. The corpus has 152 labeled utterances and there
are 34 scenarios available for multi-turn testing.

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
must be an E.164 number like `+15551234567`, and `PUBLIC_HOST` must be a
bare hostname (no scheme, no path, no trailing slash). Startup prints the
resolved config with secrets masked and fails with one line naming the
first missing or malformed variable.

### Live-call checklist

1. `ngrok http --domain=PUBLIC_HOST 3000` in one terminal; `pnpm server` in another.
2. In the Twilio console, set the number's voice webhook to
   `https://PUBLIC_HOST/voice` (HTTP POST). Nothing else is configured there;
   the TwiML returned by `/voice` carries every ConversationRelay attribute.
3. Call the number. You should hear the greeting within a second.
4. Say: "I need to reschedule my appointment, it's with Dr. Chen sometime next
   week." Expect: "What's your member ID?"
5. Say the eight digits, or press them on the keypad. Expect: "Member ID
   4471 8293. Which day next week works for you?"
6. Say "Tuesday". Expect the confirmation and the call ends.
7. Call again and say "agent". Expect the transfer to `HANDOFF_NUMBER`.
8. Call again, say "what are your hours" three times. Expect the open
   reprompt, the keypad menu, then the transfer.
9. Replay the call: `pnpm cli --replay traces/<CallSid>.frames.jsonl --today $(date +%F)`
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
- A WebSocket upgrade without a valid per-call token is refused at the HTTP
  level (401, before the socket is accepted). A connection that is accepted
  but never sends a setup message is closed after ten seconds.
- Ten consecutive unrecognized outbound messages close the socket (Twilio
  error 64105). The adapter sends only the five documented message types.
- Signature validation needs `PUBLIC_HOST` to match the ngrok domain exactly.
  `SIGNATURE_CHECK=off` is for local tests only and prints a warning.
- Every inbound socket message is logged, including ones the adapter ignores
  (wrong call, after the call ended, before setup, and so on).
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
    src/run           runTurn, client builder (shared by the CLI and the server)
    src/server        Twilio ConversationRelay server: config, http, ws, adapter, sessions
    src/harness-text  CLI, runner, metrics, regression
    fixtures          corpus, scenarios, recorded outcomes

## DTMF baseline

`src/domain/dtmf-baseline.json` counts caller turns under a conventional
keypad tree: main menu, ID entry, ID confirm, provider menu, date entry, date
confirm, final confirm. The metrics summary reports observed turns against it.
