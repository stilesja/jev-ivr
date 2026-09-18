# Jev IVR Demo — Project Handoff

Handoff brief for a Claude Code session. Read this first, then fetch the Jev docs
(see §2) before writing any Jev-touching code.

---

## 0. Status and constraint

**No Jev API key yet — on the early-access waitlist.**

This is the single most important planning constraint. Everything must be built
against a `JevClient` *interface* with a deterministic stub implementation, so
that day one with a real key is a one-line swap and a fixture re-record, not a
refactor.

Corollary: **do not** design anything that requires observing real Jev behavior
to make progress. Where a decision depends on real model output (threshold
values, calibration curves), stub it with a named constant, add it to §10, and
move on.

---

## 1. What this is

A **personal portfolio project**. Not production, not affiliated with any
employer's systems, no real customer data. The deliverable is a working demo
plus a writeup.

**The thesis being demonstrated:**

LLM-based conversational agents are expensive and usually overkill for IVR.
Legacy DTMF phone trees are cheap but make callers jump through hoops. A fast,
calibrated, *non-generative* decision model lets you build a mixed-initiative
voice front end — caller says one thing, several slots get filled, a
deterministic loop prompts only for what's missing — at a cost per decision
that rounds to zero.

This is essentially the VoiceXML Form Interpretation Algorithm (slots + loop
until complete), which the industry abandoned because NLU of the era couldn't
carry mixed initiative. The pattern is old. What's new is a decision layer good
enough and cheap enough to make it work.

**Demo headline metrics** (instrument these; they are the point):

| Metric | Why |
| --- | --- |
| Slots filled per utterance | The mixed-initiative claim |
| Turns to completion vs. DTMF baseline | The AHT/business claim |
| % of turns where fetch audio became audible, and for how long | The latency claim |
| Decision latency p50/p95, cost per call | The economics claim |

---

## 2. Jev: what it is and how to call it

Not an LLM. No text generation. You send **state** plus **typed questions**;
you get typed answers with probability distributions. Cannot produce
out-of-schema output.

**Before writing Jev code, fetch `https://docs.typesafe.ai/llms.txt`** — it is
the documentation index and will list all pages. Read at minimum:
`/introduction/quickstart`, `/primitives`, `/confidence`, `/patterns`.

### Primitives

| Type | Goal | Returns |
| --- | --- | --- |
| **Choice** | Choose an option from a list | `choice`, `probabilities`, `confidence` |
| **Score** | Score the state on a rubric | `score`, `probabilities`, `confidence` |
| **Noul** | Is this statement true? | `noul` (0–1) |

All three mix in a single call. Every question is evaluated **in parallel and
in isolation** against the same state. Adding questions barely changes response
time, and because each is evaluated independently there is no context rot. This
is why the turn schema in §5 is large — it costs almost nothing.

Note: Noul returns a bare 0–1 value, **no confidence field**. Only Choice and
Score carry confidence. The gate ladder in §6 must not assume otherwise.

Choice cardinality is capped at **255**. Above that, TypeSafe use a two-stage
score-then-choose pattern. Our intent sets are well under this.

### Design rule from the docs (follow it)

> Each question should ask one specific, well-scoped thing — the kind of
> judgment a knowledgeable person makes in a few seconds. If a question needs
> extended reasoning or weighs multiple independent factors, decompose it and
> combine the results in code.

Concretely: never ask "should we route this to an agent?" Ask about
frustration, explicit human request, retry count and intent separately, then
combine with a rule you can read and change.

### Known API surface

Vercel AI SDK provider (likely the easiest path for a TS project):

```bash
pnpm add @ai-sdk/typesafe-ai
# env: TYPESAFE_AI_API_KEY
# baseURL defaults to https://api.typesafe.ai/v1
```

```ts
import { typeSafeAi } from '@ai-sdk/typesafe-ai';
import { experimental_evaluate } from 'ai';

const result = await experimental_evaluate({
  model: typeSafeAi.evaluationModel('jev-latest'),
  state: { message: 'I was charged twice. Please refund the duplicate.' },
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: {
        billing:   { includes: ['Charges', 'Invoices', 'Refunds'] },
        technical: ['Bugs', 'Outages'],
        other:     null,
      },
    },
    severity: {
      type: 'score',
      instructions: 'How severe is the issue?',
      criteria: ['Cosmetic', 'Workaround exists', 'Blocking; no workaround'],
    },
    requestsRefund: {
      type: 'boolean',
      instructions: 'Is the customer requesting money back?',
    },
  },
});

result.answers.department.choice;
result.answers.severity.score;
result.answers.requestsRefund.probability;
```

