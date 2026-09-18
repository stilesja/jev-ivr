import { describe, expect, it } from 'vitest';
import { promptFrame, dtmfFrames, endFrame, type OutboundFrame } from './frames';

describe('frame constructors', () => {
  it('builds a final prompt frame', () => {
    expect(promptFrame('hello')).toEqual({
      type: 'prompt',
      voicePrompt: 'hello',
      lang: 'en-US',
      last: true,
    });
  });

  it('builds one dtmf frame per digit', () => {
    expect(dtmfFrames('12#')).toEqual([
      { type: 'dtmf', digit: '1' },
      { type: 'dtmf', digit: '2' },
      { type: 'dtmf', digit: '#' },
    ]);
  });

  it('json-encodes handoff data on end frames', () => {
    const frame: OutboundFrame = endFrame('live-agent');
    expect(frame).toEqual({
      type: 'end',
      handoffData: '{"reasonCode":"live-agent"}',
    });
  });
});
