import { describe, expect, it } from 'vitest';
import { FORMS } from '../domain/forms';
import { renderTemplate, promptText, promptEntry, decisionToFrames, promptFrames, handoffPromptId, spokenText } from './render';
import manifest from './manifest.json';
import { PROVIDERS } from '../domain/slots/provider';
import { INTENT_MENU, INTENT_LABELS } from '../domain/intents';
import { textFrame } from '../channel/frames';

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

describe('decisionToFrames with clips', () => {
  const base = 'https://demo.ngrok.app/audio/';
  const clips = new Map([
    ['greeting.0', 'greeting.0.wav'],
    ['ack_provider.0', 'ack_provider.0.wav'], ['provider.chen', 'provider.chen.wav'],
    ['confirm_memberId.0', 'confirm_memberId.0.wav'], ['confirm_memberId.1', 'confirm_memberId.1.mp3'],
    ['window.next_week', 'window.next_week.wav'],
    ['goodbye.0', 'goodbye.0.wav'],
  ]);
  const ctx = { clips, audioBase: base };
  const p = (source: string, interruptible: boolean) => ({ type: 'play', source, loop: 1, preemptible: false, interruptible });
  const t = (token: string, interruptible: boolean) => ({ type: 'text', token, last: true, lang: 'en-US', interruptible, preemptible: false });

  it('renders a fully recorded prompt as play frames', () => {
    const frames = decisionToFrames({ kind: 'prompt', promptId: 'greeting', vars: {}, acks: [], target: 'intent', options: [] }, ctx);
    expect(frames).toEqual([p(`${base}greeting.0.wav`, true)]);
  });

  it('plays vocabulary clips, speaks composed values, and drops bare punctuation after a clip', () => {
    const frames = decisionToFrames({
      kind: 'prompt', promptId: 'confirm_memberId', vars: { memberId: '4471 8293' }, target: 'memberId', options: ['yes', 'no'],
      acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }],
    }, ctx);
    expect(frames).toEqual([
      p(`${base}ack_provider.0.wav`, false), p(`${base}provider.chen.wav`, false),
      p(`${base}confirm_memberId.0.wav`, false), t('4471 8293', false), p(`${base}confirm_memberId.1.mp3`, false),
    ]);
  });

  it('falls back to text per segment and joins text without a space before punctuation', () => {
    const partial = { clips: new Map([['ack_provider.0', 'ack_provider.0.wav']]), audioBase: base };
    const frames = decisionToFrames({ kind: 'prompt', promptId: 'ask_memberId', vars: {}, target: 'memberId', options: [], acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Kim' } }] }, partial);
    expect(frames).toEqual([p(`${base}ack_provider.0.wav`, false), t('Dr. Kim.', false), t(promptText('ask_memberId', {}), true)]);
  });

  it('strips the leading pause from text that follows a clip', () => {
    const frames = decisionToFrames({ kind: 'prompt', promptId: 'date_narrow_window', vars: { window: 'next week' }, target: 'date', options: [], acks: [] }, ctx);
    expect(frames).toEqual([p(`${base}window.next_week.wav`, true), t('Which day works for you?', true)]);
  });

  it('renders exactly as today without a context', () => {
    const d = { kind: 'prompt' as const, promptId: 'ask_memberId', vars: {}, target: 'memberId' as const, options: [], acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }] };
    expect(decisionToFrames(d, null)).toEqual(decisionToFrames(d));
    expect(decisionToFrames(d)).toEqual([t('With Dr. Chen.', false), t(promptText('ask_memberId', {}), true)]);
    const w = { kind: 'prompt' as const, promptId: 'date_narrow_window', vars: { window: 'next week' }, target: 'date' as const, options: [], acks: [] };
    expect(decisionToFrames(w)).toEqual([t('next week. Which day works for you?', true)]);
  });

  it('merges a whole text run around a vocabulary clip and plays the goodbye clip before the end frame', () => {
    const frames = decisionToFrames({ kind: 'complete', form: 'cancel', promptId: 'cancel_confirmed', vars: { memberId: '4471 8293', provider: 'Dr. Chen' }, acks: [], completed: ['cancel'] }, ctx);
    expect(frames).toEqual([
      t('For member ID 4471 8293, your appointment with', false), p(`${base}provider.chen.wav`, false), t('is cancelled.', false),
      p(`${base}goodbye.0.wav`, false),
      expect.objectContaining({ type: 'end' }),
    ]);
  });

  it('is byte-identical to a manifest text frame for every prompt, with or without an empty context', () => {
    const vars: Record<string, string> = {
      provider: 'Dr. Chen',
      intentLabel: INTENT_LABELS.billing,
      window: 'next week',
      memberId: '4471 8293',
      date: 'Tuesday, September 22',
      a: 'Dr. Chen',
      b: 'Dr. Cheng',
    };
    const empty = { clips: new Map<string, string>(), audioBase: base };
    for (const id of Object.keys(manifest)) {
      const expected = [textFrame(promptText(id, vars), true)];
      expect(promptFrames(id, vars, true, null)).toEqual(expected);
      expect(promptFrames(id, vars, true, empty)).toEqual(expected);
    }
  });
});