Unverified / confirm against the real docs:

- The AI SDK calls the third type `boolean`; TypeSafe's own docs call it
  `Noul`. Presumably the same primitive. Confirm the field name on the result
  (`.probability` vs `.noul`).
- Whether to use the AI SDK wrapper or hit the REST API directly. Direct may be
  better for latency measurement and for accessing the full probability
  distribution rather than just the top choice. **We need full distributions**
  for the margin gate (§6) — verify the wrapper exposes `probabilities`.
- Timeout, retry, and 429/529 `Retry-After` behavior.
- Whether `state` is arbitrary JSON or has structural constraints.

---

## 3. Architecture

Three layers. Build in this order. Each is independently valuable.

```
┌─────────────────────────────────────────────────────┐
│ L1  TEXT HARNESS        no audio, no sockets        │  ← build first, keep forever
│     transcript + state → decision + trace           │
├─────────────────────────────────────────────────────┤
│ L2  BROWSER HARNESS     mic + speakers, local       │  ← optional
│     speaks the CR frame protocol (§4)               │
├─────────────────────────────────────────────────────┤
│ L3  TWILIO              real phone line             │  ← get here early
│     ConversationRelay over WebSocket                │
└─────────────────────────────────────────────────────┘
```

**The core is a pure function**: `(state, event) → decision + outbound frames`.
It never knows which layer it's running under.

**Critical decision: the Twilio ConversationRelay message protocol IS our
internal protocol.** Do not invent a nicer abstraction and adapt it to Twilio
later. The browser harness implements the CR frames; the Twilio adapter is
close to a pass-through. This means frame logs captured from real calls replay
through the local harness, which is the only practical way to debug a phone
call you can't step through.

Do **not** treat L2 as a faithful simulation of L3. Endpointing, acoustic
barge-in over 8 kHz telephony audio, and DTMF do not emulate honestly. L2
proves the decision loop and the audio orchestration timing; L3 is the only
place the telephony semantics are real. Expect to retune thresholds at each
boundary (clean text → ASR errors → telephony).

### Repo shape (suggested)

```
/core          state assembly, question set, gate ladder, FIA loop, extraction tiers
/jev           JevClient interface + stub + real impl + fixtures
/channel       CR frame types; browser adapter; twilio adapter
/prompts       prompt manifest + audio assets
/harness-text  L1 CLI + fixture runner
/harness-web   L2 browser harness + debug panel
/server        L3 twilio webhook + wss server
/traces        JSONL call traces
/fixtures      utterance corpora + expected decisions
```

---

## 4. Channel protocol (Twilio ConversationRelay frames)

Verified against Twilio docs. **Inbound** (platform → us):

```jsonc
{ "type": "setup",   "sessionId": "...", "callSid": "...", "from": "...", "to": "...",
  "customParameters": { } }
{ "type": "prompt",  "voicePrompt": "...", "lang": "en-US", "last": true }
{ "type": "dtmf",    "digit": "1" }
{ "type": "interrupt", "utteranceUntilInterrupt": "...", "durationUntilInterruptMs": 460 }
{ "type": "error",   "description": "..." }
```

**Outbound** (us → platform):

```jsonc
{ "type": "text", "token": "...", "last": false, "lang": "en-US",
  "interruptible": false, "preemptible": false }
{ "type": "play", "source": "https://.../prompt.wav", "loop": 1,
  "preemptible": false, "interruptible": true }
{ "type": "sendDigits", "digits": "9www4085551212" }
{ "type": "language", "ttsLanguage": "sv-SE", "transcriptionLanguage": "en-US" }
{ "type": "end", "handoffData": "{\"reasonCode\":\"live-agent-handoff\"}" }
```

### Things that matter about this protocol

- **`preemptible: true`** means a subsequent `text` or `play` stops the current
  playback. This is the fetch-audio mechanism (§8).
- **`loop: 0`** plays media 1,000 times — effectively "loop until preempted."
  The right knob for a fetch-audio loop.
- **`interruptible`** is settable per message, overriding the TwiML default.
  Barge-in on menu prompts, no barge-in on confirmations.
- **`end` + `handoffData`** is the agent-transfer path. CR ends, control returns
  to Twilio, the `<Connect action=...>` callback receives the JSON-encoded
  string, and we return `<Dial>` TwiML. Docs warn: no PCI data in `handoffData`.
- **The `prompt` frame carries a single transcript string.** No n-best, no
  alternates, no word-level confidence. This constrains the schema — see §5.

