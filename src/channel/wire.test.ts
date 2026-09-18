import { describe, expect, it } from 'vitest';
import { parseInbound, serializeOutbound } from './wire';
import { endFrame, textFrame } from './frames';

describe('parseInbound', () => {
  it('parses a setup message and keeps Twilio extras', () => {
    const f = parseInbound(JSON.stringify({
      type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+15550001', to: '+15550002',
      accountSid: 'AC1', direction: 'inbound', callStatus: 'in-progress', customParameters: { a: 'b' },
    }));
    expect(f).toMatchObject({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', accountSid: 'AC1', direction: 'inbound' });
  });

  it('defaults prompt lang and last', () => {
    expect(parseInbound('{"type":"prompt","voicePrompt":"hi"}')).toEqual({ type: 'prompt', voicePrompt: 'hi', lang: 'en-US', last: true });
    expect(parseInbound('{"type":"prompt","voicePrompt":"hi","lang":"en-GB","last":false}')).toEqual({ type: 'prompt', voicePrompt: 'hi', lang: 'en-GB', last: false });
  });

  it('parses dtmf, interrupt and error', () => {
    expect(parseInbound('{"type":"dtmf","digit":"4"}')).toEqual({ type: 'dtmf', digit: '4' });
    expect(parseInbound('{"type":"interrupt","utteranceUntilInterrupt":"wha","durationUntilInterruptMs":300}'))
      .toEqual({ type: 'interrupt', utteranceUntilInterrupt: 'wha', durationUntilInterruptMs: 300 });
    expect(parseInbound('{"type":"error","description":"x"}')).toEqual({ type: 'error', description: 'x' });
  });

  it('returns null for unknown types, bad JSON and missing fields', () => {
    expect(parseInbound('{"type":"nope"}')).toBeNull();
    expect(parseInbound('not json')).toBeNull();
    expect(parseInbound('{"type":"dtmf"}')).toBeNull();
    expect(parseInbound('{"type":"setup","sessionId":"s"}')).toBeNull();
    expect(parseInbound('{"type":"prompt","voicePrompt":5}')).toBeNull();
  });
});

describe('serializeOutbound', () => {
  it('serializes frames with exactly the documented fields', () => {
    expect(JSON.parse(serializeOutbound(textFrame('hi', true)))).toEqual({
      type: 'text', token: 'hi', last: true, lang: 'en-US', interruptible: true, preemptible: false,
    });
    expect(JSON.parse(serializeOutbound(endFrame('completed')))).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed"}' });
  });
});
