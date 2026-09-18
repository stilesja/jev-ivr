# Design: Phase 3a, Twilio phone line

Date: 2026-09-18
Status: approved for planning
Parent: `JEV-IVR-HANDOFF.md` §4, §10, §11 (Phase 3 items 11 and 13); builds on
`2026-09-18-text-harness-design.md`, which governs the core.

## 1. Scope

This sub-project puts the decision core on a real phone number. A caller dials
the Twilio number, Twilio opens a ConversationRelay WebSocket to our server,
and the existing core drives the call: greeting, mixed-initiative slot
filling, DTMF fallback, confirmations, and agent handoff. Prompts are spoken
by Twilio's TTS from the manifest text.

In scope:

- HTTP server with the voice webhook, the `<Connect action>` callback, and a
  health route; Twilio request-signature validation on both webhooks.
- TwiML builders for the ConversationRelay connect, the handoff dial, hangup,
  and reconnect.
- WebSocket server and a ConversationRelay adapter that maps socket messages
  to core events and core decisions to socket messages, with a per-session
  turn queue.
- In-memory session store keyed by call SID, with reconnect support.
- Raw frame log per call and a `--replay` mode in the text harness.
- A fake ConversationRelay client for tests; a manual live-call checklist.
- Config from environment variables; one-line startup failure when missing.

Out of scope, each a later sub-project:

- Recorded audio assets, `play` frames, fetch-audio orchestration and the
  audibility metric (Phase 3b).
- Partial prompts (`last: false` from Twilio), debounce, in-flight
  cancellation (Phase 3c). The server treats every prompt as final and the
  TwiML leaves `partialPrompts` off.
- The browser debug panel; any persistence beyond process memory; outbound
  calls; a whisper or reason announcement on the dialed agent leg; multiple
  languages.

## 2. Decisions made here

| Decision | Choice | Why |
| --- | --- | --- |
| Server stack | `node:http` plus the `ws` package; no framework, no `twilio` SDK | TwiML is four fixed documents; signature validation is a short HMAC; fewer dependencies to explain |
| Core entry | `runTurn` moves to `src/run/turn.ts` and is shared by CLI and server | Frame logs from real calls must replay through identical code |
| Concurrency | One turn at a time per session, via a promise chain per call SID | A digit arriving during a model call must not resolve against a stale clone |
| Session key | Twilio `callSid`, not `sessionId` | A reconnect gets a new session id but the same call |
| WebSocket auth | Per-call random token placed in the connect URL query, checked on `setup` | ConversationRelay does not sign socket messages; the TwiML that carries the token is itself signed |
| TTS | `text` frames with manifest text, `interruptible` from the manifest, `preemptible` false | Prompts play through; only fetch audio (later) is preemptible |
| Greeting | Sent by us on `setup`, not `welcomeGreeting` | Keeps the greeting in the trace and under the same path as every other prompt |
| Transcription | Deepgram, `speechModel="flux"`, `deepgramSmartFormat="false"`, `partialPrompts="false"` | Raw spoken forms for the normalizer; finals-only first, per handoff §10 |
| Handoff | `<Dial>` to `HANDOFF_NUMBER` for every non-`completed` reason | One transfer path for the demo; billing gets the same number for now |
| Reconnect | Fresh `<Connect><ConversationRelay>` on the action callback when the socket dropped mid-call, at most `RECONNECT_LIMIT` (2) times, then dial the handoff number | ConversationRelay never reconnects on its own |

## 3. Layout

```
src/run/turn.ts              runTurn (moved from harness-text/runner.ts), RunOptions, TurnRun
src/server/index.ts          entry: config, http server, ws server, shutdown
src/server/config.ts         env parsing with defaults and required-variable errors
src/server/http.ts           routes: POST /voice, POST /cr-action, GET /health
src/server/twiml.ts          connectRelay(), dialHandoff(), hangup(), reconnect()
src/server/signature.ts      validateTwilioSignature(url, params, header, authToken)
src/server/hints.ts          buildHints() from providers and slot vocabulary
src/server/ws.ts             upgrade handling, token check, message parsing
src/server/adapter.ts        ConversationRelay adapter: socket messages <-> core
src/server/sessions.ts       SessionStore: get, create, resume, end, per-session queue
src/server/frameLog.ts       raw inbound/outbound frame JSONL per call
src/server/tokens.ts         random call tokens with expiry
src/harness-text/replay.ts   feeds a frame log through runTurn and prints tables
src/testing/fakeRelay.ts     test client speaking the ConversationRelay protocol
```

