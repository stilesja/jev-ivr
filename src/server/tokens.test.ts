import { describe, expect, it } from 'vitest';
import { CallTokens } from './tokens';

describe('CallTokens', () => {
  it('mints a token bound to a call and verifies it once per call', () => {
    let t = 0;
    const tokens = new CallTokens(1000, () => t);
    const tok = tokens.mint('CA1');
    expect(tok).toMatch(/^[0-9a-f]{32}$/);
    expect(tokens.verify(tok, 'CA1')).toBe(true);
    expect(tokens.verify(tok, 'CA2')).toBe(false);
    expect(tokens.verify('nope', 'CA1')).toBe(false);
  });

  it('expires tokens', () => {
    let t = 0;
    const tokens = new CallTokens(1000, () => t);
    const tok = tokens.mint('CA1');
    t = 1001;
    expect(tokens.verify(tok, 'CA1')).toBe(false);
  });

  it('a new mint for the same call replaces the old token', () => {
    const tokens = new CallTokens(1000, () => 0);
    const a = tokens.mint('CA1');
    const b = tokens.mint('CA1');
    expect(tokens.verify(a, 'CA1')).toBe(false);
    expect(tokens.verify(b, 'CA1')).toBe(true);
  });

  it('has() finds a live token without knowing its call, and never an expired or unminted one', () => {
    let t = 0;
    const tokens = new CallTokens(1000, () => t);
    const a = tokens.mint('CA1');
    const b = tokens.mint('CA2');
    expect(tokens.has(a)).toBe(true);
    expect(tokens.has(b)).toBe(true);
    expect(tokens.has('f'.repeat(32))).toBe(false);
    tokens.revoke('CA1');
    expect(tokens.has(a)).toBe(false);
    t = 1001;
    expect(tokens.has(b)).toBe(false);
  });

  it('evicts expired tokens for calls that never connect', () => {
    let t = 0;
    const tokens = new CallTokens(1000, () => t);
    const a = tokens.mint('CA1');
    const b = tokens.mint('CA2');
    t = 1001;
    expect(tokens.evictExpired()).toBe(2);
    expect(tokens.verify(a, 'CA1')).toBe(false);
    expect(tokens.verify(b, 'CA2')).toBe(false);
  });
});
