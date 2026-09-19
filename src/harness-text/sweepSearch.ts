import type { ThresholdName, Thresholds } from '../core/thresholds';
import { better, equal, flips, type Score } from './sweepScore';
import { gridFor, violated } from './sweepSpace';

export interface GridPoint {
  value: number;
  status: 'scored' | 'skipped' | 'breaks_stub';
  score: Score | null;
}

export interface Plateau { start: number; end: number }

export type MoveReason = 'primary' | 'secondary' | 'center';

export interface Move {
  name: ThresholdName;
  from: number;
  to: number;
  reason: MoveReason;
  before: Score;
  after: Score;
  plateau: { from: number; to: number };
  flips: { gained: string[]; lost: string[] };
}

export interface ThresholdRow {
  current: number;
  recommended: number;
  points: GridPoint[];
  cliff: boolean;
  insensitive: boolean;
}

export interface SweepResult {
  start: Thresholds;
  final: Thresholds;
  before: Score;
  after: Score;
  moves: Move[];
  table: Partial<Record<ThresholdName, ThresholdRow>>;
  passes: number;
}

export type Evaluate = (candidate: Thresholds) => Promise<{ score: Score; breaksStub: boolean }>;

function scored(p: GridPoint): p is GridPoint & { score: Score } {
  return p.status === 'scored' && p.score !== null;
}

/** Longest contiguous run of scored points at the best score; ties prefer the run holding `currentIndex`, then the nearest. */
export function bestPlateau(points: GridPoint[], currentIndex: number): Plateau | null {
  let best: Score | null = null;
  for (const p of points) if (scored(p) && (best === null || better(p.score, best))) best = p.score;
  if (best === null) return null;
  const runs: Plateau[] = [];
  let start = -1;
  points.forEach((p, i) => {
    const at = scored(p) && equal(p.score, best!);
    if (at && start < 0) start = i;
    if (!at && start >= 0) { runs.push({ start, end: i - 1 }); start = -1; }
  });
  if (start >= 0) runs.push({ start, end: points.length - 1 });
  const longest = Math.max(...runs.map((r) => r.end - r.start));
  const candidates = runs.filter((r) => r.end - r.start === longest);
  const holding = candidates.find((r) => r.start <= currentIndex && currentIndex <= r.end);
  if (holding) return holding;
  const distance = (r: Plateau) => Math.min(Math.abs(r.start - currentIndex), Math.abs(r.end - currentIndex));
  return candidates.sort((a, b) => distance(a) - distance(b))[0]!;
}

function middle(p: Plateau): number {
  return p.start + Math.floor((p.end - p.start) / 2);
}

export function chooseMove(name: ThresholdName, current: number, points: GridPoint[], currentScore: Score): { move: Move | null; cliff: boolean; insensitive: boolean } {
  const currentIndex = points.findIndex((p) => Math.abs(p.value - current) < 1e-9);
  const plateau = bestPlateau(points, currentIndex);
  if (!plateau) return { move: null, cliff: false, insensitive: false };
  const scoredPoints = points.filter(scored);
  const insensitive = scoredPoints.every((p) => equal(p.score, scoredPoints[0]!.score));
  if (insensitive) return { move: null, cliff: false, insensitive: true };
  if (plateau.start === plateau.end) return { move: null, cliff: true, insensitive: false };
  const target = middle(plateau);
  const to = points[target]!;
  if (!scored(to) || Math.abs(to.value - current) < 1e-9) return { move: null, cliff: false, insensitive: false };
  let reason: MoveReason | null = null;
  if (to.score.primary > currentScore.primary) reason = 'primary';
  else if (to.score.primary === currentScore.primary && to.score.secondary > currentScore.secondary) reason = 'secondary';
  else if (equal(to.score, currentScore) && (currentIndex === plateau.start || currentIndex === plateau.end) && plateau.end - plateau.start >= 2) reason = 'center';
  if (!reason) return { move: null, cliff: false, insensitive: false };
  return {
    move: {
      name, from: current, to: to.value, reason, before: currentScore, after: to.score,
      plateau: { from: points[plateau.start]!.value, to: points[plateau.end]!.value },
      flips: flips(currentScore, to.score),
    },
    cliff: false, insensitive: false,
  };
}

export async function coordinateDescent(
  evaluate: Evaluate,
  names: readonly ThresholdName[],
  start: Thresholds,
  maxPasses: number,
  onProgress?: (name: ThresholdName, pass: number, index: number, total: number) => void,
): Promise<SweepResult> {
  const cache = new Map<string, { score: Score; breaksStub: boolean }>();
  const memo = async (t: Thresholds) => {
    const key = JSON.stringify(t);
    let v = cache.get(key);
    if (!v) { v = await evaluate(t); cache.set(key, v); }
    return v;
  };
  let current: Thresholds = { ...start };
  const first = await memo(current);
  if (first.breaksStub) throw new Error('the starting thresholds break the stub baseline; run pnpm regress first');
  let currentScore = first.score;
  const moves: Move[] = [];
  const table: SweepResult['table'] = {};
  let passes = 0;
  for (let pass = 1; pass <= maxPasses; pass++) {
    passes = pass;
    let moved = false;
    for (const name of names) {
      const grid = gridFor(name);
      const points: GridPoint[] = [];
      for (const [i, value] of grid.entries()) {
        onProgress?.(name, pass, i + 1, grid.length);
        const candidate: Thresholds = { ...current, [name]: value };
        if (violated(candidate)) { points.push({ value, status: 'skipped', score: null }); continue; }
        const r = await memo(candidate);
        points.push(r.breaksStub ? { value, status: 'breaks_stub', score: null } : { value, status: 'scored', score: r.score });
      }
      const { move, cliff, insensitive } = chooseMove(name, current[name], points, currentScore);
      if (move) {
        moves.push(move);
        current = { ...current, [name]: move.to };
        currentScore = move.after;
        moved = true;
      }
      table[name] = { current: start[name], recommended: current[name], points, cliff, insensitive };
    }
    if (!moved) break;
  }
  return { start, final: current, before: first.score, after: currentScore, moves, table, passes };
}
