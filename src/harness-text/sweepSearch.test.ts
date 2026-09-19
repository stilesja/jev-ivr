import { describe, expect, it } from 'vitest';
import { bestPlateau, chooseMove, coordinateDescent, type GridPoint } from './sweepSearch';
import type { Score } from './sweepScore';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../core/thresholds';

function score(primary: number, secondary = 0, matched: string[] = []): Score {
  return { primary, secondary, corpusMatch: primary, scenarioPass: 0, cosmeticMatch: secondary, matched: new Set(matched), misses: [] };
}
/** One point per value: a number is that primary, 'x' a constraint skip, '!' a stub break. */
function points(values: number[], primaries: Array<number | 'x' | '!'>, secondaries: number[] = [], matched: string[][] = []): GridPoint[] {
  return values.map((value, i) => {
    const p = primaries[i]!;
    if (p === 'x') return { value, status: 'skipped', score: null };
    if (p === '!') return { value, status: 'breaks_stub', score: null };
    return { value, status: 'scored', score: score(p, secondaries[i] ?? 0, matched[i] ?? []) };
  });
}
const grid = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];

describe('bestPlateau', () => {
  it('picks the longest run at the best score', () => {
    const p = points(grid, [1, 3, 3, 3, 2, 3, 1]);
    expect(bestPlateau(p, 0)).toEqual({ start: 1, end: 3 });
  });
  it('prefers the run containing the current index, then the nearest', () => {
    const p = points(grid, [3, 3, 1, 3, 3, 1, 1]);
    expect(bestPlateau(p, 4)).toEqual({ start: 3, end: 4 });
    expect(bestPlateau(p, 6)).toEqual({ start: 3, end: 4 });
    expect(bestPlateau(p, 0)).toEqual({ start: 0, end: 1 });
  });
  it('ignores skipped and stub-breaking points and breaks primary ties by secondary', () => {
    const p = points(grid, ['x', 3, 3, '!', 3, 3, 3], [0, 1, 1, 0, 0, 0, 0]);
    expect(bestPlateau(p, 1)).toEqual({ start: 1, end: 2 });
  });
  it('returns null when nothing scored', () => {
    expect(bestPlateau(points(grid, ['x', 'x', '!', 'x', 'x', 'x', 'x']), 0)).toBeNull();
  });
});

