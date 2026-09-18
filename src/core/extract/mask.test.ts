import { describe, expect, it } from 'vitest';
import { MEMBER_ID_MASK, matchesMask } from './mask';

describe('matchesMask', () => {
  it('accepts eight digits as a member id', () => {
    expect(matchesMask('44718293', MEMBER_ID_MASK)).toBe(true);
  });
  it('rejects seven digits', () => {
    expect(matchesMask('4471829', MEMBER_ID_MASK)).toBe(false);
  });
  it('rejects letters', () => {
    expect(matchesMask('4471829A', MEMBER_ID_MASK)).toBe(false);
  });
});
