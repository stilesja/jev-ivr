import { existsSync, readdirSync } from 'node:fs';
import manifest from './manifest.json';
import { segmentsOf, VOCAB_VARS } from './segments';
import type { PromptEntry, PromptId } from './render';
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
/**
 * Window labels the date code can produce (`describeWindow` in core/extract/date.ts):
 * the four relative windows (`this_week`, `next_week`, `this_month`, `next_month`) plus
 * "in <Month>" for a bare month with no day.
 */
const WINDOW_LABELS: readonly string[] = [
  'next week', 'this week', 'this month', 'next month',
  ...MONTHS.map((m) => `in ${m[0]!.toUpperCase()}${m.slice(1)}`),
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

/** Text a person records for a fixed segment: the template text without its leading punctuation. */
function recordingText(text: string): string {
  return text.replace(/^[,.?!;:]\s*/, '');
}

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
  for (const segments of Object.values(segmentsOf(manifest as Record<PromptId, PromptEntry>))) {
    segments.forEach((s, i) => {
      if (s.kind !== 'fixed') return;
      const text = recordingText(s.text);
      if (!text) return;
      const next = segments[i + 1];
      rows.push({ id: s.id, text, note: next?.kind === 'var' ? 'open' : 'closed' });
    });
  }
  for (const p of PROVIDERS) rows.push({ id: `provider.${p.key}`, text: `Dr. ${p.name}`, note: 'closed' });
  for (const i of VOCAB_INTENTS) rows.push({ id: `intent.${i}`, text: INTENT_LABELS[i], note: 'closed' });
  for (const w of WINDOW_LABELS) rows.push({ id: windowId(w), text: w, note: 'closed' });
  return rows;
}