describe('chooseMove', () => {
  const current = score(2);
  it('moves to the plateau middle when primary improves, lower-middle on an even run', () => {
    const r = chooseMove('INTENT_ROUTE', 0.7, points(grid, [1, 3, 3, 3, 3, 2, 2]), current, true);
    expect(r.move).toMatchObject({ from: 0.7, to: 0.3, reason: 'primary' });
    expect(r.cliff).toBe(false);
  });
  it('reports the plateau it moved onto and the ids the move flips', () => {
    const before = score(2, 0, ['a', 'b']);
    const p = points(grid, [1, 1, 3, 3, 3, 1, 1], [], [[], [], ['a', 'c'], ['a', 'c'], ['a', 'c'], [], []]);
    const r = chooseMove('INTENT_ROUTE', 0.7, p, before, true);
    expect(r.move).toMatchObject({ to: 0.4, reason: 'primary', plateau: { from: 0.3, to: 0.5 } });
    expect(r.move?.flips).toEqual({ gained: ['c'], lost: ['b'] });
  });
  it('moves on a secondary improvement at equal primary', () => {
    const r = chooseMove('INTENT_ROUTE', 0.7, points(grid, [2, 2, 2, 2, 2, 2, 2], [0, 1, 1, 1, 0, 0, 0]), current, true);
    expect(r.move).toMatchObject({ to: 0.3, reason: 'secondary' });
  });
  it('moves an edge value to the plateau center at equal scores, unless centering is spent', () => {
    const p = points(grid, [1, 1, 2, 2, 2, 1, 1]);
    expect(chooseMove('INTENT_ROUTE', 0.5, p, current, true).move).toMatchObject({ from: 0.5, to: 0.4, reason: 'center' });
    expect(chooseMove('INTENT_ROUTE', 0.5, p, current, false).move).toBeNull();
  });
  it('centers a value that is not on the grid, keeping the true value as the move origin', () => {
    // 0.42 snaps to 0.40, the low edge of the 0.40..0.60 plateau, so it centers on 0.50.
    const r = chooseMove('INTENT_ROUTE', 0.42, points(grid, [1, 1, 1, 2, 2, 2, 1]), current, true);
    expect(r.move).toMatchObject({ from: 0.42, to: 0.5, reason: 'center' });
  });
  it('does not move from a plateau center or a two-point plateau', () => {
    expect(chooseMove('INTENT_ROUTE', 0.4, points(grid, [1, 1, 2, 2, 2, 1, 1]), current, true).move).toBeNull();
    expect(chooseMove('INTENT_ROUTE', 0.4, points(grid, [1, 1, 2, 2, 1, 1, 1]), current, true).move).toBeNull();
  });
  it('never moves to a cliff and reports it', () => {
    const r = chooseMove('INTENT_ROUTE', 0.7, points(grid, [1, 1, 1, 5, 1, 2, 2]), current, true);
    expect(r.move).toBeNull();
    expect(r.cliff).toBe(true);
  });
  it('flags an insensitive threshold and does not move it', () => {
    const r = chooseMove('INTENT_ROUTE', 0.1, points(grid, [2, 2, 2, 2, 2, 2, 2]), current, true);
    expect(r.move).toBeNull();
    expect(r.insensitive).toBe(true);
  });
  it('flags a single legal value as pinned rather than insensitive or a cliff', () => {
    const r = chooseMove('INTENT_ROUTE', 0.4, points(grid, ['x', 'x', 'x', 2, '!', '!', '!']), current, true);
    expect(r.move).toBeNull();
    expect(r.pinned).toBe(true);
    expect(r.insensitive).toBe(false);
    expect(r.cliff).toBe(false);
  });
  it('refuses a scoring move onto a plateau that runs off the end of the grid', () => {
    const r = chooseMove('INTENT_ROUTE', 0.1, points(grid, [1, 1, 3, 3, 3, 3, 3]), current, true);
    expect(r.move).toBeNull();
    expect(r.unbounded).toBe(true);
  });
  it('refuses a center move onto an edge-touching plateau too, leaving the value alone', () => {
    // The plateau runs off the low end, so its middle is an artefact of where the grid stops.
    const r = chooseMove('INTENT_ROUTE', 0.1, points(grid, [2, 2, 2, 2, 1, 1, 1]), current, true);
    expect(r.move).toBeNull();
    expect(r.unbounded).toBe(true);
  });
  it('treats a plateau bounded by a skipped or stub-breaking point as bounded', () => {
    const r = chooseMove('INTENT_ROUTE', 0.1, points(grid, [1, 1, 3, 3, 3, 3, '!']), current, true);
    expect(r.move).toMatchObject({ to: 0.4, reason: 'primary' });
    expect(r.unbounded).toBe(false);
  });
});

