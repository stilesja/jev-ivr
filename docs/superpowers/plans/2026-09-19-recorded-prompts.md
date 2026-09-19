# Recorded Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Play recorded clips for every prompt segment that has one, keep TTS for the rest, and give Jason a recording sheet of exactly what to generate.

**Architecture:** A pure segmenter splits manifest templates at their variables; a clip index is discovered from filenames under `assets/audio/`; the renderer emits `play` frames for segments with clips and merged `text` frames otherwise, driven by an optional `RenderContext` threaded through `RunOptions` so the server renders audio and the text harness stays text-only; the server serves `/audio/<file>` and logs coverage at startup; a small CLI prints the sheet and checks coverage.

**Tech Stack:** TypeScript strict ESM, pnpm, vitest, `node:http`, `node:fs`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-19-recorded-prompts-design.md`. Read it first. The plan wins on small conflicts; each is marked "Deviation:".

**Conventions for every task:**

- Tests colocated as `*.test.ts`; run one with `pnpm vitest run <path>`, all with `pnpm test`; typecheck with `pnpm typecheck`.
- Extensionless imports; strict TS; `noUncheckedIndexedAccess` is on.
- Commit after every task with the message shown, one task per commit, exactly one writer at a time; every commit message ends with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never set, read, or print `TYPESAFE_API_KEY`; never run `--client jev` or `--client record`.
- Temp files in tests go under `mkdtempSync(join(tmpdir(), 'audio-'))` and are removed in `afterEach`.
- `src/core` changes only in Task 4 (threading a context; no decision logic).

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/prompts/segments.ts` | `segmentTemplate`, `segmentsOf`, `seamViolations`, `SPOKEN_VARS` |
| `src/prompts/clips.ts` | `discoverClips`, `vocabularyClipId`, `recordableClips`, `AUDIO_TYPES` |
| `src/prompts/render.ts` | `RenderContext`, `decisionToFrames(decision, ctx?)`, `promptFrames` |
| `src/prompts/manifest.json` | one template rewrite (`date_narrow_window`) |
| `src/prompts/sheet.ts` | `pnpm prompts:sheet`, `pnpm prompts:check` |
| `src/run/turn.ts`, `src/core/turn.ts` | `render` on `RunOptions` and `TurnContext`, passed to `decisionToFrames` |
| `src/server/config.ts` | `audioDir`, `ttsProvider`, `ttsVoice` |
| `src/server/http.ts` | `GET/HEAD /audio/<file>` |
| `src/server/twiml.ts` | optional `ttsProvider`/`voice` attributes |
| `src/server/index.ts` | clip discovery, coverage log, `render` in run options |
| `src/prompts/generate.ts`, `src/prompts/tags.json` | `pnpm prompts:generate`: Fish Audio TTS from the sheet, candidates, per-clip tags |
| `assets/audio/.gitkeep`, `README.md`, `.env.example` | assets dir, docs, env |

---

### Task 1: Segments and the one template rewrite

**Files:**
- Create: `src/prompts/segments.ts`, `src/prompts/segments.test.ts`
- Modify: `src/prompts/manifest.json`, `src/server/adapter.test.ts`, `src/server/server.test.ts` (the pinned window prompt text)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import manifest from './manifest.json';
import { seamViolations, segmentTemplate, segmentsOf, SPOKEN_VARS } from './segments';

describe('segmentTemplate', () => {
  it('splits fixed runs and variables in order, numbering fixed segments', () => {
    expect(segmentTemplate('p', 'With {provider}.')).toEqual([
      { kind: 'fixed', id: 'p.0', text: 'With' },
      { kind: 'var', name: 'provider' },
      { kind: 'fixed', id: 'p.1', text: '.' },
    ]);
  });
  it('handles leading, trailing, and adjacent variables and drops empty runs', () => {
    expect(segmentTemplate('q', '{window}. Which day works for you?')).toEqual([
      { kind: 'var', name: 'window' },
      { kind: 'fixed', id: 'q.0', text: '. Which day works for you?' },
    ]);
    expect(segmentTemplate('r', '{a}{b}')).toEqual([{ kind: 'var', name: 'a' }, { kind: 'var', name: 'b' }]);
    expect(segmentTemplate('s', 'Goodbye.')).toEqual([{ kind: 'fixed', id: 's.0', text: 'Goodbye.' }]);
  });
});

describe('seamViolations', () => {
  it('requires a spoken variable to be followed by punctuation or the end', () => {
    expect(seamViolations('x', segmentTemplate('x', 'On {date}.'))).toEqual([]);
    expect(seamViolations('x', segmentTemplate('x', 'Member ID {memberId}'))).toEqual([]);
    expect(seamViolations('x', segmentTemplate('x', 'Your date {date} is set.'))).toEqual(['x: {date} must be followed by punctuation or end the prompt']);
    expect(seamViolations('x', segmentTemplate('x', 'With {provider} on Monday.'))).toEqual([]);
  });
  it('holds across the whole manifest', () => {
    const all = segmentsOf(manifest);
    const violations = Object.entries(all).flatMap(([id, segs]) => seamViolations(id, segs));
    expect(violations).toEqual([]);
    expect(all.date_narrow_window).toEqual([{ kind: 'var', name: 'window' }, { kind: 'fixed', id: 'date_narrow_window.0', text: '. Which day works for you?' }]);
    expect(SPOKEN_VARS).toEqual(new Set(['memberId', 'date']));
  });
});
```

- [ ] **Step 2: Run to verify they fail**, then implement `src/prompts/segments.ts`:

```ts
export type Segment =
  | { kind: 'fixed'; id: string; text: string }
  | { kind: 'var'; name: string };

/** Variables that are always spoken by TTS (composed values with no clip). */
export const SPOKEN_VARS: ReadonlySet<string> = new Set(['memberId', 'date']);

const VAR = /\{(\w+)\}/g;
const PAUSE = /^[,.?!;:]/;

/** Split a template at its variables; fixed runs are trimmed, empty runs dropped, ids numbered from 0. */
export function segmentTemplate(promptId: string, template: string): Segment[] {
  const out: Segment[] = [];
  let n = 0;
  let last = 0;
  for (const m of template.matchAll(VAR)) {
    const text = template.slice(last, m.index).trim();
    if (text) out.push({ kind: 'fixed', id: `${promptId}.${n++}`, text });
    out.push({ kind: 'var', name: m[1]! });
    last = m.index + m[0].length;
  }
  const tail = template.slice(last).trim();
  if (tail) out.push({ kind: 'fixed', id: `${promptId}.${n++}`, text: tail });
  return out;
}

export function segmentsOf(manifest: Record<string, { text: string }>): Record<string, Segment[]> {
  return Object.fromEntries(Object.entries(manifest).map(([id, entry]) => [id, segmentTemplate(id, entry.text)]));
}

/**
 * Spec §3: a TTS span inside a recorded sentence is the audible seam, so a spoken variable
 * must end its clause. Vocabulary variables sit between clips and are free.
 */
