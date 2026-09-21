import type { SlotSpec } from './types';
import type { SlotId } from '../forms';
import { FORMS } from '../forms';
import type { FormId } from '../intents';
import { memberIdSlot } from './memberId';
import { providerSlot } from './provider';
import { dateSlot } from './date';

/**
 * Stand-ins for `name` and `dob` until Tasks 2 and 3 add their own `SlotSpec`s. Inert on
 * purpose: no questions, never fills, so no form (none references them yet) or no-form turn
 * sees any difference. Registered here only because `SlotId` -- and so `Record<SlotId,
 * SlotSpec>` below -- already includes them (spec 2026-09-20 §2).
 */
function unimplementedSlot(id: 'name' | 'dob'): SlotSpec {
  return {
    id,
    spokenConfirm: 'summary',
    questions: () => ({}),
    fill: () => ({ kind: 'absent' }),
    display: (value) => value,
  };
}

export const SLOTS: Record<SlotId, SlotSpec> = {
  name: unimplementedSlot('name'),
  dob: unimplementedSlot('dob'),
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
