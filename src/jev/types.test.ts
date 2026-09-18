import { describe, expect, it } from 'vitest';
import { rankProbabilities, topMargin, type ChoiceAnswer } from './types';

describe('rankProbabilities', () => {
  it('sorts labels by probability descending', () => {
    const ranked = rankProbabilities({ a: 0.2, b: 0.7, c: 0.1 });
    expect(ranked).toEqual([
      { label: 'b', p: 0.7 },
      { label: 'a', p: 0.2 },
      { label: 'c', p: 0.1 },
    ]);
  });
});

describe('topMargin', () => {
  it('returns top1 minus top2', () => {
    const answer: ChoiceAnswer = {
      type: 'choice',
      choice: 'b',
      probabilities: { a: 0.2, b: 0.7, c: 0.1 },
      confidence: 0.7,
    };
    expect(topMargin(answer.probabilities)).toBeCloseTo(0.5);
  });

  it('returns 1 when there is only one label', () => {
    expect(topMargin({ only: 1 })).toBe(1);
  });
});