`src/core`, `src/domain`, `src/jev`, `src/prompts`, `src/trace` are unchanged
except that `src/channel/frames.ts` gains the extra `setup` fields Twilio
sends (`accountSid`, `parentCallSid`, `forwardedFrom`, `callType`,
`callerName`, `direction`, `callStatus`), all optional, passed through and
logged.

## 4. Configuration

Environment variables, read once at startup by `src/server/config.ts`:

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PORT` | no | 3000 | HTTP and WebSocket listen port |
| `PUBLIC_HOST` | yes | | Public hostname (the ngrok domain), used to build `wss://` and callback URLs |
| `TWILIO_AUTH_TOKEN` | yes | | Signature validation |
| `HANDOFF_NUMBER` | yes | | E.164 number dialed on agent handoff |
| `JEV_CLIENT` | no | `stub` | `stub`, `heuristic`, or `jev` |
| `TYPESAFE_API_KEY` | when `JEV_CLIENT=jev` | | Passed to the SDK client |
| `TODAY_OVERRIDE` | no | | `YYYY-MM-DD`, for deterministic tests; otherwise the wall clock |
| `TRACE_DIR` | no | `traces` | Where per-call trace and frame logs go |
| `SIGNATURE_CHECK` | no | `on` | `off` only for local tests without Twilio |
| `RECONNECT_LIMIT` | no | 2 | Reconnect attempts per call before dialing the handoff number |
| `SESSION_TTL_MS` | no | 1800000 | Evict an idle session this long after its last activity |

Startup prints the resolved config with secrets masked and fails with one
line naming the first missing required variable.

## 5. Call flow

1. **Voice webhook.** Twilio POSTs to `https://PUBLIC_HOST/voice`. The server
   validates the signature, mints a call token bound to `CallSid`, and returns:

   ```xml
   <Response>
     <Connect action="https://PUBLIC_HOST/cr-action">
       <ConversationRelay url="wss://PUBLIC_HOST/conversation?token=..."
         transcriptionProvider="Deepgram" speechModel="flux"
         partialPrompts="false" dtmfDetection="true"
         interruptible="any" interruptSensitivity="medium"
         reportInputDuringAgentSpeech="any"
         deepgramSmartFormat="false" hints="..." />
     </Connect>
   </Response>
   ```

   `hints` is built from the provider roster, the intent vocabulary
   ("reschedule", "cancel", "member ID"), and number words.

2. **Socket upgrade.** The WebSocket server accepts the upgrade on
   `/conversation` only; the token is checked when the `setup` message
   arrives and must match the message's `callSid`. A bad or missing token
   sends `end` and closes.

3. **Setup.** The adapter creates a session for the call SID (or resumes one on
   reconnect), opens the trace writer and frame log, and runs the setup turn.
   The greeting decision becomes `text` frames.

4. **Turns.** Each inbound message is appended to the frame log and mapped:
   `prompt` to a `PromptFrame` (with `last` forced to `true` in this
   sub-project), `dtmf` and `interrupt` to their frames, `error` to a logged
   event. The session's queue runs `runTurn` for each, in arrival order, one at
   a time. The decision's outbound frames are sent in order and appended to
   the frame log.

5. **End.** A `complete` decision sends its confirmation `text` then
   `end` with `handoffData` `{"reasonCode":"completed"}`. A `handoff` decision
   sends its text then `end` with the reason. The server then marks the
   session ended and closes the socket after the frames are flushed.

6. **Action callback.** Twilio POSTs to `/cr-action` with `CallSid`,
   `SessionStatus`, `HandoffData`, and the rest. The server validates the
   signature and responds:

   | Condition | TwiML |
   | --- | --- |
   | `HandoffData.reasonCode` is `completed` | `<Hangup/>` |
   | any other reason code | `<Dial>HANDOFF_NUMBER</Dial>` |
   | no `HandoffData`, `CallStatus` in-progress, reconnects below limit | fresh `<Connect><ConversationRelay>` with a new token; the store marks the session as awaiting reconnect |
   | no `HandoffData`, limit reached | `<Say>` a short apology then `<Dial>HANDOFF_NUMBER</Dial>` |
   | anything else | `<Hangup/>` |

   The callback's parameters are appended to the frame log.