export function seamViolations(promptId: string, segments: Segment[]): string[] {
  const out: string[] = [];
  segments.forEach((s, i) => {
    if (s.kind !== 'var' || !SPOKEN_VARS.has(s.name)) return;
    const next = segments[i + 1];
    if (next && !(next.kind === 'fixed' && PAUSE.test(next.text))) out.push(`${promptId}: {${s.name}} must be followed by punctuation or end the prompt`);
  });
  return out;
}
```

Deviation from spec §3: the "preceded by a pause" half of the invariant is dropped. The seam before a TTS span ("Your member ID is" → number) is unavoidable and every existing prompt has it; only the trailing pause is enforced.

- [ ] **Step 3: Rewrite the template and its pins.** In `manifest.json`, `date_narrow_window` text becomes `"{window}. Which day works for you?"`. In `src/server/adapter.test.ts` and `src/server/server.test.ts`, the three assertions of `'Which day next week works for you?'` become `'next week. Which day works for you?'` (grep for `Which day`). Check `fixtures/scenarios/core.json` for any `expect.text` containing `Which day` (none expected).

- [ ] **Step 4: Run everything.** `pnpm vitest run src/prompts src/server`, `pnpm typecheck`, `pnpm test`, `pnpm regress` (expect `no changes`: prompt ids and outcomes are unchanged). Note for the report: `pnpm regress --client recorded` will now show cassette misses on scenarios whose next turn follows `date_narrow_window` (`node.promptJustPlayed` changed); list them; they are recorded by Jason in Task 8, not fixed here.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/segments.ts src/prompts/segments.test.ts src/prompts/manifest.json src/server/adapter.test.ts src/server/server.test.ts
git commit -m "feat(prompts): template segments and the seam rule; window prompt starts with the window

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Clip discovery and the recordable list

**Files:**
- Create: `src/prompts/clips.ts`, `src/prompts/clips.test.ts`, `assets/audio/.gitkeep`

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverClips, recordableClips, vocabularyClipId } from './clips';

describe('discoverClips', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audio-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('maps clip ids to filenames for wav and mp3 and ignores everything else', () => {
    writeFileSync(join(dir, 'greeting.0.wav'), '');
    writeFileSync(join(dir, 'provider.chen.mp3'), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    writeFileSync(join(dir, '.gitkeep'), '');
    expect(discoverClips(dir)).toEqual(new Map([['greeting.0', 'greeting.0.wav'], ['provider.chen', 'provider.chen.mp3']]));
  });
  it('returns an empty map for a missing directory', () => {
    expect(discoverClips(join(dir, 'nope')).size).toBe(0);
  });
  it('rejects one id recorded in two formats', () => {
    writeFileSync(join(dir, 'greeting.0.wav'), '');
    writeFileSync(join(dir, 'greeting.0.mp3'), '');
    expect(() => discoverClips(dir)).toThrow(/greeting\.0.*wav.*mp3|greeting\.0.*mp3.*wav/);
  });
});

describe('vocabularyClipId', () => {
  it('maps display values back to clip ids', () => {
    expect(vocabularyClipId('provider', 'Dr. Chen')).toBe('provider.chen');
    expect(vocabularyClipId('a', 'Dr. Cheng')).toBe('provider.cheng');
    expect(vocabularyClipId('intentLabel', 'cancel an appointment')).toBe('intent.cancel');
    expect(vocabularyClipId('b', 'ask about billing')).toBe('intent.billing');
    expect(vocabularyClipId('window', 'next week')).toBe('window.next_week');
    expect(vocabularyClipId('window', 'in September')).toBe('window.in_september');
    expect(vocabularyClipId('provider', 'Dr. Nobody')).toBeNull();
    expect(vocabularyClipId('memberId', '4471 8293')).toBeNull();
    expect(vocabularyClipId('date', 'Tuesday, September 22')).toBeNull();
  });
});

describe('recordableClips', () => {
  it('lists every fixed segment and every vocabulary clip once, with text and intonation', () => {
    const rows = recordableClips();
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.find((r) => r.id === 'greeting.0')).toMatchObject({ text: 'Thanks for calling the clinic. How can I help you today?', note: 'closed' });
    expect(rows.find((r) => r.id === 'ack_provider.0')).toMatchObject({ text: 'With', note: 'open' });
    expect(rows.find((r) => r.id === 'date_narrow_window.0')).toMatchObject({ text: 'Which day works for you?', note: 'closed' });
    expect(rows.find((r) => r.id === 'provider.chen')).toMatchObject({ text: 'Dr. Chen', note: 'closed' });
    expect(rows.find((r) => r.id === 'intent.reschedule')).toMatchObject({ text: 'reschedule an appointment', note: 'closed' });
    expect(rows.find((r) => r.id === 'window.this_week')).toMatchObject({ text: 'this week' });
    expect(rows.find((r) => r.id === 'window.in_january')).toMatchObject({ text: 'in January' });
    expect(rows.filter((r) => r.id.startsWith('provider.'))).toHaveLength(8);
    expect(rows.filter((r) => r.id.startsWith('intent.'))).toHaveLength(6);
    expect(rows.some((r) => r.id === 'memberId' || r.id.startsWith('date.'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**, then implement `src/prompts/clips.ts`:

```ts
import { existsSync, readdirSync } from 'node:fs';
import manifest from './manifest.json';
import { segmentsOf, SPOKEN_VARS } from './segments';
import { PROVIDERS } from '../domain/slots/provider';
import { FORM_INTENTS, INTENT_LABELS, type Intent } from '../domain/intents';
import { MONTHS } from '../core/extract/date';

export const AUDIO_TYPES: Readonly<Record<string, string>> = { wav: 'audio/wav', mp3: 'audio/mpeg' };
const CLIP_FILE = /^([A-Za-z0-9_.-]+)\.(wav|mp3)$/;

/** clip id → filename, from the directory listing; a missing directory is an empty index. */
export function discoverClips(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const m = CLIP_FILE.exec(name);
    if (!m) continue;
    const id = m[1]!;
    const prev = out.get(id);
    if (prev) throw new Error(`clip ${id} is recorded twice: ${prev} and ${name}`);
    out.set(id, name);
  }
  return out;
}

const VOCAB_INTENTS: readonly Intent[] = [...FORM_INTENTS, 'agent'];
/** Window labels the date code can produce (`describeWindow`): relative windows plus "in <Month>". */
const WINDOW_LABELS: readonly string[] = ['next week', 'this week', 'this month', ...MONTHS.map((m) => `in ${m[0]!.toUpperCase()}${m.slice(1)}`)];

function windowId(display: string): string {
  return `window.${display.toLowerCase().replace(/ /g, '_')}`;
}

/** The clip id for a vocabulary variable's display value, or null when it is spoken by TTS. */
export function vocabularyClipId(name: string, display: string): string | null {
  if (SPOKEN_VARS.has(name)) return null;
  const provider = PROVIDERS.find((p) => `Dr. ${p.name}` === display);
  if (provider && (name === 'provider' || name === 'a' || name === 'b')) return `provider.${provider.key}`;
  const intent = VOCAB_INTENTS.find((i) => INTENT_LABELS[i] === display);
  if (intent && (name === 'intentLabel' || name === 'a' || name === 'b')) return `intent.${intent}`;
  if (name === 'window' && WINDOW_LABELS.includes(display)) return windowId(display);
  return null;
}

