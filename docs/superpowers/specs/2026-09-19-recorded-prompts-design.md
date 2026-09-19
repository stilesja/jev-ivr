# Design: Recorded prompts (Phase 3b, part one)

Date: 2026-09-19
Status: approved for planning; scope addition during planning: clip generation through the Fish Audio API from the recording sheet (`pnpm prompts:generate`), since generating eighty clips by hand in the web app is the bottleneck
Parent: `JEV-IVR-HANDOFF.md` §8 and Phase 3 item 12; builds on
`2026-09-18-twilio-phone-line-design.md` (frames, adapter, server) and
`2026-09-19-question-redesign-design.md` (the current prompt set).
Fetch-audio orchestration and the audibility metric are the next
sub-project.

## 1. Scope

Prompts are spoken today by Twilio's TTS from the manifest text. This
sub-project plays recorded clips instead wherever a clip exists, keeps TTS
for anything unrecorded, and gives Jason a recording sheet of exactly what
to generate. Templated prompts are split at their variables into segments;
fixed segments and the small closed vocabularies (provider names, intent
labels, date windows) are clips, and member IDs and dates stay TTS.

Out of scope: fetch audio and the audibility metric; clips for digits,
weekdays, months or day numbers; any change to which prompt is chosen or
what it means; the text harness's output (it keeps printing text).

## 2. Segments

`src/prompts/segments.ts` exports `segmentTemplate(promptId, template)`,
splitting a manifest template into an ordered list of:

- `{ kind: 'fixed', id: '<promptId>.<n>', text }` for each literal run
  (n counts from 0, whitespace trimmed, empty runs dropped), and
- `{ kind: 'var', name }` for each `{name}`.

Variable slots are of two kinds, decided by name:

| Variable | Kind | Clip id when a clip is possible |
| --- | --- | --- |
| `provider`, `a`, `b` (provider values) | vocabulary | `provider.<key>` (roster key) |
| `intentLabel`, `a`, `b` (intent labels) | vocabulary | `intent.<intent>` |
| `window` | vocabulary | `window.<label>` |
| `memberId`, `date` | spoken | always TTS |

`a`/`b` carry a display string at render time; the renderer maps a display
string back to its clip id through the provider roster and the intent
label table, and treats an unmapped value as spoken. `window` values are
the labels `describeWindow` produces (`next week`, `this week`,
`this month`, and any others the date code emits); the clip id is the label
with spaces replaced by underscores.

## 3. Manifest rewrite for clause boundaries

The seam that matters is between a clip and a TTS span: a synthetic voice
inside a recorded sentence is audible. So the invariant is: a **spoken**
variable (`memberId`, `date`) must be followed by a pause (comma, period,
or question mark) or be the last thing in the prompt, and preceded by a
fixed segment that ends at a natural pause or be the first thing. A
**vocabulary** variable (`provider`, `intentLabel`, `window`, `a`, `b`) may
sit mid-sentence, because both its neighbours are clips; the segment before
it is recorded with an open intonation (§7).

One template changes:

- `date_narrow_window`: "Which day {window} works for you?" becomes
  "{window}. Which day works for you?" (the window clip opens the prompt,
  so the fixed clip that follows is a complete question).

Every other templated prompt satisfies the invariant: the completion lines
put `{date}` and `{memberId}` before commas or periods, and the acks and
confirmations end their sentence at the spoken variable. The `text` field
remains the single source of truth for the harness, `spokenText`, and TTS;
the manifest's unused `audio` field is removed from `PromptEntry`.

## 4. Clips and discovery

