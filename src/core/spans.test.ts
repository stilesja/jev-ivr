import { describe, expect, it } from 'vitest';
import { candidateSpans, MAX_SPANS } from './spans';

describe('candidateSpans', () => {
  it('includes n-grams containing a number word', () => {
    const spans = candidateSpans('my member id is four four seven');
    expect(spans).toContain('four four seven');
    expect(spans).toContain('is four four seven');
    expect(spans).toContain('my member id is four four seven');
  });

  it('excludes spans with no digits or number words', () => {
    expect(candidateSpans('my member id is four four seven')).not.toContain('my member id');
  });

  it('includes digit tokens', () => {
    expect(candidateSpans('it is 4471 8293')).toContain('4471 8293');
  });

  it('returns nothing for text without numbers', () => {
    expect(candidateSpans('I want to cancel')).toEqual([]);
  });

  it('caps the list', () => {
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'zero'];
    const long = Array.from({ length: 40 }, (_, i) => words[i % 10] + (i >= 10 ? String(i) : '')).join(' ');
    const spans = candidateSpans(long);
    expect(spans).toHaveLength(MAX_SPANS);
    expect(spans[0]!.split(' ')).toHaveLength(1);
  });
});
