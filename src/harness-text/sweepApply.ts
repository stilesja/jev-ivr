import type { ThresholdName } from '../core/thresholds';
import { better, equal, type Score } from './sweepScore';
import type { GridPoint, SweepResult, ThresholdRow } from './sweepSearch';
import { EXCLUDED } from './sweepSpace';

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

const STRIP_LEGEND = '# best, + the same decisions with a worse tiebreak, ~ one decision below best, - further below, x constraint-skipped, ! breaks the stub baseline';

/**
 * One character per grid point. `+` and `~` are kept apart because they say different things: a
 * `+` costs only a tiebreak, while a `~` is a decision the corpus says this value gets wrong. A
 * strip of `#` and `+` alone means the corpus never sees this threshold change an answer.
 */
export function renderStrip(points: GridPoint[]): string {
  const best = bestOf(points);
  return points.map((p) => {
    if (p.status === 'skipped') return 'x';
    if (p.status === 'breaks_stub') return '!';
    if (!best || !p.score) return '?';
    if (equal(p.score, best)) return '#';
    if (p.score.primary === best.primary) return '+';
    return p.score.primary === best.primary - 1 ? '~' : '-';
  }).join('');
}

const f = (n: number): string => n.toFixed(2);

export function renderTable(r: SweepResult): string {
  const names = Object.keys(r.table) as ThresholdName[];
  const w = Math.max(...names.map((n) => n.length), 9);
  const lines = [`${'threshold'.padEnd(w)}  ${'start'.padStart(7)}  ${'recomm.'.padStart(7)}  best  grid`];
  for (const name of names) {
    const row = r.table[name]!;
    const best = bestOf(row.points);
    const shape = row.pinned ? 'pinned' : row.insensitive ? 'insensitive' : row.unbounded ? 'unbounded' : row.cliff ? 'cliff' : '';
    // A threshold only reaches the table when it was swept, so `excluded` here means --only asked
    // for one the default set leaves out; the reason is in the report's own section.
    const note = [EXCLUDED[name] ? 'excluded' : '', shape].filter(Boolean).join(' ');
    lines.push(`${name.padEnd(w)}  ${f(row.current).padStart(7)}  ${f(row.recommended).padStart(7)}  ${String(best?.primary ?? '-').padStart(4)}  ${renderStrip(row.points)}${note ? `  ${note}` : ''}`);
  }
  return lines.join('\n');
}

export function renderMoves(r: SweepResult): string {
  if (r.moves.length === 0) return 'no moves';
  return r.moves.map((m) => [
    `pass ${m.pass}: ${m.name} ${f(m.from)} -> ${f(m.to)} (${m.reason}; plateau ${f(m.plateau.from)}..${f(m.plateau.to)}) ${m.before.primary}/${m.before.secondary} -> ${m.after.primary}/${m.after.secondary}`,
    m.flips.gained.length ? `  gained: ${m.flips.gained.join(', ')}` : null,
    m.flips.lost.length ? `  lost: ${m.flips.lost.join(', ')}` : null,
    m.flips.cosmeticGained.length ? `  cosmetic gained: ${m.flips.cosmeticGained.join(', ')}` : null,
    m.flips.cosmeticLost.length ? `  cosmetic lost: ${m.flips.cosmeticLost.join(', ')}` : null,
  ].filter(Boolean).join('\n')).join('\n');
}

export interface ReportMeta {
  cassette: string;
  requests: number;
  date: string;
  /** corpus entries scored, for the score denominator */
  corpusCount: number;
  /** scenarios scored, for the score denominator */
  scenarioCount: number;
  misses: Array<{ id: string; text: string }>;
}

export function renderReport(r: SweepResult, meta: ReportMeta): string {
  const named = (pick: (row: ThresholdRow) => boolean) => (Object.keys(r.table) as ThresholdName[]).filter((n) => pick(r.table[n]!));
  const cliffs = named((row) => row.cliff);
  const insensitive = named((row) => row.insensitive);
  const unbounded = named((row) => row.unbounded);
  const excluded = Object.keys(EXCLUDED) as ThresholdName[];
  const total = meta.corpusCount + meta.scenarioCount;
  return [
    `# Threshold sweep ${meta.date}`,
    '',
    `Cassette \`${meta.cassette}\` (${meta.requests} recorded requests). Scores are primary/secondary out of ${total} (${meta.corpusCount} corpus entries + ${meta.scenarioCount} scenarios) / ${total}: corpus decisions matched plus scenarios passed / cosmetic matches.`,
    '',
    `before ${r.before.primary}/${r.before.secondary}`,
    `after ${r.after.primary}/${r.after.secondary}`,
    `passes ${r.passes} (${r.converged ? 'converged' : 'not converged'})`,
    `evaluations ${r.evaluations}`,
    '',
    '## Moves', '', '```', renderMoves(r), '```', '',
    '## Sensitivity', '', '```', renderTable(r), '```', '',
    `Strip: ${STRIP_LEGEND}.`, '',
    `## Cliffs (not applied)`, '', cliffs.length ? cliffs.map((n) => `- ${n}`).join('\n') : '- none', '',
    `## Insensitive on this corpus`, '', insensitive.length ? insensitive.map((n) => `- ${n}`).join('\n') : '- none', '',
    `## Unbounded (plateau reaches a grid edge; not applied)`, '', unbounded.length ? unbounded.map((n) => `- ${n}`).join('\n') : '- none', '',
    `## Excluded by judgment`, '',
    excluded.length ? excluded.map((n) => `- \`${n}\`: ${EXCLUDED[n]}`).join('\n') : '- none', '',
    `## Cassette misses to record for the recommended set`, '',
    meta.misses.length ? meta.misses.map((m) => `- ${m.id}: "${m.text}"`).join('\n') : '- none', '',
  ].join('\n');
}
