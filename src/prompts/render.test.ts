import { describe, expect, it } from 'vitest';
import { FORMS } from '../domain/forms';
import { renderTemplate, promptText, promptEntry, decisionToFrames, promptFrames, handoffPromptId, spokenText } from './render';
import manifest from './manifest.json';
import { PROVIDERS } from '../domain/slots/provider';
import { allSlots } from '../domain/slots';
import { INTENT_MENU, INTENT_LABELS, INFORMATIONAL_INTENTS } from '../domain/intents';
import { textFrame } from '../channel/frames';
import { recordableClips } from './clips';
import { isPauseOnly, joinSpoken, segmentTemplate, stripLeadingPause, VAR, VOCAB_VARS, type Segment } from './segments';

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

  it('has a manifest entry for every informational intent, so a typo in the table fails here rather than on a live call', () => {
    for (const promptId of Object.values(INFORMATIONAL_INTENTS)) {
      expect(() => promptEntry(promptId), promptId).not.toThrow();
    }
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
    const frames = decisionToFrames({ kind: 'handoff', reason: 'billing', promptId: 'handoff_billing', acks: [], completed: [], queued: [], slots: {} });
    expect(frames[1]).toEqual({ type: 'end', handoffData: '{"reasonCode":"billing"}' });
  });

  it('emits nothing for ignore and hold', () => {
    expect(decisionToFrames({ kind: 'ignore' })).toEqual([]);
    expect(decisionToFrames({ kind: 'hold' })).toEqual([]);
  });

  it('plays an ack with its own manifest flag, so the long capabilities line can be talked over', () => {
    const frames = decisionToFrames({
      kind: 'prompt', promptId: 'ask_intent', vars: {}, target: 'intent', options: [],
      acks: [{ promptId: 'ack_frustration', vars: {} }, { promptId: 'capabilities', vars: {} }],
    });
    expect(frames.map((f) => (f.type === 'text' ? f.interruptible : f.type))).toEqual([false, true, true]);
  });
});

describe('summary prompts', () => {
  it('read back every slot of the form they confirm', () => {
    for (const [form, spec] of Object.entries(FORMS)) {
      if (spec.summaryPromptId === null) continue;
      const text = promptEntry(spec.summaryPromptId).text;
      for (const slot of spec.slots) expect(text, `${form}: ${spec.summaryPromptId}`).toContain(`{${slot}}`);
    }
  });

  it('has a readback prompt for any slot whose policy asks for one', () => {
    // Nothing uses `always` today (the member ID moved to `summary`), so this loop asserts
    // nothing -- it is here to catch the missing prompt the day a slot opts back in.
    for (const spec of allSlots()) {
      if (spec.spokenConfirm === 'always') expect(Object.keys(manifest), spec.id).toContain(`confirm_${spec.id}`);
    }
  });

  it('leaves the completion line to say only that it is done', () => {
    for (const [form, spec] of Object.entries(FORMS)) {
      if (spec.completion.kind !== 'prompt' || spec.summaryPromptId === null) continue;
      expect(promptEntry(spec.completion.promptId).text, form).not.toMatch(new RegExp(VAR.source));
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
    const frames = decisionToFrames({ kind: 'handoff', reason: 'billing', promptId: 'handoff_billing', acks: [{ promptId: 'bridge_next', vars: { intentLabel: 'ask about billing' } }], completed: ['reschedule'], queued: [], slots: { memberId: '4471 8293' } });
    expect(frames.map((f) => (f.type === 'text' ? f.token : f.type))).toEqual(["Now, let's ask about billing.", 'Connecting you to billing now.', 'end']);
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"billing","completed":["reschedule"],"slots":{"memberId":"4471 8293"}}' });
  });

  it('reports intents the call never started in the handoff data', () => {
    const frames = decisionToFrames({ kind: 'handoff', reason: 'live-agent', promptId: 'handoff_live_agent', acks: [], completed: ['cancel'], queued: ['schedule_new'], slots: {} });
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"live-agent","completed":["cancel"],"queued":["schedule_new"]}' });
  });
});

