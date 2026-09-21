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
    // A literal "none" said aloud ("none of your business") is a word span like any other, and
    // would otherwise overwrite the sentinel: the Choice would come back with a span the fill
    // reads as "no name given". The sentinel wins; a caller whose name is the word none is not
    // a case worth keeping the collision for.
    for (const span of ctx.candidateWordSpans) if (span !== 'none') criteria[span] = null;
    criteria.none = "No span of asr.text is the caller's name";
    return {
      nameGiven: {
        type: 'noul',
        instructions: "Read asr.text. Does the caller state their own name, first name alone or first and last?",
        criteria: { true: 'The caller gives their own name, as in my name is Anna Petrov, this is Sam, or Priya Raghunathan', false: "No personal name, or a name that is not the caller's, such as a doctor's name" },
      },
      nameSpan: {
        type: 'choice',
        instructions: 'Read asr.text. Which of these spans is the caller\'s own full name as they say it, first and last when both are given? Do not include words such as my name is or this is, and do not choose a provider\'s name or anyone else\'s. Choose none if no span is the caller\'s name.',
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
