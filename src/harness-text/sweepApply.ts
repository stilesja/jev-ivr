import type { ThresholdName } from '../core/thresholds';
import { better, equal, type Score } from './sweepScore';
import type { GridPoint, SweepResult, ThresholdRow } from './sweepSearch';

/** Replace the numeric literal on each named key's line inside DEFAULT_THRESHOLDS; everything else is untouched. */
export function rewriteThresholds(source: string, values: Partial<Record<ThresholdName, number>>): string {
  let out = source;
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^(\\s*${key}:\\s*)([0-9.]+)(,)`, 'gm');
    const matches = out.match(re) ?? [];
    if (matches.length !== 1) throw new Error(`${key} must appear exactly once in DEFAULT_THRESHOLDS (found ${matches.length})`);
    out = out.replace(re, `$1${value}$3`);
  }
  return out;
}

function bestOf(points: GridPoint[]): Score | null {
  let best: Score | null = null;
  for (const p of points) if (p.status === 'scored' && p.score && (best === null || better(p.score, best))) best = p.score;
  return best;
}

/** One character per grid point: # best, + within one primary of best, - below, x constraint-skipped, ! breaks the stub. */
export function renderStrip(points: GridPoint[]): string {
  const best = bestOf(points);
  return points.map((p) => {
    if (p.status === 'skipped') return 'x';
    if (p.status === 'breaks_stub') return '!';
    if (!best || !p.score) return '?';
    if (equal(p.score, best)) return '#';
    return p.score.primary >= best.primary - 1 ? '+' : '-';
  }).join('');
}

const f = (n: number): string => n.toFixed(2);

export function renderTable(r: SweepResult): string {
  const names = Object.keys(r.table) as ThresholdName[];
  const w = Math.max(...names.map((n) => n.length), 9);
  const lines = [`${'threshold'.padEnd(w)}  current  recomm.  best  grid`];
  for (const name of names) {
    const row = r.table[name]!;
    const best = bestOf(row.points);
    const note = row.pinned ? '  pinned' : row.insensitive ? '  insensitive' : row.unbounded ? '  unbounded' : row.cliff ? '  cliff' : '';
    lines.push(`${name.padEnd(w)}  ${f(row.current).padStart(7)}  ${f(row.recommended).padStart(7)}  ${String(best?.primary ?? '-').padStart(4)}  ${renderStrip(row.points)}${note}`);
  }
  return lines.join('\n');
}

export function renderMoves(r: SweepResult): string {
  if (r.moves.length === 0) return 'no moves';
  return r.moves.map((m) => [
    `pass ${m.pass}: ${m.name} ${f(m.from)} -> ${f(m.to)} (${m.reason}; plateau ${f(m.plateau.from)}..${f(m.plateau.to)}) ${m.before.primary}/${m.before.secondary} -> ${m.after.primary}/${m.after.secondary}`,
    m.flips.gained.length ? `  gained: ${m.flips.gained.join(', ')}` : null,
    m.flips.lost.length ? `  lost: ${m.flips.lost.join(', ')}` : null,
  ].filter(Boolean).join('\n')).join('\n');
}

export interface ReportMeta { cassette: string; requests: number; date: string; misses: Array<{ id: string; text: string }> }

export function renderReport(r: SweepResult, meta: ReportMeta): string {
  const named = (pick: (row: ThresholdRow) => boolean) => (Object.keys(r.table) as ThresholdName[]).filter((n) => pick(r.table[n]!));
  const cliffs = named((row) => row.cliff);
  const insensitive = named((row) => row.insensitive);
  const unbounded = named((row) => row.unbounded);
  return [
    `# Threshold sweep ${meta.date}`,
    '',
    `Cassette \`${meta.cassette}\` (${meta.requests} recorded requests). Scores are primary/secondary: corpus decisions matched plus scenarios passed / cosmetic matches.`,
    '',
    `before ${r.before.primary}/${r.before.secondary}`,
    `after ${r.after.primary}/${r.after.secondary}`,
    `passes ${r.passes} (${r.converged ? 'converged' : 'not converged'})`,
    `evaluations ${r.evaluations}`,
    '',
    '## Moves', '', '```', renderMoves(r), '```', '',
    '## Sensitivity', '', '```', renderTable(r), '```', '',
    `Strip: # best, + within one of best, - below, x constraint-skipped, ! breaks the stub baseline.`, '',
    `## Cliffs (not applied)`, '', cliffs.length ? cliffs.map((n) => `- ${n}`).join('\n') : '- none', '',
    `## Insensitive on this corpus`, '', insensitive.length ? insensitive.map((n) => `- ${n}`).join('\n') : '- none', '',
    `## Unbounded (plateau reaches a grid edge; not applied)`, '', unbounded.length ? unbounded.map((n) => `- ${n}`).join('\n') : '- none', '',
    `## Cassette misses to record for the recommended set`, '',
    meta.misses.length ? meta.misses.map((m) => `- ${m.id}: "${m.text}"`).join('\n') : '- none', '',
  ].join('\n');
}
