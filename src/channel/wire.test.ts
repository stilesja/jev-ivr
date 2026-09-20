import { describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH, parseInbound, serializeOutbound } from './wire';
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

  it('never parses a silence frame off the wire: it is server-generated only', () => {
    expect(parseInbound(JSON.stringify({ type: 'silence' }))).toBeNull();
  });

  it('rejects text fields over the max length', () => {
    const long = 'a'.repeat(MAX_TEXT_LENGTH + 1000);
    expect(parseInbound(JSON.stringify({ type: 'prompt', voicePrompt: long }))).toBeNull();
  });

  it('rejects a non-finite or negative durationUntilInterruptMs', () => {
    expect(parseInbound(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'x', durationUntilInterruptMs: -5 }))).toBeNull();
    expect(parseInbound(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'x', durationUntilInterruptMs: 1e400 }))).toBeNull();
  });

  it('accepts only valid dtmf digits', () => {
    expect(parseInbound('{"type":"dtmf","digit":"#"}')).toEqual({ type: 'dtmf', digit: '#' });
    expect(parseInbound('{"type":"dtmf","digit":"*"}')).toEqual({ type: 'dtmf', digit: '*' });
    expect(parseInbound('{"type":"dtmf","digit":"w"}')).toBeNull();
    expect(parseInbound('{"type":"dtmf","digit":"A"}')).toBeNull();
  });

  it('rejects present-but-wrong-typed optional fields instead of defaulting', () => {
    expect(parseInbound('{"type":"prompt","voicePrompt":"x","last":"false"}')).toBeNull();
    expect(parseInbound('{"type":"error","description":5}')).toBeNull();
  });

  it('caps customParameters at 50 entries of at most 500 characters each', () => {
    const customParameters: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) customParameters[`k${i}`] = 'v';
    customParameters.tooLong = 'a'.repeat(501);
    const f = parseInbound(JSON.stringify({ type: 'setup', sessionId: 's', callSid: 'c', customParameters }));
    expect(f?.type).toBe('setup');
    if (f?.type === 'setup') {
      expect(Object.keys(f.customParameters).length).toBe(50);
      expect(f.customParameters.tooLong).toBeUndefined();
    }
  });
});

describe('serializeOutbound', () => {
  it('serializes frames with exactly the documented fields', () => {
    expect(JSON.parse(serializeOutbound(textFrame('hi', true)))).toEqual({
      type: 'text', token: 'hi', last: true, lang: 'en-US', interruptible: true, preemptible: false,
    });
    expect(JSON.parse(serializeOutbound(endFrame('completed')))).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed"}' });
  });

  it('drops extra properties not in the documented field set', () => {
    const frame = { ...textFrame('hi', true), extra: 'nope' };
    expect(JSON.parse(serializeOutbound(frame))).toEqual({
      type: 'text', token: 'hi', last: true, lang: 'en-US', interruptible: true, preemptible: false,
    });
  });
});
