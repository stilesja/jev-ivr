import { describe, expect, it } from 'vitest';
import { spokenToDigits } from './spokenNumber';

describe('spokenToDigits', () => {
  it.each([
    ['four four seven one eight two nine three', '44718293'],
    ['forty four seventy one eighty two ninety three', '44718293'],
    ['double four 71 82 93', '44718293'],
    ['my member id is 4471 8293', '44718293'],
    ['eight oh seven', '807'],
    ['twelve fifteen', '1215'],
    ['twenty', '20'],
    ['triple seven', '777'],
    ['four-four-seven', '447'],
    ['hello there', ''],
  ])('%s -> %s', (input, expected) => {
    expect(spokenToDigits(input)).toBe(expected);
  });
});
