import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayFrameLog } from './replay';
import { handleSocketMessage, newConnectionContext } from '../server/adapter';
import { SessionStore } from '../server/sessions';
import { CallTokens } from '../server/tokens';
import { FrameLog } from '../server/frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';

describe('replayFrameLog', () => {
  it('reproduces a live run decision for decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-'));
    const client = new FixtureStubClient(loadCorpus('fixtures/corpus.jsonl'), { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
    const store = new SessionStore((callSid) => ({
      session: newSession(callSid, 0),
      opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
      frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
    }), 60_000, () => 0);
    const tokens = new CallTokens(60_000, () => 0);
    const deps = { store, tokens, log: () => {} };
    const sock = { send: (_d: string, cb?: (e?: Error) => void) => cb?.(), close: () => {} };
    const ctx = newConnectionContext(tokens.mint('CA1'));
    const say = (t: string) => handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }));
    await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} }));
    await say("I need to reschedule my appointment, it's with Dr. Chen sometime next week");
    await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'x', durationUntilInterruptMs: 10 }));
    for (const d of '44718293') await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'dtmf', digit: d }));
    await say('Tuesday');

    const live = readFileSync(join(dir, 'CA1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const replay = await replayFrameLog(join(dir, 'CA1.frames.jsonl'), { ...opts, trace: null });
    const shape = (r: { event: { type: string }; decision: { kind: string; promptId?: string } }) => [r.event.type, r.decision.kind, r.decision.promptId ?? null];
    expect(replay.records.map(shape)).toEqual(live.map(shape));
    expect(replay.records.at(-1)!.decision.kind).toBe('complete');
    expect(replay.skipped).toEqual([]);
  });

  it('skips a second setup for the same call and reports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay2-'));
    const path = join(dir, 'x.frames.jsonl');
    const log = new FrameLog(path, () => 0);
    log.write('in', { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    log.write('out', { type: 'text', token: 'ignored' });
    log.write('in', { type: 'setup', sessionId: 'VX2', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    log.write('in', { type: 'bogus' });
    const client = new HeuristicStubClient();
    const r = await replayFrameLog(path, { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null });
    expect(r.records).toHaveLength(1);
    expect(r.skipped).toEqual(['line 3: setup for CA1 after the session started', 'line 4: unrecognized message']);
  });
});
