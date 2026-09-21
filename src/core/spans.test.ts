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
  it('keeps 1-4 word spans that carry no number word and do not start or end with a filler', () => {
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

  it('treats a hyphenated, apostrophed name as a plain word span up to four tokens, with o/oh as ordinary words', () => {
    const spans = candidateWordSpans("this is Mary-Kate O'Neil calling");
    expect(spans).toContain('mary kate o neil');
  });

  it('drops apostrophe-contraction fragments rather than offering them as spans', () => {
    const spans = candidateWordSpans("I'd like to cancel");
    expect(spans).not.toContain('d');
    expect(spans).not.toContain('d like');
    expect(spans).toEqual(['like', 'like to cancel', 'cancel']);
  });

  it('still surfaces a name said late in a realistic-length opener, emitted position by position so the cap does not spend itself on short spans alone', () => {
    const opener = [
      'um', 'so', 'i', 'was', 'wondering', 'if', 'you', 'could', 'help', 'me', 'with', 'something', 'because', 'my',
      'appointment', 'got', 'moved', 'and', 'i', 'need', 'to', 'talk', 'to', 'someone', 'about', 'it', 'please', 'this',
      'is', 'regarding', 'a', 'scheduling', 'issue', 'that', 'came', 'up', 'last', 'week', 'when', 'i', 'called', 'the',
      'office', 'and', 'they', 'said', 'to', 'call', 'back', 'today', 'so', 'here', 'i', 'am', 'calling', 'again', 'and',
      'i', 'also', 'wanted',
    ];
    expect(opener).toHaveLength(60);
    const spans = candidateWordSpans(`${opener.join(' ')} jason stiles`);
    expect(spans).toContain('jason stiles');
  });
});
