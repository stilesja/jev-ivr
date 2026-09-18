import type { SlotSpec } from './types';
import type { SlotId } from '../forms';
import { FORMS } from '../forms';
import type { FormId } from '../intents';
import { memberIdSlot } from './memberId';
import { providerSlot } from './provider';
import { dateSlot } from './date';

export const SLOTS: Record<SlotId, SlotSpec> = {
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

export type { SlotSpec, SlotOutcome, SlotContext, SlotCandidate } from './types';
