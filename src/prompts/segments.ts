import type { PromptEntry, PromptId } from './render';

export type Segment =
  | { kind: 'fixed'; id: string; text: string }
  | { kind: 'var'; name: string };

/** Variables that are always spoken by TTS (composed values with no clip). */
export const SPOKEN_VARS: ReadonlySet<string> = new Set(['memberId', 'date']);

/** Variables with a fixed vocabulary of display values, each recordable as a clip. */
export const VOCAB_VARS: ReadonlySet<string> = new Set(['provider', 'intentLabel', 'window', 'a', 'b']);

/** The one template grammar: a `{name}` placeholder. Global; use only via matchAll/replace, never .test()/.exec(). */
export const VAR = /\{(\w+)\}/g;
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

export function segmentsOf(manifest: Record<PromptId, PromptEntry>): Record<PromptId, Segment[]> {
  return Object.fromEntries(
    Object.entries(manifest).map(([id, entry]) => [id, segmentTemplate(id, entry.text)]),
  ) as Record<PromptId, Segment[]>;
}

/**
 * Join already-substituted pieces the way the templates space them: one space between
 * pieces, none before a piece that starts with punctuation. This is the inverse of the
 * trimming segmentTemplate does to fixed runs, so Task 3 (playing recorded clips with a
 * TTS fallback for variables) can reassemble spoken text from segments the same way
 * renderTemplate assembles it from a single template string.
 */
export function joinSpoken(pieces: string[]): string {
  let out = '';
  for (const p of pieces) {
    if (!p) continue;
    out += out === '' || PAUSE.test(p) ? p : ` ${p}`;
  }
  return out;
}

/**
 * Spec §3: a TTS span inside a recorded sentence is the audible seam, so a spoken variable
 * must end its clause. Vocabulary variables sit between clips and are free.
 *
 * Only the "followed by punctuation or end" half of spec §3 is enforced here. The other
 * half — a spoken variable preceded by a pause — is deliberately not checked: that seam
 * (e.g. "Your member ID is" -> number) exists in every readback prompt in the manifest, so
 * enforcing it would flag the normal case rather than a real problem.
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
