import type { SlotSpec } from './types';
import type { SlotId } from '../forms';
import { FORMS } from '../forms';
import type { FormId } from '../intents';
import { nameSlot } from './name';
import { dobSlot } from './dob';
import { memberIdSlot } from './memberId';
import { PROVIDERS, providerSlot } from './provider';
import { dateSlot } from './date';

export const SLOTS: Record<SlotId, SlotSpec> = {
  name: nameSlot,
  dob: dobSlot,
  memberId: memberIdSlot,
  provider: providerSlot,
  date: dateSlot,
};

/**
 * Tokens that disqualify a span from being the caller's own name: every word of the provider
 * vocabulary (a surname, and any first name or alias a provider entry carries) plus the titles
 * that mark a name as a doctor's. Built here, where the specs are registered, rather than in
 * name.ts: the name slot knows only that some tokens belong to other people, so another
 * deployment hands it its own vocabulary. The cost is that a caller who shares a surname with
 * one of the clinic's doctors cannot give that name by voice; the keypad-less name slot falls
 * to its retry ladder and an agent, which is the safer of the two failures.
 */
export const EXCLUDED_NAME_TOKENS: ReadonlySet<string> = new Set([
  'dr', 'doctor',
  ...PROVIDERS.flatMap((p) => [p.key, ...p.name.toLowerCase().split(/\s+/)]),
]);

export function slotsFor(form: FormId): SlotSpec[] {
  return FORMS[form].slots.map((id) => SLOTS[id]);
}

export function allSlots(): SlotSpec[] {
  return Object.values(SLOTS);
}

export type { SlotSpec, SlotOutcome, SlotContext, SlotCandidate, SlotPartial, DobPartial } from './types';
