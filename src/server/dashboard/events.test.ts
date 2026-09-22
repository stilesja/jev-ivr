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

/** Twilio's own shapes: 34 characters, `AC`/`CA` plus 32 hex. */
const ACCOUNT_SID = 'ACa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5';
const CALL_SID = 'CAf6e5d4c3b2a1f6e5d4c3b2a1f6e5d4';
/** A whole number in any of the spellings the route used to pass through. */
const WHOLE_NUMBER = /\+?1?\d{10}/;

describe('redactRecord', () => {
  it('masks from/to on a setup event', () => {
    const record = baseRecord(setupFrame('s'));
    const redacted = redactRecord(record);
    expect(redacted.event).toMatchObject({ type: 'setup', from: '…0001', to: '…0002' });
  });

  it('masks the optional identity fields of a setup event and drops the geo lookup', () => {
    const record = baseRecord({
      ...setupFrame('s'),
      callSid: CALL_SID,
      accountSid: ACCOUNT_SID,
      forwardedFrom: '+15550001111',
      callerName: 'Jane Roe',
      callStatus: 'in-progress',
      customParameters: { from: '+15550002926', token: 't' },
    });
    const event = redactRecord(record).event as unknown as Record<string, unknown>;
    expect(event).toMatchObject({
      from: '…0001',
      to: '…0002',
      forwardedFrom: '…1111',
      callerName: 'redacted',
      callSid: CALL_SID,
      callStatus: 'in-progress',
      customParameters: { from: '…2926', token: 't' },
    });
    expect(event).not.toHaveProperty('accountSid');
    expect(JSON.stringify(event)).not.toMatch(WHOLE_NUMBER);
    expect(JSON.stringify(event)).not.toContain(ACCOUNT_SID);
  });

  it('returns other records unchanged', () => {
    const record = baseRecord(promptFrame('hello', true));
    expect(redactRecord(record)).toEqual(record);
  });

  it('leaves turnState in place', () => {
    // `turnState` ends in `State`, which is also the suffix of Twilio's geo fields: the record's
    // own bookkeeping must not be collateral damage.
    const record = { ...baseRecord(promptFrame('hi')), turnState: { mode: 'ask' } as unknown as TraceRecord['turnState'] };
    expect(redactRecord(record).turnState).toEqual({ mode: 'ask' });
  });
});

describe('redactFrameLine', () => {
  it('masks from/to on a setup frame line and leaves other lines unchanged', () => {
    const setupLine: FrameLogLine = { ts: '2026-09-21T00:00:00.000Z', dir: 'in', msg: setupFrame('s') };
    expect(redactFrameLine(setupLine).msg).toMatchObject({ type: 'setup', from: '…0001', to: '…0002' });

    const otherLine: FrameLogLine = { ts: '2026-09-21T00:00:00.000Z', dir: 'in', msg: { type: 'dtmf', digit: '1' } };
    expect(redactFrameLine(otherLine)).toEqual(otherLine);
  });

  it('redacts a whole frame log by key, whatever the dir and whether or not the line has a type', () => {
    const setupLine: FrameLogLine = {
      ts: '2026-09-21T00:00:00.000Z',
      dir: 'in',
      msg: {
        type: 'setup',
        sessionId: 'VX1',
        callSid: CALL_SID,
        from: '+15550002926',
        to: '+15550000002',
        forwardedFrom: '+15550001111',
        accountSid: ACCOUNT_SID,
        callerName: 'Jane Roe',
        customParameters: { from: '+15550002926' },
      },
    };
    // What http.ts writes for the action webhook: the raw form post, with no `type` at all.
    const actionLine: FrameLogLine = {
      ts: '2026-09-21T00:00:01.000Z',
      dir: 'http',
      msg: {
        route: '/cr-action',
        From: '+15550002926',
        To: '+15550000002',
        Caller: '+15550002926',
        Called: '+15550000002',
        FromCity: 'PORTLAND',
        FromState: 'OR',
        FromZip: '97204',
        FromCountry: 'US',
        AccountSid: ACCOUNT_SID,
        CallSid: CALL_SID,
        CallStatus: 'completed',
        SessionStatus: 'ended',
      },
    };
    const logLine: FrameLogLine = { ts: '2026-09-21T00:00:02.000Z', dir: 'log', msg: { noInputArmedMs: 4000, socketClosed: true } };

    const redacted = [setupLine, actionLine, logLine].map(redactFrameLine);
    const json = JSON.stringify(redacted);
    // Nothing anywhere in the payload is still a whole number or an account id.
    expect(json).not.toMatch(WHOLE_NUMBER);
    expect(json).not.toMatch(/AC[0-9a-f]{32}/);
    expect(json).not.toContain('Jane Roe');
    expect(json).not.toContain('PORTLAND');
    expect(json).not.toContain('97204');

    expect(redacted[0]!.msg).toMatchObject({
      type: 'setup',
      from: '…2926',
      to: '…0002',
      forwardedFrom: '…1111',
      callerName: 'redacted',
      customParameters: { from: '…2926' },
    });
    expect(redacted[0]!.msg).not.toHaveProperty('accountSid');

    // The call's own identifiers and statuses are what the page is for: they survive.
    expect(redacted[1]!.msg).toMatchObject({
      route: '/cr-action',
      From: '…2926',
      To: '…0002',
      Caller: '…2926',
      Called: '…0002',
      CallSid: CALL_SID,
      CallStatus: 'completed',
      SessionStatus: 'ended',
    });
    for (const key of ['AccountSid', 'FromCity', 'FromState', 'FromZip', 'FromCountry']) {
      expect(redacted[1]!.msg).not.toHaveProperty(key);
    }
    // A log line carries no identity at all and comes back exactly as written.
    expect(redacted[2]).toEqual(logLine);
  });
});
