import { describe, expect, it } from 'vitest';
import { CONSTRAINTS, EXCLUDED, gridFor, parseOnly, SWEEPABLE, violated } from './sweepSpace';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

describe('sweep space', () => {
  it('lists the twenty-three sweepable thresholds and no fixed ones', () => {
    expect(SWEEPABLE).toHaveLength(23);
    expect(SWEEPABLE).not.toContain('MAX_ATTEMPTS');
    expect(SWEEPABLE).not.toContain('STUB_SHARPNESS');
    expect(SWEEPABLE).not.toContain('JEV_TIMEOUT_MS');
  });

  it('grids probabilities 0.05..0.95 and margins 0.05..0.40 in 0.05 steps', () => {
    expect(gridFor('INTENT_ROUTE')).toHaveLength(19);
    expect(gridFor('INTENT_ROUTE')[0]).toBe(0.05);
    expect(gridFor('INTENT_ROUTE')[18]).toBe(0.95);
    expect(gridFor('GATE_INTENT_MARGIN')).toEqual([0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]);
  });

  it('accepts the defaults and names the first violated constraint', () => {
    expect(violated({ ...DEFAULT_THRESHOLDS })).toBeNull();
    expect(violated({ ...DEFAULT_THRESHOLDS, INTENT_IMPLICIT: 0.9 })).toBe('INTENT_IMPLICIT <= INTENT_ROUTE');
    expect(violated({ ...DEFAULT_THRESHOLDS, INTENT_EXPLICIT: 0.7 })).toBe('INTENT_EXPLICIT <= INTENT_IMPLICIT');
    expect(violated({ ...DEFAULT_THRESHOLDS, INTENT_SWITCH: 0.5 })).toBe('INTENT_ROUTE <= INTENT_SWITCH');
    expect(violated({ ...DEFAULT_THRESHOLDS, SLOT_CHOICE_FILL: 0.4 })).toBe('SLOT_CHOICE_CONFIRM <= SLOT_CHOICE_FILL');
    expect(CONSTRAINTS).toHaveLength(4);
  });

  it('leaves the excluded thresholds out of the default set but sweeps them on request', () => {
    expect(Object.keys(EXCLUDED)).toEqual(['GATE_WANTS_HUMAN']);
    expect(EXCLUDED.GATE_WANTS_HUMAN).toMatch(/safety change/);
    expect(parseOnly(undefined)).toHaveLength(22);
    expect(parseOnly(undefined)).not.toContain('GATE_WANTS_HUMAN');
    expect(parseOnly('GATE_WANTS_HUMAN')).toEqual(['GATE_WANTS_HUMAN']);
  });

  it('parses --only, dedupes, and rejects unknown or fixed names', () => {
    expect(parseOnly(undefined)).toEqual(SWEEPABLE.filter((n) => !(n in EXCLUDED)));
    expect(parseOnly('INTENT_ROUTE, SLOT_CHOICE_FILL')).toEqual(['INTENT_ROUTE', 'SLOT_CHOICE_FILL']);
    expect(parseOnly('INTENT_ROUTE,INTENT_ROUTE,SLOT_CHOICE_FILL')).toEqual(['INTENT_ROUTE', 'SLOT_CHOICE_FILL']);
    expect(() => parseOnly('MAX_ATTEMPTS')).toThrow(/not sweepable/);
    expect(() => parseOnly('NOPE')).toThrow(/not sweepable/);
  });

  it('covers every threshold exactly once, sweepable or deliberately fixed', () => {
    const FIXED = ['MAX_ATTEMPTS', 'STUB_SHARPNESS', 'JEV_TIMEOUT_MS', 'JEV_PRICE_PER_MTOK'];
    expect(new Set([...SWEEPABLE, ...FIXED])).toEqual(new Set(Object.keys(DEFAULT_THRESHOLDS)));
  });

  it('starts every sweepable threshold on its own grid', () => {
    for (const name of SWEEPABLE) {
      const grid = gridFor(name);
      const current = DEFAULT_THRESHOLDS[name];
      expect(grid.some((v) => Math.abs(v - current) < 1e-9), `${name} ${current} is not on its grid`).toBe(true);
    }
  });
});
