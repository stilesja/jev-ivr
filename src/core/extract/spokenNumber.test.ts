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
    ['forty please hold four', '404'],
    ['double please four', '4'],
  ])('%s -> %s', (input, expected) => {
    expect(spokenToDigits(input)).toBe(expected);
  });
});

describe('chunked groups', () => {
  it.each([
    // a multiplier scales the group built so far
    ['three hundred five', '305'],
    ['two hundred', '200'],
    ['three hundred fifty', '350'],
    ['two thousand five', '2005'],
    // a small number spoken right after a multiplier adds into the group
    ['forty four one eighty seven three hundred fifty five', '44187355'],
    ['four four one eight seven three hundred five', '44187305'],
    // "and" is transparent inside a group
    ['four hundred and twelve', '412'],
    // an unknown word closes the current group
    ['three hundred please fifty five', '30055'],
    // digit and word groups still concatenate group by group
    ['44 187 355', '44187355'],
    ['one eighty seven', '187'],
    // multipliers compose the way English does, including thousands
    ['two thousand five hundred', '2500'],
    ['one thousand two hundred thirty four', '1234'],
    ['two hundred thousand', '200000'],
    ['twenty hundred', '2000'],
    // a spoken zero always starts its own digit, never composing into a group
    ['three hundred oh five', '30005'],
    ['three hundred zero five', '30005'],
    // a repeated digit doesn't open a group for a following multiplier to compose into
    ['double four hundred', '44100'],
  ])('%s -> %s', (input, expected) => {
    expect(spokenToDigits(input)).toBe(expected);
  });
});
