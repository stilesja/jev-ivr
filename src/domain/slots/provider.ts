import type { SlotSpec, SlotOutcome } from './types';
import { isChoice, noulValue, rankProbabilities } from '../../jev/types';
import providers from '../providers.json';

export interface Provider {
  key: string;
  name: string;
}

export const PROVIDERS: readonly Provider[] = providers;

export function providerDisplay(key: string): string {
  const p = PROVIDERS.find((x) => x.key === key);
  return p ? `Dr. ${p.name}` : key;
}

export const providerSlot: SlotSpec = {
  id: 'provider',
  spokenConfirm: 'by-confidence',

  questions() {
    const criteria: Record<string, string | null> = {};
    for (const p of PROVIDERS) criteria[p.key] = `Dr. ${p.name}`;
    criteria.none = 'No provider is named';
    return {
      provider: {
        type: 'choice',
        instructions: 'Read asr.text. Which provider, if any, does the caller name?',
        criteria,
      },
      providerUnsure: {
        type: 'noul',
        instructions: "Read asr.text. Is the caller unsure which provider they mean, or unsure of that provider's name?",
        criteria: {
          true: 'The caller hedges about the provider, as in it might be Dr. Kim or Dr. Rossi I think, or offers two names for one provider, as in Dr. Chen or Cheng, I am not sure',
          false: 'The caller names a provider plainly, or names none. A caller correcting themselves, as in Dr. Chen, not Dr. Cheng, is sure, and so is a caller who hedges only about what they want done, as in maybe cancel it with Dr. Chen',
        },
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    const a = answers.provider;
    if (!isChoice(a)) return { kind: 'absent' };
    const [top, second] = rankProbabilities(a.probabilities);
    if (!top || top.label === 'none' || top.p < t.SLOT_CHOICE_CONFIRM) return { kind: 'absent' };
    const unsure = noulValue(answers, 'providerUnsure') >= t.PROVIDER_UNSURE;
    const rival = second && second.label !== 'none' ? second : undefined;
    // The second clause is redundant while 2*SLOT_CHOICE_CONFIRM + SLOT_CHOICE_MARGIN > 1 (normalized probabilities cannot satisfy it); it becomes live if the sweep lowers either threshold.
    if (rival && (top.p - rival.p < t.SLOT_CHOICE_MARGIN || (unsure && rival.p >= t.SLOT_CHOICE_CONFIRM))) {
      return {
        kind: 'disambiguate',
        a: { value: top.label, display: providerDisplay(top.label) },
        b: { value: rival.label, display: providerDisplay(rival.label) },
      };
    }
    return {
      kind: 'filled',
      value: top.label,
      display: providerDisplay(top.label),
      confidence: top.p,
      // A hedged name is read back however sure the model is which name it was (spec 2026-09-19 §5.3).
      confirm: !unsure && top.p >= t.SLOT_CHOICE_FILL ? 'none' : 'implicit',
    };
  },

  dtmf: {
    length: 1,
    parse(digits) {
      const idx = Number(digits) - 1;
      const p = PROVIDERS[idx];
      return p ? { value: p.key, display: `Dr. ${p.name}` } : null;
    },
  },

  display: providerDisplay,
};
