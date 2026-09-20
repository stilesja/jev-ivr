# Design: No-input handling

**Date:** 2026-09-20
**Status:** approved in conversation; implementation plan to follow
**Depends on:** final confirm (2026-09-19, PR #8)

## 1. Scope

A call that goes silent after a prompt currently sits open until the idle sweep: Twilio's ConversationRelay sends nothing on silence, and nothing in the server or the core has a clock. This adds one:

- A **silence event**, synthetic, produced by the server when the caller has said and pressed nothing for a fixed wait after a prompt finished playing.
- The core treats it as an **unanswered turn** on whatever was prompted, re-asking with a short prefix ("I didn't hear anything.") and counting it on the existing ladders, so three silences reach an agent the same way three unintelligible answers do.
- One wait everywhere, seven seconds after playback, configurable.

Out of scope: a separate "are you still there?" turn; per-prompt waits; Twilio-side speech timing attributes; hanging up on silence (the ladders already end in a handoff).

Framework note: the silence event, the timer, and the playback estimate are general mechanisms, not demo content. The prompt text is content.

## 2. The event

`src/channel/frames.ts` gains

```ts
export interface SilenceFrame { type: 'silence' }
```

in `InboundFrame`. It is never parsed off the wire: `parseInbound` keeps rejecting it, and `wire.ts` documents that it is server-generated. `promptFrame`/`dtmfFrames` get a sibling `silenceFrame()`.

## 3. Core handling

`plan()` returns `needsModel: false` for a silence event; `resolve()` handles it without answers:

| prompted | decision |
| --- | --- |
| a form confirmation pending (the summary, `ask_change`, or `confirm_dtmf`) | `reaskConfirmation` with the `no_input` ack: re-ask the summary, then `confirm_dtmf`, then handoff `max-attempts` |
| an intent or slot confirmation pending | `reaskConfirmation` with the ack, as today for an unanswered turn |
| `promptedFor` an intent | `failAttempt('intent')` with the ack: `nomatch_open`, then the keypad menu, then handoff |
| `promptedFor` a slot | `failAttempt(slot)` with the ack: retry, then keypad, then handoff |
| the call has ended, or `promptedFor` is null | ignore |

The ack is `{ promptId: 'no_input', vars: {} }` in front of whatever the ladder produces, including a handoff (the handoff prompt then follows the ack, as acks already do for handoffs). The ack is kept when the ladder step is itself a handoff: "I didn't hear anything. Let me get someone to help you." reads correctly.

`bookkeep` records the turn as usual (`history` entry with intent `silence`, `turnIndex` increments), so the model's next turn sees the attempt bucket move. `lastInterrupt` is cleared. The DTMF buffer is cleared (a half-typed member ID is abandoned by silence).

Trace: the turn record's `source` is `silence` so replay and summaries can tell it from a model turn; the regress outcome fields are unchanged.

## 4. The timer

In the server adapter, after `sendFrames` for a `prompt` decision:

```
arm(callSid, NO_INPUT_MS + playbackEstimateMs(frames))
```

- **Estimate.** `playbackEstimateMs(frames)` sums, per outbound frame: a `play` frame's clip duration, read once at startup from the WAV header (`data` size / byte rate; mp3 falls back to the text estimate of its recording text); a `text` frame's `words / 2.5` seconds. Exposed from the clip index (`discoverClips` returns durations alongside filenames, or a sibling `clipDurations(dir)`), so the same helper serves anything else that needs to know how long a prompt plays.
- **Clear** on any inbound `prompt` (final or partial), `dtmf`, or `interrupt`; on a `setup` (reconnect); and on `end` (complete/handoff never arm, and clear any pending timer).
- **Fire.** `store.enqueue(callSid, (e) => turn(deps, e, silenceFrame()))`, the same per-call queue as socket messages, so a silence turn cannot interleave with a real one. Each arm increments a per-call generation counter and the queued closure carries the generation it was armed with; when it runs it does nothing unless the generation is still current and the call has not ended. That covers the race where the caller speaks just as the timer fires: the real turn clears the timer (bumping the generation), and the already-queued silence turn is a no-op when its turn comes.
- **Re-arm** after the silence turn's own prompt, so the ladder advances on its own; it stops arming when the decision is a handoff.
- Timers are `unref`'d and keyed by call; `handleSocketClose` clears them. `NO_INPUT_MS` from config, default 7000, `0` disables.

Playback estimates are approximate by design: the wait is measured from the end of the estimate, and a wrong estimate moves the wait by a second or two, not by the length of the prompt.

## 5. Prompt

`no_input`: "I didn't hear anything." (`interruptible: false`, recordable, tag `[calm]`). Spoken as an ack ahead of the re-asked prompt.

## 6. Harness

- Scenario steps: `{ "silence": true }` runs one silence turn.
- Text REPL: `/silence` (and an empty line) runs one.
- Scenarios: silence at the greeting once (re-ask with the prefix), twice (keypad menu), three times (agent); silence at the member-ID prompt then an answer resumes normally; silence at the summary once (re-ask) and three times (agent); silence during `confirm_dtmf` then keypad 1 completes.
- The label baseline is re-recorded for the new scenarios; the cassette is untouched (no model call on a silence turn; no question changes).

## 7. Config and docs

`NO_INPUT_MS` in `ServerConfig` and `.env.example` (default 7000). README: a paragraph under the phone-line section, and a live-call step: stay quiet after the greeting and after the summary; expect "I didn't hear anything." then the question again, then the keypad offer, then the transfer.

## 8. Tests

- Core: each row of the §3 table, the ack placement, the ended/null cases, history bookkeeping, DTMF buffer cleared.
- Clip durations: WAV header parse on a synthetic file; the text estimate; `playbackEstimateMs` over a mixed frame list.
- Adapter, with fake timers: arms after a prompt with the estimate added; each inbound kind clears it; never arms after complete/handoff; fires into the per-call queue; does nothing if a turn is in flight or the call ended; re-arms after the silence turn's prompt; `NO_INPUT_MS=0` disables.
- Server end to end with a short timer: setup, no speech, the re-ask arrives with the prefix.
- Harness: the silence step and the REPL command.