### Critical limitation

There is **no ASR n-best on this platform.** An earlier design fed alternate
hypotheses into Jev for arbitration; that is not possible under CR. If n-best
is ever required, the escape hatch is dropping to `<Connect><Stream>` Media
Streams with our own Deepgram connection — which costs us TTS orchestration,
barge-in, DTMF and the `play`/`preemptible` semantics. Not worth it for this
demo. Design for a single transcript and say so in the writeup.

---

## 5. The turn schema

State in (arbitrary JSON, structured program state — this is what Jev is built
for, as opposed to a message history):

```ts
interface TurnState {
  node:    { id: string; promptJustPlayed: string; options: string[] };
  turn:    { index: number; retryCount: number; sinceCallStartMs: number };
  slots:   Record<string, { value: string | null; confirmed: boolean }>;
  history: Array<{ node: string; intent: string; confidence: number; outcome: string }>;
  caller:  { verified: boolean; openRepair: boolean; openOrder: boolean;
             priorCalls7d: number; entitlement: string };   // from data dip
  asr:     { text: string; isPartial: boolean; bargeIn: boolean; dtmf: string | null };
  candidateSpans: string[];   // n-grams of asr.text, for span selection
}
```

Questions out — **one call, all parallel**:

```
ROUTING
  intent            Choice  [repair_status, order_status, billing, tech_support,
                             agent, repeat_prompt, other, none]
  intentSecondary   Choice  same set        // "check my order and also billing"

CONTROL  (Noul — 0-1, no confidence field)
  addressedToSystem       // vs. side speech, TV, talking to someone else
  utteranceComplete       // finished the thought vs. trailing off
  wantsHuman
  rephrasingLastTurn      // signal our last turn failed
  confusedByPrompt
  spokeAMenuNumber        // said "one" meaning press 1

CALLER STATE
  frustration    Score  [none, mild, high]
  urgency        Score  [low, normal, high]
  triedSelfService  Noul
  languageSwitch    Choice [none, es, fr, ...]

SLOTS — detect + localize  (one pair per slot type in the active form)
  contains<Slot>    Noul    // did they supply an order ID / date / member ID ...
  <slot>Span        Choice over candidateSpans
  <slot>Complete    Noul    // whole value vs. trailed off

GUARD
  intelligible      Noul    // ASR mush detector
```

Do not collapse these into fewer, cleverer questions. The docs are explicit
that atomic questions are the intended use, and parallelism makes width nearly
free.

---

## 6. Gate ladder

Evaluated in order; first failure wins. **All threshold values below are
placeholders** to be tuned against real fixtures once the key arrives.

| Gate | Threshold | On fail |
| --- | --- | --- |
| `addressedToSystem` | 0.70 | ignore, keep listening, emit nothing |
| `intelligible` | 0.50 | no-match reprompt |
| `utteranceComplete` | 0.60 | hold, wait for more speech |
| `wantsHuman` | 0.70 | → **agent**, overrides everything below |
| `intent` top-1 | ≥ 0.85 | route silently |
| | 0.60–0.85 | route with implicit confirm |
| | 0.40–0.60 | explicit confirm, or disambiguate top-2 |
| | < 0.40 | reprompt; agent on second failure |
| `intent` margin (top1 − top2) | ≥ 0.15 | disambiguate even if top-1 is high |
| `frustration = high` AND `retryCount ≥ 1` | | → agent |

**The margin gate requires the full probability distribution, not just the top
choice.** A 0.88/0.86 split is a worse situation than a 0.62 top-1, and argmax
hides it. Verify the client exposes `probabilities` (§2).

Every gate evaluation must be written to the trace with value, threshold, and
outcome. The debug panel renders this table live; it is the demo's visual
centerpiece, because *seeing the decision resolve* is the thing an LLM cannot
offer.

---

## 7. Slot filling (the FIA loop)

This is the demo's actual payload.

```
form = { intent, memberId, provider, timeframe }

on each utterance:
  run the turn schema
  for each slot where contains<Slot> > θ and <slot>Complete > θ:
      extract (§9) and fill
  if all required slots filled → exit, execute
  else → prompt directly for the highest-priority empty slot
```

Worked example to target in the demo:

> **Caller:** "I need to reschedule my appointment, it's with Dr. Chen sometime next week"
> → `intent=reschedule (0.94)`, `provider=Chen (0.91)`, `timeframe=next_week (0.88)`, `memberId=∅`
> **System:** "Sure, rescheduling with Dr. Chen. What's your member ID?"

