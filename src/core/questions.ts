import type { QuestionMap } from '../jev/types';
import { INTENTS, INTENT_CRITERIA, INTENT_MENU } from '../domain/intents';
import { allSlots, slotsFor, type SlotContext } from '../domain/slots';
import type { Session } from './session';

export const ALWAYS_ON_IDS = [
  'intent', 'intentSecondary',
  'addressedToSystem', 'utteranceComplete', 'wantsHuman', 'rephrasingLastTurn', 'confusedByPrompt', 'spokeAMenuNumber',
  'frustration', 'urgency', 'triedSelfService', 'languageSwitch',
  'intelligible',
] as const;

const INTENT_CRITERIA_MAP: Record<string, string> = Object.fromEntries(INTENTS.map((i) => [i, INTENT_CRITERIA[i]]));

function alwaysOn(): QuestionMap {
  return {
    intent: {
      type: 'choice',
      instructions: 'Read asr.text. What is the caller asking the clinic phone line to do? If they are only answering the question in node.promptJustPlayed, choose none.',
      criteria: INTENT_CRITERIA_MAP,
    },
    intentSecondary: {
      type: 'choice',
      instructions: 'Read asr.text. Besides the main request, does the caller ask for a second, different thing? Choose none if there is only one request.',
      criteria: INTENT_CRITERIA_MAP,
    },
    addressedToSystem: {
      type: 'noul',
      instructions: 'Read asr.text. Is the caller speaking to the phone system, as opposed to someone else in the room, a television, or themselves?',
    },
    utteranceComplete: {
      type: 'noul',
      instructions: 'Read asr.text. Has the caller finished their thought, rather than trailing off or being cut short?',
    },
    wantsHuman: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller explicitly ask to talk to a person, an agent, a representative, or an operator?',
    },
    rephrasingLastTurn: {
      type: 'noul',
      instructions: 'Read asr.text and history. Is the caller repeating or rewording something they already said because the system did not understand?',
    },
    confusedByPrompt: {
      type: 'noul',
      instructions: 'Read asr.text and node.promptJustPlayed. Does the caller sound confused by what the system just asked?',
    },
    spokeAMenuNumber: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller say a single number as if choosing a menu option, such as "one" or "press two"?',
    },
    frustration: {
      type: 'score',
      instructions: 'Read asr.text. How frustrated does the caller sound?',
      levels: [
        { label: 'none', description: 'Calm or neutral' },
        { label: 'mild', description: 'Impatient, sighing, or mildly annoyed' },
        { label: 'high', description: 'Angry, raising their voice, swearing, or threatening to hang up' },
      ],
    },
    urgency: {
      type: 'score',
      instructions: 'Read asr.text. How urgent is the caller\'s need?',
      levels: [
        { label: 'low', description: 'No time pressure mentioned' },
        { label: 'normal', description: 'Wants it handled soon' },
        { label: 'high', description: 'Says it is urgent, an emergency, or must happen today' },
      ],
    },
    triedSelfService: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller say they already tried the website, the app, or an earlier call?',
    },
    languageSwitch: {
      type: 'choice',
      instructions: 'Read asr.text. Does the caller ask for, or speak in, a language other than English?',
      criteria: { none: 'English', es: 'Spanish', fr: 'French' },
    },
    intelligible: {
      type: 'noul',
      instructions: 'Read asr.text. Is the text a coherent English utterance rather than garbled fragments or noise?',
    },
  };
}

function confirmation(): QuestionMap {
  return {
    confirmsYes: {
      type: 'noul',
      instructions: 'Read asr.text and node.promptJustPlayed. Does the caller answer yes to the confirmation question?',
    },
    confirmsNo: {
      type: 'noul',
      instructions: 'Read asr.text and node.promptJustPlayed. Does the caller answer no to the confirmation question?',
    },
  };
}

function menu(): QuestionMap {
  const criteria: Record<string, string | null> = {};
  for (const { digit } of INTENT_MENU) criteria[digit] = null;
  criteria.none = 'No menu number said';
  return {
    menuNumberSaid: {
      type: 'choice',
      instructions: 'Read asr.text. Which menu number from node.options does the caller say, if any?',
      criteria,
    },
  };
}

export function buildQuestions(session: Session, ctx: SlotContext): QuestionMap {
  const q: QuestionMap = { ...alwaysOn() };
  const specs = session.form ? slotsFor(session.form) : allSlots();
  for (const spec of specs) Object.assign(q, spec.questions(ctx));
  if (session.pendingConfirmation) Object.assign(q, confirmation());
  if (session.menuActive) Object.assign(q, menu());
  return q;
}
