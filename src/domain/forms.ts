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
  /**
   * The manifest prompt asking the caller to confirm the filled form (spec final-confirm §2.2),
   * or null where the form hands off instead of asking one. The ids do not compose from the form
   * name, so they are listed here rather than derived.
   */
  summaryPromptId: string | null;
}

export const FORMS: Record<FormId, FormSpec> = {
  schedule_new: {
    slots: ['memberId', 'provider', 'date'],
    completion: { kind: 'prompt', promptId: 'schedule_confirmed' },
    summaryPromptId: 'confirm_schedule',
  },
  reschedule: {
    slots: ['memberId', 'provider', 'date'],
    completion: { kind: 'prompt', promptId: 'reschedule_confirmed' },
    summaryPromptId: 'confirm_reschedule',
  },
  cancel: {
    slots: ['memberId', 'provider'],
    completion: { kind: 'prompt', promptId: 'cancel_confirmed' },
    summaryPromptId: 'confirm_cancel',
  },
  confirm_appointment: {
    slots: ['memberId', 'provider'],
    completion: { kind: 'prompt', promptId: 'appointment_details' },
    summaryPromptId: 'confirm_appointment_details',
  },
  billing: {
    slots: ['memberId'],
    completion: { kind: 'handoff', reason: 'billing' },
    summaryPromptId: null,
  },
};