Prompts for the directed sub-dialog must be written to accept over-answering
(the caller may supply more than was asked), which means the full schema runs
on every turn, not a reduced one. That's affordable here and is exactly why
this pattern failed with older NLU.

Also implement a DTMF fallback for every slot. Any credible IVR has one, and
its absence is conspicuous.

---

## 8. Prompt and fetch-audio orchestration

**Distinction that matters:** a spoken prompt is a complete utterance and must
not be cut mid-word — it plays through. *Fetch audio* (the "beep-boop-dip-dop"
thinking sounds) is designed to be cut at an arbitrary point. Only fetch audio
is `preemptible`.

Three-message sequence for a dip:

```jsonc
{ "type": "play", "source": ".../bridge_one_moment.wav",
  "preemptible": false, "interruptible": false }
{ "type": "play", "source": ".../fetch_loop.wav",
  "loop": 0, "preemptible": true, "interruptible": false }
// dip returns →
{ "type": "play", "source": ".../repair_status_found.wav", "preemptible": false }
```

Ordering falls out for free: if the dip returns while the bridge is still
playing, the result prompt queues behind it and the fetch loop never becomes
audible. If the dip runs long, the caller hears bridge → fetch → result with no
seam. Same code path either way.

Add an escalation tier: if the dip exceeds a threshold, preempt the fetch loop
with a reassurance prompt and resume the loop; hard timeout drops to DTMF
collection or agent.

**Instrument fetch-audio audibility.** With Jev deciding in ~300 ms, routing
turns should essentially never reach audible fetch audio — it should only
surface on tier-3 extraction and real backend dips. That number *is* the
latency argument.

Use recorded prompt assets from a `prompts.json` manifest, not TTS. More
authentic to IVR practice and a better demonstration of craft. Generate the
assets once with a TTS vendor, then serve as static files.

---

## 9. Extraction tiers

Jev returns typed choices, not strings, so arbitrary values (member IDs, case
numbers, dates) need a pipeline:

1. **Detect** — `contains<Slot>` Noul. Free, same call as everything else.
2. **Localize** — `<slot>Span` Choice over candidate spans. Still Jev, still
   the same call. Span *selection* is a bounded typed choice, so it fits the
   model natively.
3. **Normalize** — the only tier needing something else:
   - **3a. Deterministic** (try first): spoken-number→digits, NATO alphabet,
     date parsing, mask validation, checksum. Handles most IVR slot types
     outright.
   - **3b. Fast LLM** (fallback): only sees a short span plus a target format,
     which is a far easier task than "extract the entity." Hard 400 ms budget,
     fallback to DTMF collection.

Contract between 2 and 3:

```ts
interface ExtractionRequest {
  slotType: string;          // "memberId"
  spanText: string;          // "eight four seven alpha dash two"
  fullTranscript: string;    // context
  expectedMask: string;      // "^\\d{3}[A-Z]-\\d$"
  attempt: number;
}
interface ExtractionResult {
  value: string;             // "847A-2"
  confidence: number;
  needsConfirmation: boolean;
}
```

**Watch out:** Twilio's `deepgramSmartFormat` defaults to `true` and reformats
numbers, dates, currency and addresses into conventional written forms *before
we see them*. So spans may arrive as `847` rather than "eight four seven."
Decide deliberately whether to disable it (to get raw spoken form for our own
normalizer) rather than inheriting the default. This affects mask design.

All of tier 3 runs **under the bridge prompt** as a data dip. It is never on
the critical path.

---

## 10. Twilio configuration (L3)

```xml
<Response>
  <Connect action="https://.../cr-action">
    <ConversationRelay
      url="wss://.../conversation"
      transcriptionProvider="Deepgram"
      speechModel="flux"
      partialPrompts="true"
      eotThreshold="0.8"
      dtmfDetection="true"
      interruptible="any"
      interruptSensitivity="medium"
      reportInputDuringAgentSpeech="true"
      deepgramSmartFormat="false"
      hints="..." />
  </Connect>
</Response>
```

Key attributes:

- **`partialPrompts`** — defaults to `false`. Off = one `prompt` per utterance
  with `last:true` (final only). On = unfinalized prompts with `last:false`
  plus eager end-of-turn events. **Only applies with Deepgram + `flux`.** Wrong
  model = silently no partials.
- **`eotThreshold`** (0.5–0.9) — confidence required to end a turn. Interacts
  with our `utteranceComplete` gate; tune one at a time.
- **`speechTimeout`** — forwarded to Deepgram as max silence duration, forcing
  end-of-turn regardless of confidence. Safety net.
