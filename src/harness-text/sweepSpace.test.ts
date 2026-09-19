import { describe, expect, it } from 'vitest';
import { CONSTRAINTS, gridFor, parseOnly, SWEEPABLE, violated } from './sweepSpace';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

describe('sweep space', () => {
  it('lists the twenty sweepable thresholds and no fixed ones', () => {
    expect(SWEEPABLE).toHaveLength(20);
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
    expect(violated({ ...DEFAULT_THRESHOLDS, INTENT_SWITCH: 0.5 })).toBe('INTENT_IMPLICIT <= INTENT_SWITCH');
    expect(violated({ ...DEFAULT_THRESHOLDS, SLOT_CHOICE_FILL: 0.4 })).toBe('SLOT_CHOICE_CONFIRM <= SLOT_CHOICE_FILL');
    expect(CONSTRAINTS).toHaveLength(4);
  });

  it('parses --only and rejects unknown or fixed names', () => {
    expect(parseOnly(undefined)).toEqual(SWEEPABLE);
    expect(parseOnly('INTENT_ROUTE, SLOT_CHOICE_FILL')).toEqual(['INTENT_ROUTE', 'SLOT_CHOICE_FILL']);
    expect(() => parseOnly('MAX_ATTEMPTS')).toThrow(/not sweepable/);
    expect(() => parseOnly('NOPE')).toThrow(/not sweepable/);
  });
});
