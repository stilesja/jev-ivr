import type { ChoiceAnswer, ChoiceQuestion, NoulAnswer, ScoreAnswer, ScoreQuestion } from './types';

/** winner gets `sharpness`; the remainder is split evenly across the other labels. */
export function sharp(labels: readonly string[], winner: string, sharpness: number): Record<string, number> {
  const others = labels.filter((l) => l !== winner);
  const rest = others.length ? (1 - sharpness) / others.length : 0;
  const out: Record<string, number> = {};
  for (const l of labels) out[l] = l === winner ? (others.length ? sharpness : 1) : rest;
  return round(out);
}

export function normalize(probs: Record<string, number>): Record<string, number> {
  const total = Object.values(probs).reduce((a, b) => a + b, 0) || 1;
  return round(Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, v / total])));
}

function round(probs: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
}

export function choiceAnswer(probabilities: Record<string, number>): ChoiceAnswer {
  const [top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return { type: 'choice', choice: top?.[0] ?? 'none', probabilities, confidence: top?.[1] ?? 0 };
}

export function scoreAnswer(q: ScoreQuestion, probabilities: Record<string, number>): ScoreAnswer {
  const score = q.levels.reduce((acc, l, i) => acc + (i + 1) * (probabilities[l.label] ?? 0), 0);
  return { type: 'score', score, probabilities, confidence: Math.max(...Object.values(probabilities)) };
}

export function noulAnswer(noul: number): NoulAnswer {
  return { type: 'noul', noul };
}

export function choiceLabels(q: ChoiceQuestion): string[] {
  return Object.keys(q.criteria);
}
