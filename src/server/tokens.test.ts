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
});
