import type { QuestionMap } from '../jev/types';
import { FORM_INTENTS, INTENTS, INTENT_CRITERIA, INTENT_MENU, type FormId } from '../domain/intents';
import { FORMS, type SlotId } from '../domain/forms';
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
      criteria: {
        true: 'Anything said in reply to the phone system, including a short or fragmentary answer or correction to the question it just asked, such as a name, a day, a number, yes, no, or not Chen, Cheng',
        false: 'Talking to someone else in the room, to a television, or to themselves, with no connection to what the system just asked',
      },
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
      criteria: {
        true: 'The caller says no, or rejects or corrects something in the question that was just asked, as in not Chen, Cheng, or Thursday, not Tuesday, or that is wrong',
        false: 'The caller agrees, answers something else, or says nothing about the question',
      },
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

/**
 * Spec final-confirm §4: a second task named on the opening utterance. Deliberately asked on
 * every out-of-form turn -- menu and intent-confirm turns included -- because the gate only
 * acts on this answer for a plain route; asking it everywhere else keeps the question set stable.
 */
function noForm(): QuestionMap {
  const criteria: Record<string, string> = {};
  for (const i of FORM_INTENTS) criteria[i] = `A second, separate request on top of the main one: ${INTENT_CRITERIA[i]}`;
  criteria.none = 'Everything the caller says belongs to one request, even if they describe it twice or add details to it; or they ask for nothing';
  return {
    secondIntent: {
      type: 'choice',
      instructions: 'Read asr.text. The caller states one main request. Does the same utterance also ask for a second, separate task on top of it, joined by words such as and also, as well, another thing, or while I have you? If so, which is the extra task? Choose none when everything they say is part of one request.',
      criteria,
    },
  };
}

/**
 * Fixed presentation order for changeSlot's criteria. The question has a `none`, so a quiet answer
 * lands there whatever the order -- unlike intentChange, which has no none and so falls to its first
 * label. The order is pinned only so the wire order, and any option-order bias in the model's answer,
 * stay stable across runs. Every slot is listed; formConfirmation keeps the ones its form has.
 */
export const CHANGE_SLOT_ORDER: readonly SlotId[] = ['provider', 'date', 'memberId'];

const CHANGE_SLOT_TEXT: Record<SlotId, string> = {
  provider: 'They name the doctor or provider as the thing to change, without saying who instead, as in the doctor, or not that doctor',
  date: 'They name the day or date as the thing to change, without saying which day instead, as in the day, or the date is wrong',
  memberId: 'They name the member ID or member number as the thing to change, without saying the digits',
};

/**
 * Spec final-confirm §6: which detail the caller names when asked what to change. Criteria are
 * disjoint from value-giving answers (naming a detail, not giving its new value) and limited to
 * the slots on the current form. Asked only while the summary is pending.
 */
function formConfirmation(form: FormId): QuestionMap {
  const criteria: Record<string, string> = {};
  for (const id of CHANGE_SLOT_ORDER) if (FORMS[form].slots.includes(id)) criteria[id] = CHANGE_SLOT_TEXT[id];
  criteria.none = 'They say a new value rather than naming which detail is wrong, such as a weekday, a doctor name, or a string of digits; or they only answer yes or no; or they name nothing';
  return {
    changeSlot: {
      type: 'choice',
      instructions: 'Read asr.text and node.promptJustPlayed. The caller was read a summary of their appointment and asked to confirm it, or asked what to change. Which detail do they name as wrong or ask to change?',
      criteria,
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
  if (session.pendingConfirmation?.target === 'form') Object.assign(q, formConfirmation(session.pendingConfirmation.form));
  if (session.menuActive) Object.assign(q, menu());
  return q;
}