Clips live in `assets/audio/` (committed; a demo has a few dozen) named
`<clipId>.<ext>` with `ext` one of `wav`, `mp3`. `src/prompts/clips.ts`
exports `discoverClips(dir): Map<clipId, filename>` (case-sensitive ids;
a duplicate id with two extensions is an error naming both) and
`clipIds(manifest): string[]` listing every recordable id: every fixed
segment id across the manifest plus every vocabulary id (all roster
providers, all form intents' labels plus `agent`, and the window labels).

A clip's URL is `https://<PUBLIC_HOST>/audio/<filename>`.

## 5. Rendering

`decisionToFrames` (render.ts) takes a `RenderContext`:

```
{ clips: Map<string, string> | null; audioBase: string | null }
```

With `clips` null (the text harness, tests without audio) it renders
exactly as today. With clips, each prompt renders to a frame sequence:

1. Split the template into segments (§2) and substitute vars.
2. Walk the segments: a fixed segment whose id has a clip, or a vocabulary
   var whose clip id has a clip, becomes a `play` frame
   `{ type: 'play', source: audioBase + filename, loop: 1, preemptible: false, interruptible }`;
   everything else is text.
3. Consecutive text pieces merge into one `text` frame (joined with a
   single space) so TTS keeps its prosody across a seam-free run.
4. `interruptible` on every frame is the prompt's manifest flag; the `end`
   frame and `goodbye` behave as today.

Acks, completion lines, and handoff prompts go through the same path, so a
chained completion is a run of play frames. `spokenText`,
`lastPromptText`, and the trace are unchanged: the session and the model
still see the text.

## 6. Serving

The server gains `GET /audio/<filename>`: only filenames matching
`^[A-Za-z0-9._-]+\.(wav|mp3)$` are served (no path traversal), from
`AUDIO_DIR` (env, default `assets/audio`), with `content-type`
`audio/wav` or `audio/mpeg`, `cache-control: public, max-age=86400`, and
`HEAD` support; anything else is 404. It needs no Twilio signature (Twilio's
media fetcher does not sign). At startup the server discovers clips and logs
coverage: `audio: 41 of 63 clips present (22 segments fall back to TTS)`,
listing missing ids at debug level. The adapter passes
`{ clips, audioBase: 'https://<PUBLIC_HOST>/audio/' }` to the renderer.

## 7. Recording sheet and check

`pnpm prompts:sheet` prints one line per recordable clip id, tab-separated:
id, the exact text to record (with the template's punctuation at the
segment's end), and a note: `open` when the segment precedes a variable
(record without falling intonation), `closed` otherwise; vocabulary ids
print the display text ("Dr. Chen", "cancel an appointment", "next week").
`pnpm prompts:check` prints the coverage line from §6 and the missing ids,
exit code 1 when any clip is missing. Both read the manifest and
`AUDIO_DIR` only.

Recommendation recorded in the README: generate clips with the same voice
Twilio's ConversationRelay uses for TTS (the `ttsProvider`/`voice` in the
TwiML) so the seams between clips and TTS spans are inaudible.

## 8. Testing

- `segments.test.ts`: splitting with leading/trailing/adjacent variables,
  ids, and the §3 invariant checked over the whole manifest (every spoken
  var is followed by a fixed segment starting with punctuation or is last,
  and preceded by one ending at a pause or is first).
- `clips.test.ts`: discovery from a temp dir, duplicate-extension error,
  `clipIds` count and membership.
- `render.test.ts`: full coverage renders all-play; zero coverage renders
  as today (byte-identical frames); partial coverage merges adjacent text;
  `memberId`/`date` always text; `a`/`b` mapping for providers and intents;
  `interruptible` propagated.
- `http.test.ts`/`server.test.ts`: the audio route serves a temp clip with
  the right headers, rejects traversal and unknown extensions, and a call
  through the fake relay receives `play` frames for the greeting when its
  clip exists.
- `sheet.test.ts`: the sheet lists every id once with open/closed notes;
  `check` exit codes.
- Manual: generate a handful of clips, `pnpm prompts:check`, `pnpm serve`,
  and one live call hears the recorded greeting.

## 9. README

Phone-line section gains "Recorded prompts": where clips live, the naming,
the sheet and check commands, coverage at startup, the TTS fallback, and
the voice recommendation.
