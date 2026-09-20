import type { QuestionMap } from '../jev/types';
import { FORM_INTENTS, INTENTS, INTENT_CRITERIA, INTENT_MENU } from '../domain/intents';
import { allSlots, slotsFor, type SlotContext } from '../domain/slots';
import type { Session } from './session';

export const ALWAYS_ON_IDS = [
  'intent', 'intentTentative',
  'addressedToSystem', 'utteranceComplete', 'wantsHuman', 'rephrasingLastTurn', 'confusedByPrompt', 'spokeAMenuNumber',
  'frustration', 'urgency', 'triedSelfService', 'languageSwitch',
  'intelligible',
] as const;

const INTENT_CRITERIA_MAP: Record<string, string> = Object.fromEntries(INTENTS.map((i) => [i, INTENT_CRITERIA[i]]));

function alwaysOn(): QuestionMap {
  return {
    intent: {
      type: 'choice',
      instructions: 'Read asr.text. What is the caller asking the clinic phone line to do? If they are only answering a slot or confirmation question and not asking for anything new, choose none.',
      criteria: INTENT_CRITERIA_MAP,
    },
    intentTentative: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller express their request tentatively, with words such as maybe, I guess, I think, possibly, or might, rather than stating it plainly?',
      criteria: {
        true: 'The hedge is about what the caller wants done, as in maybe cancel it or I guess I need to cancel',
        false: 'The request is stated plainly, even if the caller hedges about a detail such as a date, a provider name, or a number',
      },
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
      instructions: "Read asr.text and history. Is the caller repeating or rewording a request because the previous turn's outcome in history shows the system did not act on it?",
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
        { label: 'none', description: 'Calm or neutral wording' },
        { label: 'mild', description: 'Complains about waiting, repeats a request with irritation, or says come on or seriously' },
        { label: 'high', description: 'Swears, insults the system, says this is ridiculous, or threatens to hang up or complain' },
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
      instructions: 'Read asr.text. Which language other than English does the caller ask for or speak, if any?',
      criteria: { none: 'English', es: 'Spanish', fr: 'French' },
    },
    intelligible: {
      type: 'noul',
      instructions: 'Read asr.text. Is the text words the caller actually said, rather than garbled fragments or background noise?',
      criteria: {
        true: 'Any real utterance, including a single word, a yes or no, a name, a number, or a string of digits',
        false: 'Garbled fragments, transcribed noise, or nothing but a filler sound such as um or uh',
      },
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

/**
 * Spec 2026-09-19 §2.2: what an in-form utterance does to the current task. Asked only inside a form.
 * answering is first because quietAnswer() defaults a none-less Choice to labels[0], matching spec §3.2's
 * below-threshold default.
 */
function inForm(): QuestionMap {
  return {
    intentChange: {
      type: 'choice',
      instructions: 'Read asr.text. The caller is in the middle of the task described by activeFormLabel and was just asked node.promptJustPlayed. Which best describes this utterance?',
      criteria: {
        answering: 'Answers or reacts to the question that was just asked, restates the current task, or says something incidental; anything that is not a request for a different task',
        adding: 'Asks for an additional task to be handled as well, while keeping the current one, for example with also, as well, and another thing, or after this',
        replacing: 'Abandons the current task in favour of a different one, for example with never mind, forget that, instead, or actually I just want',
      },
    },
  };
}

/** Spec final-confirm §4: a second task named on the opening utterance. Asked only outside a form. */
function noForm(): QuestionMap {
  const criteria: Record<string, string> = {};
  for (const i of FORM_INTENTS) criteria[i] = INTENT_CRITERIA[i];
  criteria.none = 'The caller asks for one task only, or for nothing';
  return {
    secondIntent: {
      type: 'choice',
      instructions: 'Read asr.text. If the caller asks for a second, different task in addition to the main one they ask for, which is it? Choose none when there is only one task.',
      criteria,
    },
  };
}

/** Spec final-confirm §6: which detail the caller names when asked what to change. Asked only while the summary is pending. */
function formConfirmation(): QuestionMap {
  return {
    changeSlot: {
      type: 'choice',
      instructions: 'Read asr.text and node.promptJustPlayed. The caller was read a summary of their appointment and asked to confirm it, or asked what to change. Which detail do they name as wrong or ask to change?',
      criteria: {
        provider: 'The doctor or provider, as in the doctor, not Dr. Chen, or a different doctor',
        date: 'The day or date, as in the day, not Tuesday, or a different day',
        memberId: 'The member ID or member number',
        none: 'They give a new value instead of naming a detail, answer yes or no, or name nothing',
      },
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
  if (session.form) Object.assign(q, inForm());
  if (!session.form) Object.assign(q, noForm());
  if (session.pendingConfirmation) Object.assign(q, confirmation());
  if (session.pendingConfirmation?.target === 'form') Object.assign(q, formConfirmation());
  if (session.menuActive) Object.assign(q, menu());
  return q;
}
