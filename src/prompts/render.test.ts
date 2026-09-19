import { describe, expect, it } from 'vitest';
import { FORMS } from '../domain/forms';
import { renderTemplate, promptText, promptEntry, decisionToFrames, handoffPromptId, spokenText } from './render';
import manifest from './manifest.json';
import { PROVIDERS } from '../domain/slots/provider';
import { INTENT_MENU } from '../domain/intents';

describe('renderTemplate', () => {
  it('substitutes variables', () => {
    expect(renderTemplate('With {provider}.', { provider: 'Dr. Chen' })).toBe('With Dr. Chen.');
  });
  it('throws on a missing variable', () => {
    expect(() => renderTemplate('On {date}.', {})).toThrow(/date/);
  });
});

describe('manifest', () => {
  it('has text and an interruptible flag for every prompt', () => {
    for (const [id, p] of Object.entries(manifest)) {
      expect(typeof p.text, id).toBe('string');
      expect(typeof p.interruptible, id).toBe('boolean');
    }
  });
  it('maps handoff reasons to prompt ids', () => {
    expect(handoffPromptId('live-agent')).toBe('handoff_live_agent');
    expect(manifest).toHaveProperty(handoffPromptId('max-attempts'));
    expect(manifest).toHaveProperty(handoffPromptId('system-failure'));
  });
});

describe('keypad prompts match the tables they read from', () => {
  it('lists every provider in roster order with its 1-based digit', () => {
    const text = manifest.ask_provider_dtmf.text;
    let cursor = -1;
    PROVIDERS.forEach((p, i) => {
      const at = text.indexOf(p.name, cursor + 1);
      expect(at, `${p.name} is listed after the previous provider`).toBeGreaterThan(cursor);
      const comma = text.indexOf(',', at);
      expect(text.slice(at, comma === -1 ? undefined : comma), p.name).toContain(String(i + 1));
      cursor = at;
    });
  });

  it('offers every intent menu digit', () => {
    for (const { digit } of INTENT_MENU) {
      expect(manifest.nomatch_dtmf_menu.text, digit).toContain(`press ${digit}`);
    }
  });
});

describe('spokenText', () => {
  it('joins the ack and prompt text straight from the manifest', () => {
    const text = spokenText({
      kind: 'prompt', promptId: 'ask_memberId', vars: {}, target: 'memberId', options: [],
      acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }],
    });
    expect(text).toBe(`${promptText('ack_provider', { provider: 'Dr. Chen' })} ${promptText('ask_memberId', {})}`);
  });

  it('is empty for decisions that say nothing', () => {
    expect(spokenText({ kind: 'ignore' })).toBe('');
    expect(spokenText({ kind: 'hold' })).toBe('');
  });
});

describe('decisionToFrames', () => {
  it('emits ack frames then the prompt frame', () => {
    const frames = decisionToFrames({
      kind: 'prompt', promptId: 'ask_memberId', vars: {}, target: 'memberId', options: [],
      acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }],
    });
    expect(frames).toEqual([
      { type: 'text', token: 'With Dr. Chen.', last: true, lang: 'en-US', interruptible: false, preemptible: false },
      { type: 'text', token: promptText('ask_memberId', {}), last: true, lang: 'en-US', interruptible: true, preemptible: false },
    ]);
  });

  it('ends the call after a handoff prompt', () => {
    const frames = decisionToFrames({ kind: 'handoff', reason: 'billing', promptId: 'handoff_billing', acks: [], completed: [], queued: [] });
    expect(frames[1]).toEqual({ type: 'end', handoffData: '{"reasonCode":"billing"}' });
  });

  it('emits nothing for ignore and hold', () => {
    expect(decisionToFrames({ kind: 'ignore' })).toEqual([]);
    expect(decisionToFrames({ kind: 'hold' })).toEqual([]);
  });
});

describe('completion prompts', () => {
  it('read back every slot of the form they close', () => {
    for (const [form, spec] of Object.entries(FORMS)) {
      if (spec.completion.kind !== 'prompt') continue;
      const text = promptEntry(spec.completion.promptId).text;
      for (const slot of spec.slots) expect(text, `${form}: ${spec.completion.promptId}`).toContain(`{${slot}}`);
    }
  });
});

describe('completion and chaining', () => {
  it('no completion prompt ends the call by itself', () => {
    for (const spec of Object.values(FORMS)) {
      if (spec.completion.kind === 'prompt') expect(promptEntry(spec.completion.promptId).text).not.toMatch(/goodbye/i);
    }
  });

  it('speaks acks, the completion, then goodbye, then ends', () => {
    const frames = decisionToFrames({ kind: 'complete', form: 'cancel', promptId: 'cancel_confirmed', vars: { memberId: '4471 8293', provider: 'Dr. Kim' }, acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Kim' } }], completed: ['cancel'] });
    expect(frames.map((f) => (f.type === 'text' ? f.token : f.type))).toEqual(['With Dr. Kim.', promptText('cancel_confirmed', { memberId: '4471 8293', provider: 'Dr. Kim' }), 'Goodbye.', 'end']);
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed","completed":["cancel"]}' });
  });

  it('speaks acks before a handoff and reports completed forms', () => {
    const frames = decisionToFrames({ kind: 'handoff', reason: 'billing', promptId: 'handoff_billing', acks: [{ promptId: 'bridge_next', vars: { intentLabel: 'ask about billing' } }], completed: ['reschedule'], queued: [] });
    expect(frames.map((f) => (f.type === 'text' ? f.token : f.type))).toEqual(["Now, let's ask about billing.", 'Connecting you to billing now.', 'end']);
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"billing","completed":["reschedule"]}' });
  });

  it('reports intents the call never started in the handoff data', () => {
    const frames = decisionToFrames({ kind: 'handoff', reason: 'live-agent', promptId: 'handoff_live_agent', acks: [], completed: ['cancel'], queued: ['schedule_new'] });
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"live-agent","completed":["cancel"],"queued":["schedule_new"]}' });
  });
});
