import type { SlotSpec, SlotOutcome } from './types';
import { isChoice, noulValue } from '../../jev/types';
import { spokenToDigits } from '../../core/extract/spokenNumber';
import { MEMBER_ID_MASK, matchesMask } from '../../core/extract/mask';

export function formatMemberId(value: string): string {
  return `${value.slice(0, 4)} ${value.slice(4)}`;
}

export const memberIdSlot: SlotSpec = {
  id: 'memberId',
  spokenConfirm: 'always',

  questions(ctx) {
    const criteria: Record<string, string | null> = {};
    for (const span of ctx.candidateSpans) criteria[span] = null;
    criteria.none = 'No span of asr.text is a member ID';
    return {
      containsMemberId: {
        type: 'noul',
        instructions: 'Read asr.text. Does the caller state a member ID number, either as digits or as spoken number words?',
      },
      memberIdSpan: {
        type: 'choice',
        instructions: 'Read asr.text. Which of these spans is the member ID the caller states? Choose the span that covers the whole number as spoken, including number words like forty-four or three hundred fifty-five and modifiers like double or triple. Do not include words that are not part of the number. Choose none if no span is a member ID.',
        criteria,
      },
      memberIdComplete: {
        type: 'noul',
        instructions: 'Read asr.text. If the caller states a member ID, do they finish saying the whole number rather than trailing off?',
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    if (noulValue(answers, 'containsMemberId') < t.SLOT_DETECT) return { kind: 'absent' };
    if (noulValue(answers, 'memberIdComplete') < t.SLOT_DETECT) {
      return { kind: 'invalid', reason: 'incomplete', raw: '' };
    }
    const span = answers.memberIdSpan;
    if (!isChoice(span) || span.choice === 'none') return { kind: 'invalid', reason: 'no_span', raw: '' };
    const digits = spokenToDigits(span.choice);
    if (!matchesMask(digits, MEMBER_ID_MASK)) return { kind: 'invalid', reason: 'mask', raw: digits };
    return {
      kind: 'filled',
      value: digits,
      display: formatMemberId(digits),
      confidence: span.probabilities[span.choice] ?? span.confidence,
      confirm: 'implicit',
    };
  },

  dtmf: {
    length: 8,
    parse(digits) {
      if (!matchesMask(digits, MEMBER_ID_MASK)) return null;
      return { value: digits, display: formatMemberId(digits) };
    },
  },

  display: formatMemberId,
};
