import type { ThresholdName, Thresholds } from '../core/thresholds';
import { better, equal, flips, type Flips, type Score } from './sweepScore';
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
  /** the descent pass that made this move */
  pass: number;
  before: Score;
  after: Score;
  plateau: { from: number; to: number };
  flips: Flips;
}

/** What `chooseMove` proposes; only the descent knows which pass it belongs to. */
type MoveCandidate = Omit<Move, 'pass'>;

export interface ThresholdRow {
  current: number;
  recommended: number;
  points: GridPoint[];
  cliff: boolean;
  insensitive: boolean;
  /** exactly one grid value is legal here, so there is nothing to learn from the grid */
  pinned: boolean;
  /** the best plateau runs to a grid endpoint, so no move onto it was made */
  unbounded: boolean;
}

export interface SweepResult {
  start: Thresholds;
  final: Thresholds;
  before: Score;
  after: Score;
  moves: Move[];
  table: Partial<Record<ThresholdName, ThresholdRow>>;
  passes: number;
  /** true when a pass made no improving move; false when `maxPasses` cut a still-improving descent short */
  converged: boolean;
  /** distinct candidates evaluated (the memo's size) */
  evaluations: number;
}

export interface MoveChoice {
  move: MoveCandidate | null;
  cliff: boolean;
  insensitive: boolean;
  pinned: boolean;
  unbounded: boolean;
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

/** The grid index closest to `value`; ties take the lower index. */
function nearestIndex(points: GridPoint[], value: number): number {
  let index = 0;
  let closest = Infinity;
  points.forEach((p, i) => {
    const d = Math.abs(p.value - value);
    if (d < closest) { closest = d; index = i; }
  });
  return index;
}

/**
 * The move this threshold's grid argues for, or why there is none. `allowCenter` is false once
 * the descent has already re-centred this threshold: a centre move is a one-off tidy-up, not
 * something to repeat every pass.
 */
export function chooseMove(
  name: ThresholdName,
  current: number,
  points: GridPoint[],
  currentScore: Score,
  allowCenter: boolean,
): MoveChoice {
  const none: MoveChoice = { move: null, cliff: false, insensitive: false, pinned: false, unbounded: false };
  // A hand-edited thresholds.ts can hold a value that is not on the grid. The tie-breaks (which
  // plateau holds the current value, which is nearest, whether it sits on a plateau edge) need a
  // position on the grid, so an off-grid value snaps to the nearest index for those. `Move.from`
  // still reports the true current value and the "already there" test below stays an exact
  // comparison, so an off-grid value is never mistaken for the grid point it rounds to.
  const exactIndex = points.findIndex((p) => Math.abs(p.value - current) < 1e-9);
  const currentIndex = exactIndex >= 0 ? exactIndex : nearestIndex(points, current);
  const plateau = bestPlateau(points, currentIndex);
  if (!plateau) return none;
  const scoredPoints = points.filter(scored);
  // One legal value is not evidence that the threshold does not matter: the constraints (or the
  // stub invariant) left nothing to compare it against, so it is pinned rather than insensitive.
  if (scoredPoints.length < 2) return { ...none, pinned: true };
  if (scoredPoints.every((p) => equal(p.score, scoredPoints[0]!.score))) return { ...none, insensitive: true };
  if (plateau.start === plateau.end) return { ...none, cliff: true };
  // A best plateau that runs to a grid endpoint is not evidence of an optimum: the score may
  // still be climbing past the last value we can evaluate, and the "middle" of such a run is an
  // artefact of where the grid stops rather than safer ground. No move of any reason is made
  // onto it — a center move changes no score but would still write an unevidenced value into
  // thresholds.ts — so the current value stays and the row is flagged for a human. A plateau
  // bounded by a skipped or stub-breaking point is genuinely bounded: those are real limits,
  // not the edge of what was sampled.
  if (plateau.start === 0 || plateau.end === points.length - 1) return { ...none, unbounded: true };
  const target = middle(plateau);
  const to = points[target]!;
  // Invariant: a plateau's interior is scored by construction (bestPlateau only joins scored
  // points), so `!scored(to)` cannot fire; it is kept so a future change to plateau building
  // fails safe by refusing the move instead of moving onto an unscored value.
  if (!scored(to) || Math.abs(to.value - current) < 1e-9) return none;
  let reason: MoveReason | null = null;
  if (to.score.primary > currentScore.primary) reason = 'primary';
  else if (to.score.primary === currentScore.primary && to.score.secondary > currentScore.secondary) reason = 'secondary';
  else if (allowCenter && equal(to.score, currentScore) && (currentIndex === plateau.start || currentIndex === plateau.end) && plateau.end - plateau.start >= 2) reason = 'center';
  if (!reason) return none;
  return {
    ...none,
    move: {
      name, from: current, to: to.value, reason, before: currentScore, after: to.score,
      plateau: { from: points[plateau.start]!.value, to: points[plateau.end]!.value },
      flips: flips(currentScore, to.score),
    },
  };
}

export async function coordinateDescent(
  evaluate: Evaluate,
  names: readonly ThresholdName[],
  start: Thresholds,
  maxPasses: number,
  onProgress?: (name: ThresholdName, pass: number, index: number, total: number) => void,
): Promise<SweepResult> {
  // Checked before the first evaluation: a start that already violates a constraint would have
  // every candidate on the violated axis skipped, and the sweep would report a recommendation
  // built on a set the runtime forbids.
  const startViolation = violated(start);
  if (startViolation) throw new Error(`the starting thresholds violate ${startViolation}`);
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
  // One centre move per threshold per descent: centring is a free tidy-up onto safer ground, and
  // allowing it every pass would let two thresholds re-centre each other for ever.
  const centred = new Set<ThresholdName>();
  let passes = 0;
  let converged = false;
  for (let pass = 1; pass <= maxPasses; pass++) {
    passes = pass;
    let improved = false;
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
      const choice = chooseMove(name, current[name], points, currentScore, !centred.has(name));
      const move = choice.move;
      if (move) {
        moves.push({ ...move, pass });
        current = { ...current, [name]: move.to };
        currentScore = move.after;
        if (move.reason === 'center') centred.add(name);
        else improved = true;
      }
      table[name] = {
        current: start[name], recommended: current[name], points,
        cliff: choice.cliff, insensitive: choice.insensitive, pinned: choice.pinned, unbounded: choice.unbounded,
      };
    }
    // Only a scoring move earns another pass. A pass whose moves were all centre moves stops the
    // descent: centring never changes the score, and `centred` caps it at one per threshold, so
    // the next pass would re-run the same (cached) evaluations and choose nothing.
    if (!improved) { converged = true; break; }
  }
  return { start, final: current, before: first.score, after: currentScore, moves, table, passes, converged, evaluations: cache.size };
}
