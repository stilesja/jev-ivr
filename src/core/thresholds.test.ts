import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, withOverrides, parseOverride } from './thresholds';

describe('thresholds', () => {
  it('applies a single override without mutating defaults', () => {
    const before = DEFAULT_THRESHOLDS.INTENT_ROUTE;
    const t = withOverrides({ INTENT_ROUTE: 0.9 });
    expect(t.INTENT_ROUTE).toBe(0.9);
    expect(DEFAULT_THRESHOLDS.INTENT_ROUTE).toBe(before);
  });

  it('parses NAME=VALUE strings', () => {
    expect(parseOverride('GATE_ADDRESSED=0.5')).toEqual({ GATE_ADDRESSED: 0.5 });
  });

  it('rejects unknown names', () => {
    expect(() => parseOverride('NOPE=1')).toThrow(/unknown threshold/);
  });

  it('rejects prototype-chain names', () => {
    expect(() => parseOverride('constructor=1')).toThrow(/unknown threshold/);
  });

  it('rejects specs with multiple equals signs', () => {
    expect(() => parseOverride('INTENT_ROUTE=0.5=1')).toThrow(/bad threshold override/);
  });

  it('rejects empty values', () => {
    expect(() => parseOverride('INTENT_ROUTE=')).toThrow(/bad threshold value/);
  });
});
