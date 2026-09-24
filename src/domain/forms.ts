import type { FormId } from './intents';

export type SlotId = 'name' | 'dob' | 'memberId' | 'provider' | 'date';
export const ALL_SLOTS: readonly SlotId[] = ['name', 'dob', 'memberId', 'provider', 'date'];

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
    slots: ['name', 'dob', 'provider', 'date'],
    completion: { kind: 'prompt', promptId: 'schedule_confirmed' },
    summaryPromptId: 'confirm_schedule',
  },
  reschedule: {
    slots: ['name', 'dob', 'provider', 'date'],
    completion: { kind: 'prompt', promptId: 'reschedule_confirmed' },
    summaryPromptId: 'confirm_reschedule',
  },
  cancel: {
    slots: ['name', 'dob', 'provider'],
    completion: { kind: 'prompt', promptId: 'cancel_confirmed' },
    summaryPromptId: 'confirm_cancel',
  },
  confirm_appointment: {
    slots: ['name', 'dob', 'provider'],
    completion: { kind: 'prompt', promptId: 'appointment_details' },
    summaryPromptId: 'confirm_appointment_details',
  },
  billing: {
    slots: ['memberId'],
    completion: { kind: 'handoff', reason: 'billing' },
    summaryPromptId: null,
  },
};

/** Forms that book an opening the system offers (spec 2026-09-24 appointment-slots §3). */
export const SCHEDULING_FORMS: readonly FormId[] = ['schedule_new', 'reschedule'];
/** Forms that act on a booking the directory finds. */
export const EXISTING_FORMS: readonly FormId[] = ['confirm_appointment', 'cancel', 'reschedule'];
