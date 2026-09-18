export const INTENTS = [
  'schedule_new',
  'reschedule',
  'cancel',
  'confirm_appointment',
  'billing',
  'agent',
  'repeat_prompt',
  'other',
  'none',
] as const;
export type Intent = (typeof INTENTS)[number];

export const FORM_INTENTS = ['schedule_new', 'reschedule', 'cancel', 'confirm_appointment', 'billing'] as const;
export type FormId = (typeof FORM_INTENTS)[number];

export function isFormIntent(intent: string): intent is FormId {
  return (FORM_INTENTS as readonly string[]).includes(intent);
}

/** Criteria descriptions sent to the model. */
export const INTENT_CRITERIA: Record<Intent, string> = {
  schedule_new: 'Wants to book a new appointment that does not exist yet',
  reschedule: 'Wants to move an existing appointment to a different day',
  cancel: 'Wants to cancel an existing appointment',
  confirm_appointment: 'Wants to check or confirm the details of an existing appointment',
  billing: 'Asks about a bill, charge, payment, or insurance coverage',
  agent: 'Asks to speak with a person, representative, or operator',
  repeat_prompt: 'Asks the system to repeat what it just said',
  other: 'A request the clinic line does not handle',
  none: 'No request is expressed; the caller is only answering a question or saying something incidental',
};

/** Spoken labels for confirmation prompts. */
export const INTENT_LABELS: Record<Intent, string> = {
  schedule_new: 'schedule a new appointment',
  reschedule: 'reschedule an appointment',
  cancel: 'cancel an appointment',
  confirm_appointment: 'confirm an appointment',
  billing: 'ask about billing',
  agent: 'speak with someone',
  repeat_prompt: 'hear that again',
  other: 'something else',
  none: 'nothing',
};

export const INTENT_MENU: ReadonlyArray<{ digit: string; intent: Intent }> = [
  { digit: '1', intent: 'schedule_new' },
  { digit: '2', intent: 'reschedule' },
  { digit: '3', intent: 'cancel' },
  { digit: '4', intent: 'confirm_appointment' },
  { digit: '5', intent: 'billing' },
  { digit: '0', intent: 'agent' },
];
