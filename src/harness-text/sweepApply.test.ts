import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderStrip, renderTable, renderMoves, renderReport, rewriteThresholds } from './sweepApply';
import type { GridPoint, SweepResult } from './sweepSearch';
import type { Score } from './sweepScore';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

function score(primary: number, secondary = 0): Score {
  return { primary, secondary, corpusMatch: primary, scenarioPass: 0, cosmeticMatch: secondary, matched: new Set(), cosmeticMatched: new Set(), misses: [] };
}

describe('rewriteThresholds', () => {
  const source = readFileSync('src/core/thresholds.ts', 'utf8');
  it('changes only the named values and leaves every other byte alone', () => {
    const out = rewriteThresholds(source, { INTENT_ROUTE: 0.8, SLOT_CHOICE_FILL: 0.65 });
    expect(out).toContain('  INTENT_ROUTE: 0.8,');
    expect(out).toContain('  SLOT_CHOICE_FILL: 0.65,');
    const strip = (s: string) => s.split('\n').filter((l) => !/^\s*(INTENT_ROUTE|SLOT_CHOICE_FILL):/.test(l)).join('\n');
    expect(strip(out)).toBe(strip(source));
    expect(out.split('\n').length).toBe(source.split('\n').length);
  });
  it('throws when a key is missing or duplicated', () => {
    expect(() => rewriteThresholds(source, { NOPE: 0.5 } as never)).toThrow(/NOPE/);
    expect(() => rewriteThresholds(source + '\n  INTENT_ROUTE: 0.1,', { INTENT_ROUTE: 0.5 })).toThrow(/once/);
  });
});

describe('render', () => {
  // one point per strip character: skipped, two below best, one below best, best, best,
  // best decisions with a worse tiebreak, stub-breaking.
  const points: GridPoint[] = [
    { value: 0.05, status: 'skipped', score: null },
    { value: 0.1, status: 'scored', score: score(3) },
    { value: 0.15, status: 'scored', score: score(4) },
    { value: 0.2, status: 'scored', score: score(5, 1) },
    { value: 0.25, status: 'scored', score: score(5, 1) },
    { value: 0.3, status: 'scored', score: score(5, 0) },
    { value: 0.35, status: 'breaks_stub', score: null },
  ];
  it('renders the strip with one character per grid point', () => {
    expect(renderStrip(points)).toBe('x-~##+!');
  });
  const result: SweepResult = {
    start: { ...DEFAULT_THRESHOLDS }, final: { ...DEFAULT_THRESHOLDS, INTENT_ROUTE: 0.2 },
    before: score(3), after: score(5),
    moves: [{ name: 'INTENT_ROUTE', from: 0.1, to: 0.2, reason: 'primary', pass: 1, before: score(3), after: score(5), plateau: { from: 0.2, to: 0.25 }, flips: { gained: ['lc-02', 'scenario:s1'], lost: [], cosmeticGained: ['dt-09'], cosmeticLost: ['ns-06'] } }],
    table: {
      INTENT_ROUTE: { current: 0.1, recommended: 0.2, points, cliff: false, insensitive: false, pinned: false, unbounded: false },
      MENU_NUMBER: { current: 0.7, recommended: 0.7, points: points.map((p) => ({ ...p, status: 'scored', score: score(3) })), cliff: false, insensitive: true, pinned: false, unbounded: false },
      CONFIRM_YES: { current: 0.7, recommended: 0.7, points, cliff: false, insensitive: false, pinned: false, unbounded: true },
      // only reachable via --only, since the default set leaves the excluded thresholds out
      GATE_WANTS_HUMAN: { current: 0.7, recommended: 0.7, points, cliff: false, insensitive: false, pinned: false, unbounded: false },
    },
    passes: 2,
    converged: true,
    evaluations: 41,
  };
  it('renders the table, moves, and report', () => {
    const table = renderTable(result);
    expect(table).toMatch(/^threshold\s+start\s+recomm\.\s+best\s+grid$/m);
    expect(table).toMatch(/INTENT_ROUTE\s+0\.10\s+0\.20\s+5\s+x-~##\+!/);
    expect(table).toMatch(/MENU_NUMBER.*insensitive/);
    expect(table).toMatch(/CONFIRM_YES.*unbounded/);
    expect(table).toMatch(/GATE_WANTS_HUMAN.*excluded/);
    const moves = renderMoves(result);
    expect(moves).toContain('pass 1: INTENT_ROUTE 0.10 -> 0.20 (primary; plateau 0.20..0.25)');
    expect(moves).toContain('gained: lc-02, scenario:s1');
    expect(moves).toContain('cosmetic gained: dt-09');
    expect(moves).toContain('cosmetic lost: ns-06');
    const report = renderReport(result, { cassette: 'fixtures/recorded/jev-1.13.0.jsonl', requests: 223, date: '2026-09-19', corpusCount: 166, scenarioCount: 45, misses: [{ id: 's9', text: 'four four' }] });
    expect(report).toContain('# Threshold sweep 2026-09-19');
    expect(report).toContain('out of 211 (166 corpus entries + 45 scenarios) / 211');
    expect(report).toContain('## Excluded by judgment\n\n- `GATE_WANTS_HUMAN`: handoff gate;');
    expect(report).toContain('before 3/0');
    expect(report).toContain('after 5/0');
    expect(report).toContain('passes 2 (converged)');
    expect(report).toContain('evaluations 41');
    expect(report).toContain('## Unbounded (plateau reaches a grid edge; not applied)\n\n- CONFIRM_YES');
    expect(report).toContain('s9: "four four"');
  });
});
