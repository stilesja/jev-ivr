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
    const long = Array.from({ length: 60 }, (_, i) => (i % 2 ? 'four' : 'x')).join(' ');
    expect(candidateSpans(long).length).toBeLessThanOrEqual(MAX_SPANS);
  });
});
