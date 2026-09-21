import { describe, expect, it } from 'vitest';
import { candidateSpans, candidateWordSpans, MAX_SPANS } from './spans';

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

  it('does not let a lone multiplier word qualify a span', () => {
    expect(candidateSpans('I am a hundred percent sure')).toEqual([]);
  });

  it('still includes a multiplier word alongside a real number word', () => {
    expect(candidateSpans('three hundred fifty five')).toContain('three hundred fifty five');
  });

  it('caps the list', () => {
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'zero'];
    const long = Array.from({ length: 40 }, (_, i) => words[i % 10] + (i >= 10 ? String(i) : '')).join(' ');
    const spans = candidateSpans(long);
    expect(spans).toHaveLength(MAX_SPANS);
    expect(spans[0]!.split(' ')).toHaveLength(1);
  });
});

describe('candidateWordSpans', () => {
  it('keeps 1-3 word spans that carry no number word and do not start or end with a filler', () => {
    const spans = candidateWordSpans('my name is Jason Stiles and I need to reschedule');
    expect(spans).toContain('jason stiles');
    expect(spans).toContain('jason');
    expect(spans).toContain('reschedule');
    expect(spans).not.toContain('name is jason'); // starts with a filler
    expect(spans).not.toContain('stiles and'); // ends with a filler
    expect(spans).not.toContain('my');
    expect(spans.every((s) => !/\d/.test(s))).toBe(true);
  });

  it('drops number words and caps the list', () => {
    expect(candidateWordSpans('four four seven one')).toEqual([]);
    expect(candidateWordSpans(Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ')).length).toBeLessThanOrEqual(MAX_SPANS);
  });
});