- **`hints`** — domain vocabulary, product names, slot formats.

**Build the finals-only path first, then flip `partialPrompts` and measure the
delta.** That delta is a chart for the writeup. With partials on, the loop is:
debounce ~150 ms, one Jev call per update, cancel in-flight on newer partial —
by the time `last:true` arrives the decision already exists, so effective
decision latency approaches zero.

Verify on the first real call whether partial `voicePrompt` is **cumulative**
or a fragment. Docs read cumulative; log raw frames and confirm before building
cancellation logic on the assumption.

Operational:

- Validate the `X-Twilio-Signature` header on every inbound message.
- **CR does not reconnect.** If the WebSocket drops the call fails. Handle in
  the `<Connect action>` callback by returning fresh
  `<Connect><ConversationRelay>` TwiML and checking `callSid` matches.
- Ten consecutive malformed outbound messages closes the connection
  (error 64105). You will hit this in development.
- Error codes: 64101–64112. 64107 = invalid message (non-fatal), 64109 =
  concurrency limit.
- ngrok (reserved static domain) for local `wss://`.

---

## 11. Build order

**Phase 0 — scaffolding, no key needed**
1. Repo, TS, types for CR frames and `TurnState`.
2. `JevClient` interface. Stub implementation returning deterministic
   distributions from a lookup table keyed on utterance.
3. Fixture corpus: 100–200 utterances across the target flow with expected
   intent and slots, hand-labeled.

**Phase 1 — L1 text harness, no key needed**
4. State assembly, question-set builder, gate ladder, FIA loop.
5. CLI: type an utterance (or run the fixture file), print the probability
   table and gate resolution.
6. JSONL trace writer. Trace format is frozen here and used by all three layers.
7. Fixture runner as regression suite: change a threshold, diff outcomes.

**Phase 2 — real Jev, on key arrival**
8. Swap stub → real client. Record fixture responses.
9. Tune thresholds against the corpus. Build the calibration curve (bucket by
   reported confidence, measure actual accuracy). **This is the first real test
   of the calibration claim and cannot be done by talking into a microphone.**
10. Tighten question wording where confidence is poorly separated.

**Phase 3 — L3 Twilio** *(consider doing before Phase 2 if the key is slow)*
11. Number, ngrok, webhook, wss server, `setup`/`prompt`/`end` round trip.
12. Prompt manifest and audio assets; bridge/fetch/result orchestration.
13. DTMF fallback, agent handoff via `end` + `handoffData` + `<Dial>`.
14. Finals-only first; then `partialPrompts` + cancellation; measure delta.

**Phase 4 — L2 browser harness** *(optional, lowest priority)*
15. Only if the debug panel needs to be on-screen during a live demo. If built,
    it must implement the CR frame protocol faithfully — play queue with real
    preemption and `loop:0` semantics, `prompt` frames with `last:false/true`,
    a keypad widget emitting `dtmf` frames.
16. Alternative that is arguably the better demo video: skip L2, put the debug
    panel on a second screen, and call the Twilio number from a cell phone.

**Throughout:** the debug panel (gates, values, thresholds, full probability
table, per-call timings, running cost) is the portfolio artifact. Prioritize it
over polish elsewhere.

---

## 12. Open questions

Resolve against the real docs or first real call; do not guess.

- [ ] Does the client expose full `probabilities`, or only the top choice? The
      margin gate depends on it.
- [ ] AI SDK wrapper vs. direct REST — which gives better latency visibility?
- [ ] Noul result field name (`.noul` vs `.probability`).
- [ ] Jev timeout / retry / 429 semantics; what to do on a slow call mid-turn.
- [ ] Measured p50/p95 latency from our own region, not TypeSafe's laptops.
- [ ] Is partial `voicePrompt` cumulative or fragmentary?
- [ ] Does `deepgramSmartFormat=false` degrade anything else we want?
- [ ] Every threshold in §6 is a placeholder.

## 13. Non-goals

- Not production. No real customer data, no employer systems, no PII.
- Not a general agent. Deterministic flow, pre-approved prompts, no free-form
  generation reaching a caller. That constraint is the *point*, not a shortcut.
- Not multi-language for v1 (schema leaves room via `languageSwitch`).
- Not an n-best/ASR-arbitration project (see §4).
- Not a Jev bet. The IP is the pattern — state schema, question set, gate
  ladder, extraction tiers, audio orchestration. It needs *a* fast calibrated
  classifier. Keep `JevClient` clean enough that another one could be dropped in.
