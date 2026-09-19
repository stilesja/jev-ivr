import { readdirSync } from 'node:fs';
import manifest from './manifest.json';
import { isPauseOnly, segmentsOf, stripLeadingPause, VOCAB_VARS } from './segments';
import { PROVIDERS } from '../domain/slots/provider';
import { FORM_INTENTS, INTENT_LABELS } from '../domain/intents';
import { describeWindow, MONTHS, WINDOWS } from '../core/extract/date';

/** wav/mp3 file extension → content type. Task 5 lowercases a discovered filename's extension before looking this up, so keys stay lowercase here even though discovery itself is case-insensitive. */
export const AUDIO_TYPES: Readonly<Record<string, string>> = { wav: 'audio/wav', mp3: 'audio/mpeg' };
/** Filename shape a recorded clip must match: id, dot, extension (wav/mp3, case-insensitive). Shared with src/server/http.ts, which serves clips under this same shape. */
export const CLIP_FILE = new RegExp(`^([A-Za-z0-9_.-]+)\\.(${Object.keys(AUDIO_TYPES).join('|')})$`, 'i');

/** clip id → filename, from the directory listing; a missing directory is an empty index. */
export function discoverClips(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return out;
    throw err;
  }
  const names = entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name).sort();
  for (const name of names) {
    const m = CLIP_FILE.exec(name);
    if (!m) continue;
    const id = m[1]!;
    const prev = out.get(id);
    if (prev) throw new Error(`clip ${id} is recorded twice: ${prev} and ${name}`);
    out.set(id, name);
  }
  return out;
}

const VOCAB_INTENTS = FORM_INTENTS;
/**
 * Window labels the date code can produce (`describeWindow` in core/extract/date.ts):
 * every non-"none" relative window plus "in <Month>" for a bare month with no day, derived
 * by running each through `describeWindow` itself so this can't drift from that logic.
 */
const WINDOW_LABELS: readonly string[] = [
  ...WINDOWS.filter((label) => label !== 'none').map((label) => describeWindow({ start: '', end: '', label })),
  ...MONTHS.map((label) => describeWindow({ start: '', end: '', label })),
];

function windowId(display: string): string {
  return `window.${display.toLowerCase().replace(/ /g, '_')}`;
}

/** The clip id for a vocabulary variable's display value, or null when it is spoken by TTS. */
export function vocabularyClipId(name: string, display: string): string | null {
  if (!VOCAB_VARS.has(name)) return null;
  const provider = PROVIDERS.find((p) => `Dr. ${p.name}` === display);
  if (provider && (name === 'provider' || name === 'a' || name === 'b')) return `provider.${provider.key}`;
  const intent = VOCAB_INTENTS.find((i) => INTENT_LABELS[i] === display);
  if (intent && (name === 'intentLabel' || name === 'a' || name === 'b')) return `intent.${intent}`;
  if (name === 'window' && WINDOW_LABELS.includes(display)) return windowId(display);
  return null;
}

export interface RecordableClip { id: string; text: string; note: 'open' | 'closed' }

/**
 * Every clip the manifest and vocabularies can use, each once, with the text to record.
 *
 * A fixed segment that is only punctuation (e.g. the "." left over from "With {provider}.")
 * has nothing left to say once its leading punctuation is stripped; segmentsOf still keeps
 * that segment (the renderer needs it to merge text back together), but it is not a
 * recordable row here.
 */
export function recordableClips(): RecordableClip[] {
  const rows: RecordableClip[] = [];
  for (const segments of Object.values(segmentsOf(manifest))) {
    segments.forEach((s, i) => {
      if (s.kind !== 'fixed' || isPauseOnly(s.text)) return;
      const next = segments[i + 1];
      rows.push({ id: s.id, text: stripLeadingPause(s.text), note: next?.kind === 'var' ? 'open' : 'closed' });
    });
  }
  for (const p of PROVIDERS) rows.push({ id: `provider.${p.key}`, text: `Dr. ${p.name}`, note: 'closed' });
  for (const i of VOCAB_INTENTS) rows.push({ id: `intent.${i}`, text: INTENT_LABELS[i], note: 'closed' });
  for (const w of WINDOW_LABELS) rows.push({ id: windowId(w), text: w, note: 'closed' });
  return rows;
}
