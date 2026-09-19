import { choiceAnswer, choiceLabels, noulAnswer, scoreAnswer, sharp } from './distributions';
import type { Answer, Question } from './types';

/** Noul values for a calm, on-topic, complete utterance with nothing notable. */
export const QUIET_NOUL: Record<string, number> = {
  addressedToSystem: 0.92,
  intelligible: 0.93,
  utteranceComplete: 0.88,
  wantsHuman: 0.04,
  rephrasingLastTurn: 0.08,
  confusedByPrompt: 0.06,
  spokeAMenuNumber: 0.03,
  triedSelfService: 0.1,
  containsMemberId: 0.05,
  memberIdComplete: 0.4,
  confirmsYes: 0.1,
  confirmsNo: 0.1,
  intentTentative: 0.05,
  providerUnsure: 0.05,
};

export const QUIET_SCORE_WINNER: Record<string, string> = {
  frustration: 'none',
  urgency: 'normal',
};

/** The answer a question gets when nothing in the utterance bears on it. */
export function quietAnswer(id: string, q: Question, sharpness: number): Answer {
  switch (q.type) {
    case 'noul':
      return noulAnswer(QUIET_NOUL[id] ?? 0.1);
    case 'score': {
      const labels = q.levels.map((l) => l.label);
      return scoreAnswer(q, sharp(labels, QUIET_SCORE_WINNER[id] ?? labels[0]!, 0.85));
    }
    case 'choice': {
      const labels = choiceLabels(q);
      const winner = labels.includes('none') ? 'none' : labels[0]!;
      return choiceAnswer(sharp(labels, winner, sharpness));
    }
  }
}
