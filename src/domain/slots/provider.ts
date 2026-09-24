import type { SlotSpec, SlotOutcome } from './types';
import { isChoice, noulValue, rankProbabilities, type AnswerMap } from '../../jev/types';
import type { Thresholds } from '../../core/thresholds';
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

/** Prompts for the two ways a caller answers "Do you have the name of the provider?" without a name. */
const HELP_PROMPTS: Record<string, string> = { has_name: 'ask_provider_name', no_name: 'provider_list' };

/** No provider was named: did the caller say whether they know the name? (spec 2026-09-24 §3.3) */
function helpOutcome(answers: AnswerMap, t: Thresholds): SlotOutcome {
  const s = answers.providerNameStatus;
  const [top] = isChoice(s) ? rankProbabilities(s.probabilities) : [];
  const promptId = top && top.p >= t.SLOT_HELP ? HELP_PROMPTS[top.label] : undefined;
  return promptId ? { kind: 'help', promptId } : { kind: 'absent' };
}

export const providerSlot: SlotSpec = {
  id: 'provider',
  spokenConfirm: 'by-confidence',

  questions() {
    const criteria: Record<string, string | null> = {};
    for (const p of PROVIDERS) criteria[p.key] = `Dr. ${p.name}, also said as just ${p.name}`;
    criteria.none = 'No provider is named';
    return {
      provider: {
        type: 'choice',
        instructions: 'Read asr.text. Which provider, if any, does the caller name? When they correct a name, the word not marks the name they are rejecting; choose the other one, as in "not Chen, Cheng" or "Okafor, not Nguyen". A hedge such as "I\'m not sure" or "either" is not a correction; name the provider they mention.',
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
      providerNameStatus: {
        type: 'choice',
        instructions: "Read asr.text and node.promptJustPlayed. The caller was asked whether they have the provider's name. Do they say whether they know it, without naming a provider?",
        criteria: {
          neither: 'Names a provider, or says nothing about whether they know the name',
          has_name: "Says yes, that they have or know the provider's name, without saying the name",
          no_name: "Says no, or that they don't know, don't have, can't remember, or were never told the provider's name, or asks who the doctors are",
        },
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    const a = answers.provider;
    if (!isChoice(a)) return helpOutcome(answers, t);
    const [top, second] = rankProbabilities(a.probabilities);
    if (!top || top.label === 'none' || top.p < t.SLOT_CHOICE_CONFIRM) return helpOutcome(answers, t);
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
