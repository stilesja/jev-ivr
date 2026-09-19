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
