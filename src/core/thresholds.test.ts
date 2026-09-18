import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, withOverrides, parseOverride } from './thresholds';

describe('thresholds', () => {
  it('applies a single override without mutating defaults', () => {
    const t = withOverrides({ INTENT_ROUTE: 0.9 });
    expect(t.INTENT_ROUTE).toBe(0.9);
    expect(DEFAULT_THRESHOLDS.INTENT_ROUTE).toBe(0.85);
  });

  it('parses NAME=VALUE strings', () => {
    expect(parseOverride('GATE_ADDRESSED=0.5')).toEqual({ GATE_ADDRESSED: 0.5 });
  });

  it('rejects unknown names', () => {
    expect(() => parseOverride('NOPE=1')).toThrow(/unknown threshold/);
  });
});
