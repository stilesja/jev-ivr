import type { SlotSpec, SlotOutcome } from './types';
import { isChoice, noulValue } from '../../jev/types';

export function titleCase(s: string): string {
  return s.replace(/[a-z]+/gi, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}

export const nameSlot: SlotSpec = {
  id: 'name',
  spokenConfirm: 'summary',
  questions(ctx) {
    const criteria: Record<string, string | null> = {};
    for (const span of ctx.candidateWordSpans) criteria[span] = null;
    criteria.none = "No span of asr.text is the caller's name";
    return {
      nameGiven: {
        type: 'noul',
        instructions: "Read asr.text. Does the caller state their own name, first name alone or first and last?",
        criteria: { true: 'The caller gives their own name, as in my name is Jason Stiles, this is Cher, or Jason Stiles', false: "No personal name, or a name that is not the caller's, such as a doctor's name" },
      },
      nameSpan: {
        type: 'choice',
        instructions: 'Read asr.text. Which of these spans is the caller\'s own full name as they say it, first and last when both are given? Do not include words such as my name is or this is. Choose none if no span is the caller\'s name.',
        criteria,
      },
    };
  },
  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    if (noulValue(answers, 'nameGiven') < t.SLOT_DETECT) return { kind: 'absent' };
    const span = answers.nameSpan;
    if (!isChoice(span) || span.choice === 'none') return { kind: 'invalid', reason: 'no_span', raw: '' };
    const value = span.choice.trim().replace(/\s+/g, ' ');
    return { kind: 'filled', value, display: titleCase(value), confidence: span.probabilities[span.choice] ?? span.confidence, confirm: 'none' };
  },
  display: titleCase,
};
