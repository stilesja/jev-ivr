import type { SlotSpec } from './types';
import type { SlotId } from '../forms';
import { FORMS } from '../forms';
import type { FormId } from '../intents';
import { nameSlot } from './name';
import { dobSlot } from './dob';
import { memberIdSlot } from './memberId';
import { providerSlot } from './provider';
import { dateSlot } from './date';

export const SLOTS: Record<SlotId, SlotSpec> = {
  name: nameSlot,
  dob: dobSlot,
  memberId: memberIdSlot,
  provider: providerSlot,
  date: dateSlot,
};

export function slotsFor(form: FormId): SlotSpec[] {
  return FORMS[form].slots.map((id) => SLOTS[id]);
}

export function allSlots(): SlotSpec[] {
  return Object.values(SLOTS);
}

export type { SlotSpec, SlotOutcome, SlotContext, SlotCandidate, SlotPartial, DobPartial } from './types';
