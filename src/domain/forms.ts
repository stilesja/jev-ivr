import type { FormId } from './intents';

export type SlotId = 'memberId' | 'provider' | 'date';
export const ALL_SLOTS: readonly SlotId[] = ['memberId', 'provider', 'date'];

export type FormCompletion =
  | { kind: 'prompt'; promptId: string }
  | { kind: 'handoff'; reason: string };

export interface FormSpec {
  /** in prompt priority order */
  slots: SlotId[];
  completion: FormCompletion;
}

export const FORMS: Record<FormId, FormSpec> = {
  schedule_new: {
    slots: ['memberId', 'provider', 'date'],
    completion: { kind: 'prompt', promptId: 'schedule_confirmed' },
  },
  reschedule: {
    slots: ['memberId', 'provider', 'date'],
    completion: { kind: 'prompt', promptId: 'reschedule_confirmed' },
  },
  cancel: {
    slots: ['memberId', 'provider'],
    completion: { kind: 'prompt', promptId: 'cancel_confirmed' },
  },
  confirm_appointment: {
    slots: ['memberId', 'provider'],
    completion: { kind: 'prompt', promptId: 'appointment_details' },
  },
  billing: {
    slots: ['memberId'],
    completion: { kind: 'handoff', reason: 'billing' },
  },
};