export interface RecordableClip { id: string; text: string; note: 'open' | 'closed' }

/** Text a person records for a fixed segment: the template text without its leading punctuation. */
function recordingText(text: string): string {
  return text.replace(/^[,.?!;:]\s*/, '');
}

/** Every clip the manifest and vocabularies can use, each once, with the text to record. */
export function recordableClips(): RecordableClip[] {
  const rows: RecordableClip[] = [];
  for (const segments of Object.values(segmentsOf(manifest))) {
    segments.forEach((s, i) => {
      if (s.kind !== 'fixed') return;
      const next = segments[i + 1];
      rows.push({ id: s.id, text: recordingText(s.text), note: next?.kind === 'var' ? 'open' : 'closed' });
    });
  }
  for (const p of PROVIDERS) rows.push({ id: `provider.${p.key}`, text: `Dr. ${p.name}`, note: 'closed' });
  for (const i of VOCAB_INTENTS) rows.push({ id: `intent.${i}`, text: INTENT_LABELS[i], note: 'closed' });
  for (const w of WINDOW_LABELS) rows.push({ id: windowId(w), text: w, note: 'closed' });
  return rows;
}
```

Verify against `src/core/extract/date.ts` which window labels `describeWindow` can return (grep `label:` and `describeWindow`); if it can produce labels other than the three relative ones plus months, add them to `WINDOW_LABELS` and report. `MONTHS` must be exported from `date.ts`; if it is not, export it (a one-line change in `src/core`, allowed for this task) and report.

Create `assets/audio/.gitkeep` (empty file) so the directory exists in the repo.

- [ ] **Step 3: Run, typecheck, full suite, commit**

```bash
git add src/prompts/clips.ts src/prompts/clips.test.ts assets/audio/.gitkeep src/core/extract/date.ts
git commit -m "feat(prompts): clip discovery by filename and the recordable clip list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(`git add` of an unchanged `date.ts` is harmless.)

---

### Task 3: Rendering with a clip index

**Files:**
- Modify: `src/prompts/render.ts`, `src/prompts/render.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `render.test.ts`; it imports `decisionToFrames`, `promptText`):

```ts
describe('decisionToFrames with clips', () => {
  const base = 'https://demo.ngrok.app/audio/';
  const clips = new Map([
    ['greeting.0', 'greeting.0.wav'],
    ['ack_provider.0', 'ack_provider.0.wav'], ['ack_provider.1', 'ack_provider.1.wav'], ['provider.chen', 'provider.chen.wav'],
    ['confirm_memberId.0', 'confirm_memberId.0.wav'], ['confirm_memberId.1', 'confirm_memberId.1.mp3'],
    ['goodbye.0', 'goodbye.0.wav'],
  ]);
  const ctx = { clips, audioBase: base };
  const p = (source: string, interruptible: boolean) => ({ type: 'play', source, loop: 1, preemptible: false, interruptible });
  const t = (token: string, interruptible: boolean) => ({ type: 'text', token, last: true, lang: 'en-US', interruptible, preemptible: false });

  it('renders a fully recorded prompt as play frames', () => {
    const frames = decisionToFrames({ kind: 'prompt', promptId: 'greeting', vars: {}, acks: [], target: 'intent', options: [] }, ctx);
    expect(frames).toEqual([p(`${base}greeting.0.wav`, true)]);
  });

  it('plays vocabulary clips and speaks composed values, merging adjacent text', () => {
    const frames = decisionToFrames({
      kind: 'prompt', promptId: 'confirm_memberId', vars: { memberId: '4471 8293' }, target: 'memberId', options: ['yes', 'no'],
      acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }],
    }, ctx);
    expect(frames).toEqual([
      p(`${base}ack_provider.0.wav`, false), p(`${base}provider.chen.wav`, false), p(`${base}ack_provider.1.wav`, false),
      p(`${base}confirm_memberId.0.wav`, false), t('4471 8293', false), p(`${base}confirm_memberId.1.mp3`, false),
    ]);
  });

  it('falls back to text per segment and joins text without a space before punctuation', () => {
    const partial = { clips: new Map([['ack_provider.0', 'ack_provider.0.wav']]), audioBase: base };
    const frames = decisionToFrames({ kind: 'prompt', promptId: 'ask_memberId', vars: {}, target: 'memberId', options: [], acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Kim' } }] }, partial);
    expect(frames).toEqual([p(`${base}ack_provider.0.wav`, false), t('Dr. Kim.', false), t(promptText('ask_memberId', {}), true)]);
  });

  it('renders exactly as today without a context', () => {
    const d = { kind: 'prompt' as const, promptId: 'ask_memberId', vars: {}, target: 'memberId' as const, options: [], acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }] };
    expect(decisionToFrames(d, null)).toEqual(decisionToFrames(d));
    expect(decisionToFrames(d)).toEqual([t('With Dr. Chen.', false), t(promptText('ask_memberId', {}), true)]);
  });

  it('plays the goodbye clip after a completion and keeps the end frame', () => {
    const frames = decisionToFrames({ kind: 'complete', form: 'cancel', promptId: 'cancel_confirmed', vars: { memberId: '4471 8293', provider: 'Dr. Chen' }, acks: [], completed: ['cancel'] }, ctx);
    expect(frames.at(-2)).toEqual(p(`${base}goodbye.0.wav`, false));
    expect(frames.at(-1)).toMatchObject({ type: 'end' });
    expect(frames.some((f) => f.type === 'text' && f.token === '4471 8293,')).toBe(true);
  });
});
```

The last assertion shows the merge rule: the fixed segment after `{memberId}` in `cancel_confirmed` starts with a comma and has no clip in this index, so it merges with the spoken ID as `4471 8293,` followed by the rest of that text run. If the actual merged token differs, print it and fix the test to the correct merged text, not the rule.

- [ ] **Step 2: Run to verify they fail**, then implement in `render.ts`:

```ts
import { segmentTemplate } from './segments';
import { vocabularyClipId } from './clips';
import { endFrame, textFrame, type OutboundFrame, type PlayFrame } from '../channel/frames';

export interface RenderContext {
  /** clip id → filename, from discoverClips */
  clips: Map<string, string>;
  /** absolute URL prefix the filename is appended to */
  audioBase: string;
}

/** Drop the manifest's unused `audio` field from PromptEntry. */

function playFrame(source: string, interruptible: boolean): PlayFrame {
  return { type: 'play', source, loop: 1, preemptible: false, interruptible };
}

const PAUSE = /^[,.?!;:]/;

