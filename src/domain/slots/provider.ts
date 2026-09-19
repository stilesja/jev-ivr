import type { SlotSpec, SlotOutcome } from './types';
import { isChoice, rankProbabilities } from '../../jev/types';
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
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    const a = answers.provider;
    if (!isChoice(a)) return { kind: 'absent' };
    const [top, second] = rankProbabilities(a.probabilities);
    if (!top || top.label === 'none' || top.p < t.SLOT_CHOICE_CONFIRM) return { kind: 'absent' };
    if (second && second.label !== 'none' && top.p - second.p < t.SLOT_CHOICE_MARGIN) {
      return {
        kind: 'disambiguate',
        a: { value: top.label, display: providerDisplay(top.label) },
        b: { value: second.label, display: providerDisplay(second.label) },
      };
    }
    return {
      kind: 'filled',
      value: top.label,
      display: providerDisplay(top.label),
      confidence: top.p,
      confirm: top.p >= t.SLOT_CHOICE_FILL ? 'none' : 'implicit',
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
