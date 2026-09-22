import { describe, expect, it } from 'vitest';
import { redactRecord, redactFrameLine } from './events';
import { setupFrame, promptFrame } from '../../channel/frames';
import type { TraceRecord } from '../../trace/types';
import type { FrameLogLine } from '../frameLog';

function baseRecord(event: TraceRecord['event']): TraceRecord {
  return {
    v: 1,
    sessionId: 's',
    turnIndex: 1,
    ts: '2026-09-21T00:00:00.000Z',
    event,
    turnState: null,
    questions: null,
    answers: null,
    source: 'none',
    error: null,
    gates: [],
    decision: { kind: 'prompt', promptId: 'ask_intent', vars: {}, acks: [], target: 'intent', options: [] } as TraceRecord['decision'],
    frames: [],
    form: null,
    slots: {} as TraceRecord['slots'],
    timing: { planMs: 0, askMs: 0, resolveMs: 0, totalMs: 0 },
    usage: { inputTokens: 0, outputTokens: 0, estimated: true, costUsd: 0 },
  };
}

describe('redactRecord', () => {
  it('masks from/to on a setup event', () => {
    const record = baseRecord(setupFrame('s'));
    const redacted = redactRecord(record);
    expect(redacted.event).toMatchObject({ type: 'setup', from: '…0001', to: '…0002' });
  });

  it('returns other records unchanged', () => {
    const record = baseRecord(promptFrame('hello', true));
    expect(redactRecord(record)).toBe(record);
  });
});

describe('redactFrameLine', () => {
  it('masks from/to on a setup frame line and leaves other lines unchanged', () => {
    const setupLine: FrameLogLine = { ts: '2026-09-21T00:00:00.000Z', dir: 'in', msg: setupFrame('s') };
    expect(redactFrameLine(setupLine).msg).toMatchObject({ type: 'setup', from: '…0001', to: '…0002' });

    const otherLine: FrameLogLine = { ts: '2026-09-21T00:00:00.000Z', dir: 'in', msg: { type: 'dtmf', digit: '1' } };
    expect(redactFrameLine(otherLine)).toBe(otherLine);
  });
});