/** One prompt as frames: clips where they exist, TTS text otherwise, adjacent text merged. */
export function promptFrames(promptId: string, vars: Record<string, string>, interruptible: boolean, ctx: RenderContext | null | undefined): OutboundFrame[] {
  if (!ctx) return [textFrame(promptText(promptId, vars), interruptible)];
  const frames: OutboundFrame[] = [];
  let text: string | null = null;
  const flush = (): void => { if (text !== null) { frames.push(textFrame(text, interruptible)); text = null; } };
  const speak = (piece: string): void => { text = text === null ? piece : PAUSE.test(piece) ? text + piece : `${text} ${piece}`; };
  for (const s of segmentTemplate(promptId, promptEntry(promptId).text)) {
    if (s.kind === 'fixed') {
      const file = ctx.clips.get(s.id);
      if (file) { flush(); frames.push(playFrame(ctx.audioBase + file, interruptible)); } else speak(s.text);
      continue;
    }
    const value = vars[s.name];
    if (value === undefined) throw new Error(`prompt variable missing: ${s.name}`);
    const id = vocabularyClipId(s.name, value);
    const file = id ? ctx.clips.get(id) : undefined;
    if (file) { flush(); frames.push(playFrame(ctx.audioBase + file, interruptible)); } else speak(value);
  }
  flush();
  return frames;
}
```

`decisionToFrames(decision, ctx?: RenderContext | null)` uses `promptFrames` for every ack, prompt, completion line, `goodbye`, and handoff prompt, with the same `interruptible` values as today (acks false, prompt from manifest, completion/goodbye/handoff false), and the same `end` frames. `spokenText` and `decisionText` are unchanged. Remove `audio?: string | null` from `PromptEntry`.

- [ ] **Step 3: Run, typecheck, full suite, commit**

```bash
git add src/prompts/render.ts src/prompts/render.test.ts
git commit -m "feat(prompts): render play frames for recorded segments, merged text for the rest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Thread the render context through the turn

**Files:**
- Modify: `src/run/turn.ts`, `src/core/turn.ts`
- Test: `src/core/turn.test.ts`

- [ ] **Step 1: Write the failing test** (append inside `describe('turn', ...)`):

```ts
  it('renders play frames when the turn context carries clips, and text otherwise', () => {
    const ctx = { clips: new Map([['greeting.0', 'greeting.0.wav']]), audioBase: 'https://h/audio/' };
    const r = resolve(newSession('s', 0), setupFrame('s'), null, { ...tc, render: ctx });
    expect(r.frames).toEqual([{ type: 'play', source: 'https://h/audio/greeting.0.wav', loop: 1, preemptible: false, interruptible: true }]);
    expect(resolve(newSession('s', 0), setupFrame('s'), null, tc).frames[0]).toMatchObject({ type: 'text' });
    expect(r.session.lastPromptText).toBe('Thanks for calling the clinic. How can I help you today?');
  });
```

- [ ] **Step 2: Implement.** `TurnContext` gains `render?: RenderContext | null` (import the type from `../prompts/render`); every `decisionToFrames(decision)` in `resolve` becomes `decisionToFrames(decision, tc.render)`. `RunOptions` gains `render?: RenderContext | null` and `runTurn` builds `tc` with `render: opts.render ?? null`. Nothing else changes: `bookkeep` still uses `spokenText`.

- [ ] **Step 3: Run, typecheck, full suite, `pnpm regress` (no changes), commit**