describe('coordinateDescent', () => {
  // Two unconstrained thresholds with optima at 0.5 and 0.6. Dividing the distance by 3 before
  // rounding makes each best score a five-point plateau, so the plateau-center rule lands
  // exactly on the optimum rather than refusing a one-point cliff.
  const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const peak = async (t: Thresholds) => {
    const primary =
      10 -
      Math.round(round6((Math.abs(t.GATE_ADDRESSED - 0.5) * 10) / 3)) -
      Math.round(round6((Math.abs(t.MENU_NUMBER - 0.6) * 10) / 3));
    return { score: score(primary), breaksStub: t.GATE_ADDRESSED > 0.9 };
  };

  it('applies moves in order across passes until nothing changes', async () => {
    const calls: string[] = [];
    const r = await coordinateDescent(peak, ['GATE_ADDRESSED', 'MENU_NUMBER'], { ...DEFAULT_THRESHOLDS }, 5, (name) => calls.push(name));
    expect(r.final.GATE_ADDRESSED).toBeCloseTo(0.5);
    expect(r.final.MENU_NUMBER).toBeCloseTo(0.6);
    expect(r.moves.map((m) => [m.name, m.reason, m.pass])).toEqual([['GATE_ADDRESSED', 'primary', 1], ['MENU_NUMBER', 'center', 1]]);
    expect(r.passes).toBe(2);
    expect(r.converged).toBe(true);
    expect(r.table.GATE_ADDRESSED?.points.some((p) => p.status === 'breaks_stub')).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('evaluates each distinct candidate once and counts them', async () => {
    const seen: string[] = [];
    const counted = async (t: Thresholds) => { seen.push(JSON.stringify(t)); return peak(t); };
    const r = await coordinateDescent(counted, ['GATE_ADDRESSED'], { ...DEFAULT_THRESHOLDS }, 5, undefined);
    expect(r.passes).toBeGreaterThan(1);                  // a second pass re-asks the whole grid
    expect(new Set(seen).size).toBe(seen.length);         // yet nothing was evaluated twice
    expect(r.evaluations).toBe(seen.length);
  });

  it('reports a descent cut short by maxPasses as not converged', async () => {
    const r = await coordinateDescent(peak, ['GATE_ADDRESSED', 'MENU_NUMBER'], { ...DEFAULT_THRESHOLDS }, 1, undefined);
    expect(r.passes).toBe(1);
    expect(r.converged).toBe(false);
  });

  it('centers a threshold at most once when the best bands chase each other', async () => {
    // MENU_NUMBER scores best in a narrow band 0.10..0.20 below GATE_ADDRESSED, so every move of
    // GATE_ADDRESSED drags MENU_NUMBER's plateau out from under it; GATE_ADDRESSED itself is paid
    // for sitting at or below 0.40. Both plateaus stay inside the grid, so center moves are on
    // offer, and only the one-center-per-threshold cap and the improving-move rule end the chase.
    const chase = async (t: Thresholds) => {
      const a = Math.round(t.GATE_ADDRESSED / 0.05), b = Math.round(t.MENU_NUMBER / 0.05);
      const inBand = b >= a - 4 && b <= a - 2;
      return { score: score(5 + (inBand ? 1 : 0) + (a <= 8 ? 1 : 0)), breaksStub: false };
    };
    const start = { ...DEFAULT_THRESHOLDS, GATE_ADDRESSED: 0.7, MENU_NUMBER: 0.25 };
    const r = await coordinateDescent(chase, ['GATE_ADDRESSED', 'MENU_NUMBER'], start, 5, undefined);
    const centers = r.moves.filter((m) => m.reason === 'center');
    expect(r.passes).toBe(2);
    expect(r.converged).toBe(true);
    expect(centers.length).toBeGreaterThan(0);
    expect(centers.length).toBeLessThanOrEqual(2);
    expect(new Set(centers.map((m) => m.name)).size).toBe(centers.length);   // never twice for one threshold
  });

  it('refuses to start from thresholds that violate a constraint or break the stub', async () => {
    let called = 0;
    const counting = async (t: Thresholds) => { called += 1; return peak(t); };
    await expect(coordinateDescent(counting, ['INTENT_ROUTE'], { ...DEFAULT_THRESHOLDS, INTENT_SWITCH: 0.7 }, 5))
      .rejects.toThrow('the starting thresholds violate INTENT_ROUTE <= INTENT_SWITCH');
    expect(called).toBe(0);
    await expect(coordinateDescent(async () => ({ score: score(0), breaksStub: true }), ['INTENT_ROUTE'], { ...DEFAULT_THRESHOLDS }, 5))
      .rejects.toThrow(/break the stub baseline/);
  });
});