describe('decisionToFrames with clips', () => {
  const base = 'https://demo.ngrok.app/audio/';
  const clips = new Map([
    ['greeting.0', 'greeting.0.wav'],
    ['ack_provider.0', 'ack_provider.0.wav'], ['provider.chen', 'provider.chen.wav'],
    ['confirm_cancel.0', 'confirm_cancel.0.wav'], ['confirm_cancel.1', 'confirm_cancel.1.mp3'],
    ['confirm_cancel.2', 'confirm_cancel.2.wav'], ['confirm_cancel.3', 'confirm_cancel.3.wav'],
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
      kind: 'prompt', promptId: 'confirm_cancel', vars: { name: 'Jason Stiles', dob: 'March 5th, 1980', provider: 'Dr. Chen' }, target: 'confirm', options: ['yes', 'no'],
      acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }],
    }, ctx);
    expect(frames).toEqual([
      p(`${base}ack_provider.0.wav`, false), p(`${base}provider.chen.wav`, false),
      p(`${base}confirm_cancel.0.wav`, true), p(`${base}provider.chen.wav`, true),
      p(`${base}confirm_cancel.1.mp3`, true), t('Jason Stiles', true), p(`${base}confirm_cancel.2.wav`, true),
      t('March 5th, 1980', true), p(`${base}confirm_cancel.3.wav`, true),
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
    // No clip for the ack's own words, so its text run has to be spoken around the provider clip.
    const partial = { clips: new Map([['provider.chen', 'provider.chen.wav'], ['goodbye.0', 'goodbye.0.wav']]), audioBase: base };
    const frames = decisionToFrames({
      kind: 'complete', form: 'confirm_appointment', promptId: 'appointment_details', vars: {}, completed: ['confirm_appointment'],
      acks: [{ promptId: 'ack_provider', vars: { provider: 'Dr. Chen' } }],
    }, partial);
    expect(frames).toEqual([
      t('With', false), p(`${base}provider.chen.wav`, false), t('That appointment is confirmed.', false),
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
      name: 'Jason Stiles',
      dob: 'March 5th, 1980',
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

  describe('with every recordable clip present', () => {
    const vars: Record<string, string> = {
      provider: 'Dr. Chen',
      intentLabel: INTENT_LABELS.billing,
      window: 'next week',
      memberId: '4471 8293',
      name: 'Jason Stiles',
      dob: 'March 5th, 1980',
      date: 'Tuesday, September 22',
      a: 'Dr. Chen',
      b: 'Dr. Cheng',
    };
    const full = new Map(recordableClips().map((r) => [r.id, `${r.id}.wav`]));
    const byId = new Map(recordableClips().map((r) => [r.id, r.text]));
    const fullCtx = { clips: full, audioBase: base };

    /**
     * A spec-derived reference, independent of promptFrames: a segment is clip-backed
     * (recordable at full coverage) when it is a non-punctuation-only fixed run or a
     * vocabulary variable; everything else (a punctuation-only fixed run, or a spoken
     * variable) is TTS. TTS runs accumulate via joinSpoken; a run immediately following a
     * clip has its leading pause stripped, mirroring promptFrames' flush rule.
     */
    function referenceSpokenText(id: string, template: string, vars: Record<string, string>): string {
      const isClipBacked = (s: Segment): boolean => (s.kind === 'fixed' ? !isPauseOnly(s.text) : VOCAB_VARS.has(s.name));
      const recordingOf = (s: Segment): string => (s.kind === 'fixed' ? stripLeadingPause(s.text) : vars[s.name]!);
      const runs: string[] = [];
      let run: string[] = [];
      let afterClip = false;
      const flushRun = (): void => {
        if (run.length === 0) return;
        let text = joinSpoken(run);
        if (afterClip) text = stripLeadingPause(text);
        if (text) runs.push(text);
        run = [];
      };
      for (const s of segmentTemplate(id, template)) {
        if (isClipBacked(s)) {
          flushRun();
          runs.push(recordingOf(s));
          afterClip = true;
        } else {
          run.push(s.kind === 'fixed' ? s.text : vars[s.name]!);
        }
      }
      flushRun();
      return joinSpoken(runs);
    }

    it('plays a clip for every segment that has one, falling back to text only for the spoken vars', () => {
      for (const [id, entry] of Object.entries(manifest)) {
        const frames = promptFrames(id, vars, true, fullCtx);

        for (const f of frames) {
          if (f.type === 'play') continue;
          expect(f.type, id).toBe('text');
          const token = (f as { token: string }).token;
          // A text frame can only ever be a spoken var's value, optionally with a trailing
          // punctuation-only fixed segment glued on (it has nowhere else to attach when
          // nothing plays after it — see the reference model above).
          const bare = token.replace(/[,.?!;:]+$/, '');
          const isSpokenVarValue = [vars.memberId, vars.name, vars.dob, vars.date].includes(bare);
          expect(isSpokenVarValue, `${id}: unexpected text frame ${JSON.stringify(token)}`).toBe(true);
        }

        const actual = joinSpoken(
          frames.map((f) => {
            if (f.type === 'text') return (f as { token: string }).token;
            const source = (f as { source: string }).source;
            const clipId = source.slice(base.length, -'.wav'.length);
            const text = byId.get(clipId);
            expect(text, `${id}: no recordable text for clip ${clipId}`).toBeDefined();
            return text!;
          }),
        );

        const expected = referenceSpokenText(id, entry.text, vars);
        expect(actual, id).toBe(expected);
      }
    });

    it('ignores a clip recorded for a punctuation-only segment', () => {
      const stray = { clips: new Map([...full, ['ack_provider.1', 'ack_provider.1.wav']]), audioBase: base };
      const frames = promptFrames('ack_provider', vars, false, stray);
      expect(frames.some((f) => f.type === 'play' && f.source.endsWith('ack_provider.1.wav'))).toBe(false);
    });
  });
});