## 6. Sessions and the queue

`SessionStore` holds, per call SID: the core `Session`, the `RunOptions`, the
trace writer, the frame logger, the socket (or null while disconnected), the
reconnect count, the token, and a promise chain. `enqueue(callSid, fn)`
chains `fn` onto the tail so turns never overlap; an error in a turn is logged
to the frame log, and the next turn still runs. Sessions are evicted when the
call ends or `SESSION_TTL_MS` (30 minutes) after the last activity.

On reconnect the store returns the existing session; the adapter does not run
a new setup turn but replays the last prompt text as a `text` frame so the
caller hears where they were.

## 7. Signature validation

`validateTwilioSignature(fullUrl, params, header, authToken)` implements
Twilio's scheme: the full request URL (scheme, host, path, query, exactly as
Twilio called it, so `PUBLIC_HOST` must match the ngrok domain), followed by
every POST parameter name and value concatenated in sorted key order, HMAC
SHA-1 with the auth token, base64, compared in constant time to the
`X-Twilio-Signature` header. Tested against Twilio's published example
values. With `SIGNATURE_CHECK=off` the check is skipped and a warning is
printed once at startup.

## 8. Frame log and replay

`traces/<callSid>.frames.jsonl` holds one line per socket message and per
webhook, `{ ts, dir: 'in' | 'out' | 'http', msg }`. `traces/<callSid>.jsonl`
holds the usual trace records. Both are written synchronously per message.

`pnpm cli --replay traces/<callSid>.frames.jsonl` feeds every inbound message
through `runTurn` with the fixture stub (or `--client jev`) and prints the
same per-turn tables as the REPL, then the run summary. Because the server
and the CLI share `runTurn`, a decision that differs on replay points at
either the client (real versus stub) or a code change, never at the adapter.

## 9. Testing

- `src/testing/fakeRelay.ts` opens a real WebSocket to a server started in
  the test on an ephemeral port with `SIGNATURE_CHECK=off`, sends `setup`,
  `prompt`, `dtmf`, and `interrupt` messages, and collects outbound messages.
- Adapter tests, via the fake relay: greeting on setup; the handoff worked
  example end to end with the fixture stub; DTMF member id entry; an
  interrupt then a prompt sets `bargeIn`; a `complete` decision ends with
  `end` and the socket closes; a bad token is refused.
- Queue test: a client whose `ask` resolves after a delay, a prompt then a
  digit sent back to back, asserting the digit is processed after the prompt
  turn and against its resulting session.
- HTTP tests: `/voice` returns the connect TwiML with a token bound to the
  call SID; `/cr-action` returns hangup, dial, reconnect, and give-up TwiML
  for each condition; signature validation rejects a tampered body.
- Signature unit test against Twilio's documented example.
- Reconnect test: drop the socket mid-form, post the action callback, connect
  again with the new token, and continue to completion.
- Replay test: run a recorded frame log from the fake relay through the CLI
  replay and assert the decisions match the live run.
- Manual live-call checklist in the README: start ngrok, set env, point the
  number's voice webhook at `/voice`, call, walk the worked example, press
  keys, say "agent", confirm the transfer, then replay the frame log.

## 10. Operational notes carried into the README

- `CR does not reconnect`; the action-callback reconnect path is the only
  recovery. Verify the call SID matches before resuming.
- Ten consecutive unrecognized outbound messages close the socket (error
  64105). The adapter only ever sends the five documented message types, and
  the fake-relay tests assert every outbound message parses as one of them.
- `deepgramSmartFormat="false"` is deliberate; if Deepgram still returns
  digits for some utterances the normalizer accepts them.
- The public URL in TwiML must match what Twilio calls exactly or signatures
  fail; use the ngrok reserved domain, never a random one.

## 11. Open questions for the first real call

- Whether `speechModel="flux"` is accepted with `partialPrompts="false"`, or
  whether finals-only should use Deepgram's default model.
- Actual end-of-turn latency with `eotThreshold` at its default, before any
  tuning.
- Whether `reportInputDuringAgentSpeech="any"` produces duplicate prompts for
  speech that also triggered an `interrupt`.
- How Twilio TTS reads "4471 8293" and provider names; a `hints` list and
  manifest wording tweak may follow.