```bash
git add src/run/turn.ts src/core/turn.ts src/core/turn.test.ts
git commit -m "feat(run): optional render context on run options reaches frame rendering

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Serve clips; config; coverage at startup; TTS voice

**Files:**
- Modify: `src/server/config.ts`, `src/server/http.ts`, `src/server/twiml.ts`, `src/server/index.ts`, `.env.example`
- Test: `src/server/config.test.ts`, `src/server/http.test.ts`, `src/server/twiml.test.ts`, `src/server/server.test.ts`

- [ ] **Step 1: Write the failing tests**

`config.test.ts`:
```ts
  it('defaults the audio dir and takes an optional TTS voice as a provider and voice pair', () => {
    const base = { PUBLIC_HOST: 'h.example', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567' };
    expect(loadConfig(base)).toMatchObject({ audioDir: 'assets/audio', ttsProvider: null, ttsVoice: null });
    expect(loadConfig({ ...base, AUDIO_DIR: '/tmp/a', TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' })).toMatchObject({ audioDir: '/tmp/a', ttsProvider: 'Google', ttsVoice: 'en-US-Neural2-F' });
    expect(() => loadConfig({ ...base, TTS_VOICE: 'x' })).toThrow(/TTS_PROVIDER and TTS_VOICE/);
  });
```

`http.test.ts` (use the file's existing harness for building deps and issuing requests; add `audioDir` to the deps it builds, pointing at a temp dir):
```ts
  it('serves audio clips with the right type and cache headers, and nothing else under /audio', async () => {
    writeFileSync(join(audioDir, 'greeting.0.wav'), Buffer.from('RIFFdata'));
    const ok = await get('/audio/greeting.0.wav');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('audio/wav');
    expect(ok.headers['cache-control']).toBe('public, max-age=86400');
    expect(ok.body.toString()).toBe('RIFFdata');
    expect((await head('/audio/greeting.0.wav')).status).toBe(200);
    expect((await get('/audio/missing.wav')).status).toBe(404);
    expect((await get('/audio/notes.txt')).status).toBe(404);
    expect((await get('/audio/../package.json')).status).toBe(404);
    expect((await get('/audio/%2e%2e/package.json')).status).toBe(404);
  });
```

`twiml.test.ts`:
```ts
  it('adds ttsProvider and voice only when configured', () => {
    expect(connectRelayTwiml({ publicHost: 'h', token: 't', hints: '' })).not.toMatch(/ttsProvider|voice=/);
    const x = connectRelayTwiml({ publicHost: 'h', token: 't', hints: '', ttsProvider: 'Google', voice: 'en-US-Neural2-F' });
    expect(x).toContain('ttsProvider="Google"');
    expect(x).toContain('voice="en-US-Neural2-F"');
  });
```

`server.test.ts`: one end-to-end case: start the server with `audioDir` pointing at a temp dir holding `greeting.0.wav`; connect the fake relay, send setup, and assert the first outbound message is `{ type: 'play', source: 'https://<publicHost>/audio/greeting.0.wav', ... }` (extend `FakeRelay` with a `plays()`/`waitForMessages` helper if it only collects text), and that the startup log contains `audio: 1 of` and `clips present`.

- [ ] **Step 2: Implement.**

`config.ts`: `ServerConfig` gains `audioDir: string; ttsProvider: string | null; ttsVoice: string | null`; `loadConfig` reads `AUDIO_DIR` (default `assets/audio`), `TTS_PROVIDER`, `TTS_VOICE` (both or neither, else throw `TTS_PROVIDER and TTS_VOICE must be set together`); `describeConfig` prints `audio dir`, and `tts <provider> <voice>` or `tts default`.

`http.ts`: `HttpDeps` gains `audioDir: string`. Before the `/health` branch:

```ts
      if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/audio/')) {
        const name = decodeURIComponent(path.slice('/audio/'.length));
        const m = /^([A-Za-z0-9_.-]+)\.(wav|mp3)$/.exec(name);
        const file = m && !name.includes('..') ? join(deps.audioDir, name) : null;
        if (!file || !existsSync(file)) { reply(res, 404, 'text/plain', 'not found'); return; }
        const body = readFileSync(file);
        res.writeHead(200, { 'content-type': AUDIO_TYPES[m![2]!]!, 'content-length': body.length, 'cache-control': 'public, max-age=86400' });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
```

(`decodeURIComponent` can throw on malformed input; wrap and 404.) No signature check on this route.

`twiml.ts`: `ConnectOptions` gains `ttsProvider?: string; voice?: string`; append `ttsProvider="..."` and `voice="..."` attributes (escaped) only when both are set. `http.ts` passes them from `deps.config` where it builds the connect TwiML.

`index.ts`: after config, `const clips = discoverClips(config.audioDir); const total = recordableClips().length; log(\`audio: ${clips.size} of ${total} clips present (${Math.max(0, total - clips.size)} segments fall back to TTS)\`);` and log each missing id at the end of that line only when fewer than 10 are missing, else the count. Add `render: { clips, audioBase: \`https://${config.publicHost}/audio/\` }` to the run options the store factory builds; pass `audioDir: config.audioDir` in `deps`. Update `.env.example` with `AUDIO_DIR`, `TTS_PROVIDER`, `TTS_VOICE` (commented, with the "same voice as your clips" note).

- [ ] **Step 3: Run, typecheck, full suite, commit**

```bash
git add src/server .env.example
git commit -m "feat(server): serve /audio clips, log coverage at startup, optional TTS voice, render context on calls

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Recording sheet and coverage check

**Files:**
- Create: `src/prompts/sheet.ts`, `src/prompts/sheet.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { coverage, renderSheet } from './sheet';

describe('sheet', () => {
  it('prints one tab-separated line per clip with id, text, and note', () => {
    const out = renderSheet([{ id: 'a.0', text: 'With', note: 'open' }, { id: 'provider.chen', text: 'Dr. Chen', note: 'closed' }]);
    expect(out.split('\n')).toEqual(['id\ttext\tnote', 'a.0\tWith\topen', 'provider.chen\tDr. Chen\tclosed']);
  });
  it('reports coverage and the missing ids', () => {
    const c = coverage([{ id: 'a.0', text: '', note: 'closed' }, { id: 'a.1', text: '', note: 'closed' }], new Map([['a.0', 'a.0.wav'], ['stray', 'stray.wav']]));
    expect(c).toEqual({ present: 1, total: 2, missing: ['a.1'], unused: ['stray'] });
  });
});
```

- [ ] **Step 2: Implement `src/prompts/sheet.ts`:**

```ts
import { basename } from 'node:path';
import { discoverClips, recordableClips, type RecordableClip } from './clips';

export function renderSheet(rows: RecordableClip[]): string {
  return ['id\ttext\tnote', ...rows.map((r) => `${r.id}\t${r.text}\t${r.note}`)].join('\n');
}

export function coverage(rows: RecordableClip[], clips: Map<string, string>): { present: number; total: number; missing: string[]; unused: string[] } {
  const ids = new Set(rows.map((r) => r.id));
  const missing = rows.filter((r) => !clips.has(r.id)).map((r) => r.id);
  const unused = [...clips.keys()].filter((id) => !ids.has(id)).sort();
  return { present: rows.length - missing.length, total: rows.length, missing, unused };
}

function main(): void {
  const mode = process.argv[2];
  const dir = process.env.AUDIO_DIR?.trim() || 'assets/audio';
  const rows = recordableClips();
  if (mode === 'sheet') { console.log(renderSheet(rows)); return; }
  if (mode === 'check') {
    const c = coverage(rows, discoverClips(dir));
    console.log(`audio: ${c.present} of ${c.total} clips present in ${dir} (${c.missing.length} segments fall back to TTS)`);
    for (const id of c.missing) console.log(`  missing ${id}`);
    for (const id of c.unused) console.log(`  unused  ${id}`);
    process.exitCode = c.missing.length ? 1 : 0;
    return;
  }
  console.error('usage: sheet | check');
  process.exitCode = 2;
}

if (process.argv[1] && basename(process.argv[1]) === 'sheet.ts') main();
```

`package.json` scripts: `"prompts:sheet": "tsx src/prompts/sheet.ts sheet"`, `"prompts:check": "tsx src/prompts/sheet.ts check"`. Verify `pnpm prompts:sheet | head -5` and `pnpm prompts:check; echo exit=$?` (expect `0 of N` and exit 1 with the empty assets dir; paste N).

- [ ] **Step 3: Run, typecheck, full suite, commit**

```bash
git add src/prompts/sheet.ts src/prompts/sheet.test.ts package.json
git commit -m "feat(prompts): recording sheet and coverage check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Generate clips with Fish Audio

**Files:**
- Create: `src/prompts/generate.ts`, `src/prompts/generate.test.ts`, `src/prompts/tags.json`
- Modify: `package.json`, `.env.example`

Jason generates clips in the Fish Audio web app with the Hanna voice, model `s2.1-pro`, and its auto-tagging, picking the second candidate; doing that by hand for eighty clips is the bottleneck. The API (`POST https://api.fish.audio/v1/tts`, bearer auth, JSON body `{ text, reference_id, format, temperature, prosody }`, `model` header, streamed audio bytes; `GET https://api.fish.audio/model?title=<name>` lists voices with `_id` and `title`) has no auto-tag endpoint, so tags are chosen here: a default tag prefix for every clip plus optional per-clip overrides, in `s2.1-pro`'s `[bracket]` syntax, and `--candidates N` generates variants to pick from.

**Never call the API from an agent session**: the key is Jason's, and every test injects a fake `fetch`. `--dry-run` prints requests with the key redacted.

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateClips, resolveVoice, ttsRequest, type GenerateOptions } from './generate';

const row = { id: 'ack_provider.0', text: 'With', note: 'open' as const };

describe('ttsRequest', () => {
  it('prefixes the tag, sets the model header, and never includes the key in the printable form', () => {
    const r = ttsRequest(row, { voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[warm]', tags: { 'ack_provider.0': '[warm and brisk]' } });
    expect(r.url).toBe('https://api.fish.audio/v1/tts');
    expect(r.headers.model).toBe('s2.1-pro');
    expect(r.body).toEqual({ text: '[warm and brisk] With', reference_id: 'v1', format: 'wav', temperature: 0.7, prosody: { speed: 1, volume: 0 } });
    expect(ttsRequest({ ...row, id: 'greeting.0' }, { voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[warm]', tags: {} }).body.text).toBe('[warm] With');
    expect(JSON.stringify(r)).not.toMatch(/Bearer/);
  });
});

describe('resolveVoice', () => {
  it('returns an id unchanged and looks a title up in the list response', async () => {
    const fetchStub = async (url: string) => ({ ok: true, status: 200, json: async () => ({ items: [{ _id: 'abc123', title: 'Hanna' }, { _id: 'zzz', title: 'Hannah B' }] }), arrayBuffer: async () => new ArrayBuffer(0) });
    expect(await resolveVoice('abc123def', 'k', fetchStub as never)).toBe('abc123def');
    expect(await resolveVoice('Hanna', 'k', fetchStub as never)).toBe('abc123');
    await expect(resolveVoice('Nobody', 'k', async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as never)).rejects.toThrow(/no voice titled/);
  });
});

describe('generateClips', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audio-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const opts = (over: Partial<GenerateOptions> = {}): GenerateOptions => ({ audioDir: dir, apiKey: 'k', voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[warm]', tags: {}, candidates: 1, force: false, only: null, dryRun: false, ...over });
  const calls: string[] = [];
  const fetchStub = async (_url: string, init: { body: string }) => { calls.push(JSON.parse(init.body).text); return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('RIFF' + calls.length).buffer }; };

  it('writes missing clips only, skips present ones, and reports counts', async () => {
    const r = await generateClips([row, { id: 'greeting.0', text: 'Hi.', note: 'closed' }], opts(), fetchStub as never);
    expect(readdirSync(dir).sort()).toEqual(['ack_provider.0.wav', 'greeting.0.wav']);
    expect(readFileSync(join(dir, 'ack_provider.0.wav'), 'utf8')).toBe('RIFF1');
    expect(r).toEqual({ generated: ['ack_provider.0', 'greeting.0'], skipped: [], failed: [] });
    const again = await generateClips([row], opts(), fetchStub as never);
    expect(again.skipped).toEqual(['ack_provider.0']);
    expect(calls).toHaveLength(2);
  });

  it('writes candidates under candidates/<id>-<n> when asked, and honors --only and --force', async () => {
    await generateClips([row, { id: 'greeting.0', text: 'Hi.', note: 'closed' }], opts({ candidates: 2, only: ['greeting.0'] }), fetchStub as never);
    expect(readdirSync(join(dir, 'candidates')).sort()).toEqual(['greeting.0-1.wav', 'greeting.0-2.wav']);
    expect(readdirSync(dir).includes('ack_provider.0.wav')).toBe(false);
  });

  it('records a failure and keeps going, and dry-run writes nothing', async () => {
    const failing = async () => ({ ok: false, status: 500, text: async () => 'boom', arrayBuffer: async () => new ArrayBuffer(0) });
    const r = await generateClips([row], opts(), failing as never);
    expect(r.failed).toEqual([{ id: 'ack_provider.0', error: 'HTTP 500: boom' }]);
    const dry = await generateClips([row], opts({ dryRun: true }), failing as never);
    expect(dry.generated).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**, then implement `src/prompts/generate.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { discoverClips, recordableClips, type RecordableClip } from './clips';

const TTS_URL = 'https://api.fish.audio/v1/tts';
const MODELS_URL = 'https://api.fish.audio/model';

export interface RequestOptions { voiceId: string; model: string; format: 'wav' | 'mp3'; tag: string; tags: Record<string, string> }
export interface GenerateOptions extends RequestOptions {
  audioDir: string;
  apiKey: string;
  candidates: number;
  force: boolean;
  only: string[] | null;
  dryRun: boolean;
}
export interface GenerateResult { generated: string[]; skipped: string[]; failed: Array<{ id: string; error: string }> }

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }>;

/** The request for one clip, without the auth header, so it can be printed and tested. */
export function ttsRequest(row: RecordableClip, o: RequestOptions) {
  const tag = o.tags[row.id] ?? o.tag;
  return {
    url: TTS_URL,
    headers: { 'content-type': 'application/json', model: o.model },
    body: { text: tag ? `${tag} ${row.text}` : row.text, reference_id: o.voiceId, format: o.format, temperature: 0.7, prosody: { speed: 1, volume: 0 } },
  };
}

/** A 24-hex-ish id is used as is; anything else is looked up by exact title. */
export async function resolveVoice(voice: string, apiKey: string, fetchFn: Fetch): Promise<string> {
  if (/^[0-9a-f]{8,}$/i.test(voice)) return voice;
  const res = await fetchFn(`${MODELS_URL}?title=${encodeURIComponent(voice)}&page_size=20`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`voice lookup failed: HTTP ${res.status}`);
  const data = (await res.json!()) as { items?: Array<{ _id: string; title: string }> };
  const hit = (data.items ?? []).find((m) => m.title === voice) ?? (data.items ?? [])[0];
  if (!hit) throw new Error(`no voice titled "${voice}"`);
  return hit._id;
}

export async function generateClips(rows: RecordableClip[], o: GenerateOptions, fetchFn: Fetch): Promise<GenerateResult> {
  const result: GenerateResult = { generated: [], skipped: [], failed: [] };
  const present = discoverClips(o.audioDir);
  const wanted = o.only ? rows.filter((r) => o.only!.includes(r.id)) : rows;
  for (const row of wanted) {
    if (!o.force && o.candidates === 1 && present.has(row.id)) { result.skipped.push(row.id); continue; }
    const req = ttsRequest(row, o);
    if (o.dryRun) { console.log(JSON.stringify({ id: row.id, ...req })); continue; }
    try {
      for (let n = 1; n <= o.candidates; n++) {
        const res = await fetchFn(req.url, { method: 'POST', headers: { ...req.headers, authorization: `Bearer ${o.apiKey}` }, body: JSON.stringify(req.body) });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.text ? await res.text() : ''}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        const target = o.candidates === 1 ? join(o.audioDir, `${row.id}.${o.format}`) : join(o.audioDir, 'candidates', `${row.id}-${n}.${o.format}`);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, bytes);
      }
      result.generated.push(row.id);
    } catch (e) {
      result.failed.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

async function main(): Promise<void> {
  const { parseArgs } = await import('node:util');
  const { values: a } = parseArgs({ options: {
    voice: { type: 'string' }, model: { type: 'string', default: 's2.1-pro' }, format: { type: 'string', default: 'wav' },
    tag: { type: 'string', default: '[warm]' }, candidates: { type: 'string', default: '1' }, only: { type: 'string' },
    force: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
  } });
  const apiKey = process.env.FISH_AUDIO_API_KEY?.trim();
  const voice = a.voice ?? process.env.FISH_VOICE?.trim();
  if (!a['dry-run'] && !apiKey) throw new Error('FISH_AUDIO_API_KEY is not set');
  if (!voice) throw new Error('pass --voice <title or id> or set FISH_VOICE');
  const format = a.format === 'mp3' ? 'mp3' : 'wav';
  const tags = existsSync('src/prompts/tags.json') ? (JSON.parse(readFileSync('src/prompts/tags.json', 'utf8')) as Record<string, string>) : {};
  const voiceId = a['dry-run'] && !apiKey ? voice : await resolveVoice(voice, apiKey ?? '', fetch as unknown as Fetch);
  const r = await generateClips(recordableClips(), {
    audioDir: process.env.AUDIO_DIR?.trim() || 'assets/audio', apiKey: apiKey ?? '', voiceId, model: a.model!, format, tag: a.tag!, tags,
    candidates: Math.max(1, Number(a.candidates)), force: a.force ?? false, only: a.only ? a.only.split(',').map((s) => s.trim()) : null, dryRun: a['dry-run'] ?? false,
  }, fetch as unknown as Fetch);
  console.log(`generated ${r.generated.length}, skipped ${r.skipped.length}, failed ${r.failed.length}`);
  for (const f of r.failed) console.log(`  ${f.id}: ${f.error}`);
  process.exitCode = r.failed.length ? 1 : 0;
}

if (process.argv[1] && basename(process.argv[1]) === 'generate.ts') main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
```

`src/prompts/tags.json` is authored in this task with a tag for EVERY recordable clip id (run `pnpm prompts:sheet` for the list), in `s2.1-pro`'s bracket syntax, chosen by what the line does on a phone: the greeting and acks `[warm and welcoming]`; questions `[friendly]`; retry and keypad prompts `[patient and clear]`; confirmations and readbacks `[calm and clear]`; completion lines `[reassuring]`; `handoff_frustrated` `[empathetic]`; other handoffs `[calm]`; `goodbye` `[warm]`; provider names, intent labels and windows `[neutral]` (they are spliced mid-sentence). Fixed segments marked `open` in the sheet also get `, no falling intonation` appended inside the bracket, e.g. `[warm, no falling intonation]`. A test asserts every recordable id has a tag and no tag names an unknown id. The CLI default `--tag` is then only a fallback for ids added later. `package.json`: `"prompts:generate": "tsx src/prompts/generate.ts"`. `.env.example`: `FISH_AUDIO_API_KEY=` and `FISH_VOICE=Hanna` with a comment. The agent verifies only with `pnpm prompts:generate --dry-run --voice Hanna --only greeting.0` (prints the request, no key needed, nothing written).

- [ ] **Step 3: Run, typecheck, full suite, commit**

```bash
git add src/prompts/generate.ts src/prompts/generate.test.ts src/prompts/tags.json package.json .env.example
git commit -m "feat(prompts): generate missing clips with Fish Audio from the recording sheet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: README and the deviation record

**Files:**
- Modify: `README.md`, this plan

- [ ] **Step 1: README.** Under `## Phone line (Twilio ConversationRelay)`, after "### Confirmation and multi-intent" and before "### Live-call checklist", add:

```markdown
### Recorded prompts

    pnpm prompts:sheet > clips.tsv    # every clip id with the exact text to record
    pnpm prompts:check                # which clips are present under AUDIO_DIR
    pnpm prompts:generate             # generate every missing clip with Fish Audio (FISH_AUDIO_API_KEY, FISH_VOICE)
    pnpm prompts:generate --only greeting.0 --candidates 3 --force   # audition variants under assets/audio/candidates/

Clips live in `assets/audio/` (or `AUDIO_DIR`) as `<clipId>.wav` or `.mp3`
and are discovered by filename; adding one needs no manifest edit. A clip
id is a fixed segment of a prompt (`ack_provider.0`, the text before the
provider name) or a vocabulary value (`provider.chen`, `intent.cancel`,
`window.next_week`). Member IDs and dates are always spoken by TTS, at a
clause boundary so the voice change is not inside a sentence. The sheet's
`open` note means the segment precedes a variable: record it without a
falling intonation.

The server serves clips at `https://PUBLIC_HOST/audio/<file>` and logs
coverage at startup; any segment without a clip falls back to TTS for that
segment only, and adjacent TTS segments are merged so prosody survives.
Clips are generated with Fish Audio's `s2.1-pro` model and the voice named
in `FISH_VOICE`; a `[warm]`-style tag prefixes every clip (override per clip
in `src/prompts/tags.json`). Twilio's TTS fallback cannot use that voice, so
set `TTS_PROVIDER` and `TTS_VOICE` to the closest ConversationRelay voice to
keep the seams on member IDs and dates as quiet as possible.
```

Also mention in the cassette section that changing a prompt's text re-keys the turns that follow it (the `date_narrow_window` rewrite did), so scenario turns after it need a `record` run.

- [ ] **Step 2: Deviation record.** Append "Deviations recorded during execution" to this plan in the format of the previous plans, including the §3 seam rule change (trailing pause only) and anything the tasks reported.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/plans/2026-09-19-recorded-prompts.md
git commit -m "docs: recorded prompts; record plan deviations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9 (Jason, not an agent): clips, coverage, and the re-record

1. With `FISH_AUDIO_API_KEY` and `FISH_VOICE=9a9cf47702da476aa4629e2506d4a857` (Hannah by Fish Official; a title lookup for "Hanna" resolved to an accented voice with the same title) in `.env`: `set -a; source .env; set +a; pnpm prompts:generate` writes every missing clip to `assets/audio/` (about eighty short requests). To audition a clip, `pnpm prompts:generate --only greeting.0 --candidates 3 --force` writes three variants under `assets/audio/candidates/`; copy the one you like to `assets/audio/greeting.0.wav`. Per-clip tag overrides go in `src/prompts/tags.json`. `pnpm prompts:check` shows what is left. Audition the one-word open clips first with and without the trailing comma — `ack_provider.0` ("With"), `disambiguate_intent.1` ("or"), and `ack_date.0` ("On") are good candidates, since a one-word clip has the least text to carry the contour — for example `pnpm prompts:generate --only ack_provider.0 --candidates 2 --force` and `pnpm prompts:generate --only ack_provider.0 --candidates 2 --force --plain-open`, and pick which contour sounds better before the full run.
2. `pnpm regress --client recorded` will list cassette misses on the scenario turns that follow the rewritten window prompt. Record them once:

```bash
set -a; source .env; set +a; pnpm regress --client record --threshold JEV_TIMEOUT_MS=15000
```

then commit `fixtures/recorded/jev-1.13.0.jsonl` and the clips:

```bash
git add assets/audio fixtures/recorded/jev-1.13.0.jsonl
git commit -m "assets: first recorded clips; record the turns after the rewritten window prompt

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

3. `pnpm serve` and one live call: the greeting plays from the clip, and the startup log shows the coverage line.

---

## Self-review

- Spec §2 segments and clip ids: Tasks 1–2. §3 rewrite and seam rule: Task 1 (with the deviation). §4 discovery: Task 2. §5 rendering: Tasks 3–4. §6 serving and coverage: Task 5. §7 sheet and check: Task 6; clip generation (added at Jason's request, not in the spec): Task 7. §8 tests: each task. §9 README: Task 8.
- Names used across tasks: `Segment`, `segmentTemplate`, `segmentsOf`, `seamViolations`, `SPOKEN_VARS`, `discoverClips`, `vocabularyClipId`, `recordableClips`, `RecordableClip`, `AUDIO_TYPES`, `RenderContext`, `promptFrames`, `decisionToFrames(decision, ctx?)`, `RunOptions.render`, `TurnContext.render`, `ServerConfig.audioDir/ttsProvider/ttsVoice`, `HttpDeps.audioDir`, `ConnectOptions.ttsProvider/voice`, `renderSheet`, `coverage`. All defined before use.
- The text harness never passes a render context, so its output and the regression baseline are unchanged by construction.

## Deviations recorded during execution

- **Task 1 (f737fac, 16d82fc).** The seam rule only enforces the trailing pause: spec §3 also
  wanted a spoken variable preceded by a fixed segment ending at a natural pause, but that half
  was dropped, since the seam before a TTS span exists in every readback regardless. `segments.ts`
  gained `joinSpoken(pieces)`, checked against `renderTemplate` with a manifest-wide round-trip
  test. `VAR` (the `{word}` regex) is exported and shared with `renderTemplate` rather than
  duplicated, and `VOCAB_VARS` is exported for reuse by `clips.ts`.
- **Task 2 (340c757, 1358e9c, 2c341de).** A fixed segment that is bare punctuation after a
  variable (`.` or `?`, nine of them across the manifest) is not a recordable row. `intent.agent`
  is dropped from the vocabulary — the agent intent always hands off rather than being spoken
  back — leaving five intent clips. The plan's `WINDOW_LABELS` was missing `next month`; the
  actual list is derived from `WINDOWS` plus `MONTHS` through `describeWindow` itself, so it
  can't drift again, giving sixteen labels (four relative windows, twelve months). Clip extension
  matching (`wav`/`mp3`) is case-insensitive; clip ids stay case-sensitive. `discoverClips`
  ignores subdirectories, keeps symlinks, and returns an empty map on `ENOENT`/`ENOTDIR` rather
  than throwing. `recordableClips()`'s output is pinned with a committed snapshot. Spec §4 names
  the discovery function `clipIds(manifest)`; the implementation is `recordableClips()`, per the
  plan rather than the spec.
- **Task 3 (e0e1a84, 1b8fab9).** Text merging goes through `joinSpoken` rather than a plain
  space-join (spec §5); a punctuation-only segment is never clip-backed, so it can't become its
  own play frame; a text run that immediately follows a play frame has its leading pause stripped
  and is dropped entirely if that empties it. The plan's expected token `'4471 8293,'` for a
  merged run was wrong — the whole run merges into one text frame, not that fragment alone. A
  property test checks full frame coverage over every manifest prompt. Open question for the live
  call: the now-interruptible multi-frame prompts (`disambiguate_intent`/`disambiguate_provider`:
  4 frames each; `date_narrow_window`: 2 frames) all set `preemptible: false` on every frame, and
  whether Twilio drops queued play frames after a barge-in is unverified without a live call.
  Follow-up: `disambiguate_*` prompts end with a bare `?` that is dropped once it follows a clip,
  so the fully recorded form of that prompt loses its question intonation.
- **Task 4 (de664a3).** Plumbing only — a stale comment in `src/core/turn.ts` was reworded to
  match. Follow-up, not built: the `replay` decision ("repeat that") always re-speaks
  `lastPromptText` via TTS, even when the original prompt played from clips; fixing that needs
  `lastPromptId` and its vars kept on the session.
- **Task 5 (1df422f, 613b0f7).** Any read failure on `/audio/<file>` — missing file, a directory,
  a dangling symlink — is a plain 404, never a 500; the response carries `accept-ranges: none`.
  There is no separate `..` check: the filename regex (`[A-Za-z0-9_.-]+\.(wav|mp3)`, case
  insensitive) has no room for a path separator, so it rules out traversal on its own.
  `clipName()` is pure and is tested against `%2f`-style encoded forms, since a plain `../` is
  normalized away by `fetch` on the client side before it would ever reach the server. Startup
  validates `TTS_PROVIDER` against `Google`/`Amazon`/`ElevenLabs` and requires it to be set
  together with `TTS_VOICE` or not at all — Twilio itself allows a provider with no voice, but
  requiring both here was our choice. `HttpDeps.audioDir` was dropped as a separate field; `deps.config`
  is the one source of the audio directory. Startup coverage logging reuses `coverage()`/
  `readRecorded()` from `sheet.ts` rather than duplicating that logic; the missing-clip list is
  truncated at 10 entries, the stale line only prints when non-empty, and an unreadable
  `recorded.json` is logged and ignored rather than failing startup. `.env.example`'s Fish Audio
  comment was reworded, since Fish Audio is not a ConversationRelay TTS provider and the original
  "same voice" advice didn't apply.
- **Task 6 (0d9bbcb, c0274d2).** `coverage(rows, clips, recorded)` reads the `recorded.json`
  sidecar and reports a `stale` list; `check` exits 1 on any missing or stale clip. `checkReport`
  was extracted from the CLI so its lines and exit code are unit-tested without capturing stdout,
  and the CLI entry point wraps `main()` in a try/catch like the other CLIs. Add-on tests: a stray
  clip file for a punctuation-only segment is ignored rather than reported as coverage; `runTurn`
  forwards the render context through to frame rendering; `RunOptions.render` is documented as
  server-only (the text harness never sets it).
- **Task 7 (4f6267a, 750bfb2).** `resolveVoice` matches a Fish Audio model title exactly, with no
  first-item fallback when the title isn't found. A dry run makes zero network calls even with an
  API key exported, and prints `would generate N` instead of the real summary line. The
  `recorded.json` sidecar is merged and written after each successful clip rather than batched at
  the end, so a partial run doesn't lose already-generated clips; a corrupt sidecar logs a warning
  and starts fresh rather than failing the run. All file writes (clips and the sidecar) go through
  a temp-file-plus-rename so a reader never sees a partial file. A 200 response is validated
  before being written: non-empty, and carrying the RIFF magic bytes for `wav`. `--only` with an
  unknown clip id throws rather than silently generating nothing; `--candidates` must be an
  integer from 1 to 20. `tags.json` carries a tag for every recordable clip id, checked by a test.
  Open segments (whose fixed clip precedes a variable) get `, continuing` appended to their tag
  instead of the plan's `, no falling intonation` — a negation is the kind of direction a TTS
  model may ignore or read aloud, so the tag says what to do instead of what not to do. One open
  clip is meant to be auditioned by hand before the full run, to catch the tag being spoken. `.gitignore`
  gained `.env.*` (with `!.env.example` to keep the example file), `*.swp`, `*.swo`, and
  `assets/audio/candidates/`. Deferred, not built: retrying on 429/5xx; `--tag` is only a fallback
  for clip ids missing from `tags.json`; the voice lookup's `page_size=20` is unparameterized; the
  `assets/audio` default directory is repeated across the three CLI entry points rather than
  shared.
- **Follow-up (post-750bfb2, no plan task).** Jason noted the Fish Audio web tool's tag picker
  only offers a documented inventory of 71 `[bracket]` tags, not free-form phrases, so `tags.json`
  is restricted to that inventory (checked into `src/prompts/fishTags.json`, source linked, and
  enforced by a test) for reliability. The `, continuing` suffix from Task 7 is dropped along with
  it — it isn't in the inventory either. Open segments instead get a trailing comma appended to
  the request text itself (a comma being the ordinary way to ask TTS for a non-final contour),
  gated by a new `openComma` request option; `--plain-open` turns it off. `tagBodies()` and
  `validateTags()` are exported so both the tag file and the `--tag` fallback are checked against
  the inventory before any request goes out, in tests and at `main()` startup alike. The sidecar
  still records the clip's plain text, without the comma.

Process: Task 4's commit trailer was amended by the controller.

Final whole-branch review (after Task 8): ready to merge. Follow-ups it raised, not built:
a duplicate clip id (one id in two formats) refuses server startup, which is the spec's rule
but harsh for a stray file; `PlayFrame.interruptible` is not in Twilio's documented play
schema and should be confirmed on the first live call; barge-in across multi-frame prompts
(Task 3 note) and the TTS `replay` (Task 4 note) are the two most audible things to test;
`confirm_intent_explicit` loses its `?` after an intent clip the same way `disambiguate_*`
does, so audition that pair by hand; a dry run prints the voice title as `reference_id`,
not the resolved id. The cassette re-record after the window prompt rewrite is Task 9.
