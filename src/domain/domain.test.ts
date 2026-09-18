import { describe, expect, it } from 'vitest';
import { INTENTS, INTENT_MENU, isFormIntent } from './intents';
import { FORMS, ALL_SLOTS } from './forms';
import providers from './providers.json';
import baseline from './dtmf-baseline.json';

describe('domain tables', () => {
  it('has the nine intents from the spec', () => {
    expect(INTENTS).toEqual([
      'schedule_new', 'reschedule', 'cancel', 'confirm_appointment', 'billing',
      'agent', 'repeat_prompt', 'other', 'none',
    ]);
  });

  it('every form slot is a known slot', () => {
    for (const form of Object.values(FORMS)) {
      for (const slot of form.slots) expect(ALL_SLOTS).toContain(slot);
    }
  });

  it('every form has a dtmf baseline', () => {
    for (const id of Object.keys(FORMS)) expect(baseline).toHaveProperty(id);
  });

  it('provider keys are unique and include the collision pair', () => {
    const keys = providers.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('chen');
    expect(keys).toContain('cheng');
  });

  it('menu digits map to form intents or agent', () => {
    for (const { intent } of INTENT_MENU) expect(isFormIntent(intent) || intent === 'agent').toBe(true);
  });
});
