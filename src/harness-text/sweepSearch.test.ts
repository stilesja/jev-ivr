import { describe, expect, it } from 'vitest';
import { bestPlateau, chooseMove, coordinateDescent, type GridPoint } from './sweepSearch';
import type { Score } from './sweepScore';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../core/thresholds';

function score(primary: number, secondary = 0, matched: string[] = []): Score {
  return { primary, secondary, corpusMatch: primary, scenarioPass: 0, cosmeticMatch: secondary, matched: new Set(matched), misses: [] };
}
function points(values: number[], primaries: Array<number | 'x' | '!'>, secondaries: number[] = []): GridPoint[] {
  return values.map((value, i) => {
    const p = primaries[i]!;
    if (p === 'x') return { value, status: 'skipped', score: null };
    if (p === '!') return { value, status: 'breaks_stub', score: null };
    return { value, status: 'scored', score: score(p, secondaries[i] ?? 0) };
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
    const r = chooseMove('INTENT_ROUTE', 0.7, points(grid, [1, 3, 3, 3, 3, 2, 2]), current);
    expect(r.move).toMatchObject({ from: 0.7, to: 0.3, reason: 'primary' });
    expect(r.cliff).toBe(false);
  });
  it('moves on a secondary improvement at equal primary', () => {
    const r = chooseMove('INTENT_ROUTE', 0.7, points(grid, [2, 2, 2, 2, 2, 2, 2], [0, 1, 1, 1, 0, 0, 0]), current);
    expect(r.move).toMatchObject({ to: 0.3, reason: 'secondary' });
  });
  it('moves an edge value to the plateau center at equal scores', () => {
    const r = chooseMove('INTENT_ROUTE', 0.5, points(grid, [1, 1, 2, 2, 2, 1, 1]), current);
    expect(r.move).toMatchObject({ from: 0.5, to: 0.4, reason: 'center' });
  });
  it('does not move from a plateau center or a two-point plateau', () => {
    expect(chooseMove('INTENT_ROUTE', 0.4, points(grid, [1, 1, 2, 2, 2, 1, 1]), current).move).toBeNull();
    expect(chooseMove('INTENT_ROUTE', 0.4, points(grid, [1, 1, 2, 2, 1, 1, 1]), current).move).toBeNull();
  });
  it('never moves to a cliff and reports it', () => {
    const r = chooseMove('INTENT_ROUTE', 0.7, points(grid, [1, 1, 1, 5, 1, 2, 2]), current);
    expect(r.move).toBeNull();
    expect(r.cliff).toBe(true);
  });
  it('flags an insensitive threshold and does not move it', () => {
    const r = chooseMove('INTENT_ROUTE', 0.1, points(grid, [2, 2, 2, 2, 2, 2, 2]), current);
    expect(r.move).toBeNull();
    expect(r.insensitive).toBe(true);
  });
});

describe('coordinateDescent', () => {
  it('applies moves in order across passes until nothing changes', async () => {
    // Two unconstrained thresholds with optima at 0.5 and 0.6. Dividing the distance by 3 before
    // rounding makes each best score a five-point plateau, so the plateau-center rule lands
    // exactly on the optimum rather than refusing a one-point cliff.
    const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
    const evaluate = async (t: Thresholds) => {
      const primary =
        10 -
        Math.round(round6((Math.abs(t.GATE_ADDRESSED - 0.5) * 10) / 3)) -
        Math.round(round6((Math.abs(t.MENU_NUMBER - 0.6) * 10) / 3));
      return { score: score(primary), breaksStub: t.GATE_ADDRESSED > 0.9 };
    };
    const calls: string[] = [];
    const r = await coordinateDescent(evaluate, ['GATE_ADDRESSED', 'MENU_NUMBER'], { ...DEFAULT_THRESHOLDS }, 5, (name) => calls.push(name));
    expect(r.final.GATE_ADDRESSED).toBeCloseTo(0.5);
    expect(r.final.MENU_NUMBER).toBeCloseTo(0.6);
    expect(r.moves.map((m) => [m.name, m.reason])).toEqual([['GATE_ADDRESSED', 'primary'], ['MENU_NUMBER', 'center']]);
    expect(r.passes).toBe(2);
    expect(r.table.GATE_ADDRESSED?.points.some((p) => p.status === 'breaks_stub')).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});
