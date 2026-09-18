import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from '../jev/types';

export function choice(probabilities: Record<string, number>): ChoiceAnswer {
  const [top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return { type: 'choice', choice: top![0], probabilities, confidence: top![1] };
}

export function noul(value: number): NoulAnswer {
  return { type: 'noul', noul: value };
}

export function score(probabilities: Record<string, number>): ScoreAnswer {
  const labels = Object.keys(probabilities);
  const expected = labels.reduce((acc, label, i) => acc + (i + 1) * probabilities[label]!, 0);
  const top = Math.max(...Object.values(probabilities));
  return { type: 'score', score: expected, probabilities, confidence: top };
}
