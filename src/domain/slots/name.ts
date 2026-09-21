import type { SlotContext, SlotSpec, SlotOutcome } from './types';
import { isChoice, noulValue } from '../../jev/types';

export function titleCase(s: string): string {
  return s.replace(/[a-z]+/gi, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * The spans offered as the caller's own name, in the order the generator emits them.
 *
 * A literal "none" said aloud ("none of your business") is a word span like any other, and would
 * otherwise overwrite the sentinel: the Choice would come back with a span the fill reads as "no
 * name given". The sentinel wins; a caller whose name is the word none is not a case worth
 * keeping the collision for.
 *
 * A span holding an excluded token is withheld rather than argued away in the instructions. The
 * real model read "not Chen, Cheng" -- a caller correcting the *doctor* at a summary -- as the
 * caller naming themselves and filled name with "chen cheng"; wording alone did not stop it, and
 * a name the caller never said is worse than no name. What is not on the ballot cannot be voted
 * for, so the question simply never offers those spans.
 */
function nameCandidates(ctx: SlotContext): string[] {
  return ctx.candidateWordSpans.filter(
    (span) => span !== 'none' && !span.split(' ').some((word) => ctx.excludedNameTokens.has(word)),
  );
}

export const nameSlot: SlotSpec = {
  id: 'name',
  spokenConfirm: 'summary',
  questions(ctx) {
    const criteria: Record<string, string | null> = {};
    for (const span of nameCandidates(ctx)) criteria[span] = null;
    criteria.none = "No span of asr.text is the caller's name, as when the caller only agrees, refuses, or names something other than themselves";
    return {
      nameGiven: {
        type: 'noul',
        instructions: "Read asr.text. Does the caller state their own name, first name alone or first and last?",
        criteria: { true: 'The caller gives their own name, as in my name is Anna Petrov, this is Sam, or Priya Raghunathan, including a correction to their own name just read back to them, as in no, it\'s Sam Lee', false: "No personal name, or a name that is not the caller's, such as a doctor's name, or a correction to the doctor's name" },
      },
      nameSpan: {
        type: 'choice',
        instructions: 'Read asr.text. Which of these spans is the caller\'s own full name as they say it, first and last when both are given? Do not include words such as my name is or this is, and do not choose a provider\'s name or anyone else\'s. When `slots.name` is already set and the caller gives a different name for themselves, as in no, it\'s Sam Lee, choose that span; correcting the doctor\'s name, as in not Dr. Alder, Dr. Ames, is not the caller\'s name. A single word can be the whole name, as in Prince. Choose none if no span is the caller\'s name.',
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
    // The answer is only as good as the ballot it came from: a cassette recorded before a span
    // was excluded, or any answer built against different text, can name a span this turn never
    // offered. Treat it as no span rather than filling the slot with it.
    if (!nameCandidates(ctx).includes(value)) return { kind: 'invalid', reason: 'no_span', raw: value };
    return { kind: 'filled', value, display: titleCase(value), confidence: span.probabilities[span.choice] ?? span.confidence, confirm: 'none' };
  },
  display: titleCase,
};
