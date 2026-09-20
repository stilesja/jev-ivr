import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayFrameLog } from './replay';
import { handleSocketMessage, newConnectionContext } from '../server/adapter';
import { SessionStore } from '../server/sessions';
import { CallTokens } from '../server/tokens';
import { FrameLog } from '../server/frameLog';
import { newSession } from '../core/session';
import { runTurn } from '../run/turn';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest } from '../jev/types';
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
    await say('yes');

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

  it('ignores frames after the call ended and reports them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-ended-'));
    const path = join(dir, 'CA1.frames.jsonl');
    const log = new FrameLog(path, () => 0);
    const client = new FixtureStubClient(loadCorpus('fixtures/corpus.jsonl'), { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null };

    // Drive the same events straight through runTurn (bypassing the adapter) to build up a log
    // that completes in two user turns: a billing question and the member ID. Billing hands off
    // instead of asking a summary, so the member ID's turn is the one that ends the call.
    let session = newSession('CA1', 0);
    const setup = { type: 'setup' as const, sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} };
    log.write('in', setup);
    session = (await runTurn(session, setup, opts)).result.session;
    const prompt1 = { type: 'prompt' as const, voicePrompt: 'I have a question about my bill', lang: 'en-US', last: true };
    log.write('in', prompt1);
    session = (await runTurn(session, prompt1, opts)).result.session;
    const prompt2 = { type: 'prompt' as const, voicePrompt: 'my member ID is eight one two zero four four five seven', lang: 'en-US', last: true };
    log.write('in', prompt2);
    const finalRun = await runTurn(session, prompt2, opts);
    session = finalRun.result.session;
    expect(finalRun.result.decision.kind).toBe('handoff');
    expect(session.ended).toBe(true);

    // A stray prompt arrives after the call ended (e.g. a late socket message); replay must not
    // feed it to runTurn.
    log.write('in', { type: 'prompt', voicePrompt: 'hello?', lang: 'en-US', last: true });

    const replay = await replayFrameLog(path, opts);
    expect(replay.records).toHaveLength(3);
    expect(replay.records.at(-1)!.decision.kind).toBe('handoff');
    expect(replay.skipped).toEqual(['line 4: prompt after the call ended']);
  });

  it('uses the frame log clock and date', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-clock-'));
    const path = join(dir, 'CA1.frames.jsonl');
    let t = 0;
    const log = new FrameLog(path, () => t);
    log.write('in', { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    t = 3 * 60_000;
    log.write('in', { type: 'prompt', voicePrompt: 'still there?', lang: 'en-US', last: true });

    const client = new HeuristicStubClient();
    // opts carries a deliberately different clock and date; replay must ignore both in favor of
    // the frame log's own timestamps and the setup line's date.
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2099-01-01', now: () => 999_999, trace: null };
    const replay = await replayFrameLog(path, opts);
    expect(replay.skipped).toEqual([]);
    expect(replay.records).toHaveLength(2);
    expect(replay.records[0]!.ts).toBe(new Date(0).toISOString());
    expect(replay.records[1]!.ts).toBe(new Date(t).toISOString());
    expect(replay.records[1]!.turnState?.turn.elapsed).toBe('over_2m');
  });

  it('skips a non-final prompt, as the adapter did when it recorded the call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-partial-'));
    const path = join(dir, 'CA1.frames.jsonl');
    const log = new FrameLog(path, () => 0);
    log.write('in', { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    log.write('in', { type: 'prompt', voicePrompt: 'I need to', lang: 'en-US', last: false });
    log.write('in', { type: 'prompt', voicePrompt: 'I need to reschedule', lang: 'en-US', last: true });

    const opts = { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', trace: null };
    const replay = await replayFrameLog(path, opts);
    expect(replay.skipped).toEqual(['line 2: non-final prompt']);
    expect(replay.records).toHaveLength(2);
    expect(replay.records[1]!.event.type).toBe('prompt');
  });

  it('replays a recorded silence frame even though parseInbound rejects it live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-silence-'));
    const path = join(dir, 'CA1.frames.jsonl');
    const log = new FrameLog(path, () => 0);
    log.write('in', { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    // The adapter logs the silence frame it synthesized just like any other inbound message;
    // parseInbound would reject this shape live (silence is server-generated, never on the wire).
    log.write('in', { type: 'silence' });

    const client = new HeuristicStubClient();
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null };
    const replay = await replayFrameLog(path, opts);
    expect(replay.skipped).toEqual([]);
    expect(replay.records).toHaveLength(2);
    expect(replay.records[1]!.event.type).toBe('silence');
    expect(replay.records[1]!.decision.kind).toBe('prompt');
  });

  it('continues after a turn throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-throws-'));
    const path = join(dir, 'CA1.frames.jsonl');
    const log = new FrameLog(path, () => 0);
    log.write('in', { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    log.write('in', { type: 'prompt', voicePrompt: 'hello', lang: 'en-US', last: true });
    log.write('in', { type: 'prompt', voicePrompt: 'still there', lang: 'en-US', last: true });
    log.write('in', { type: 'prompt', voicePrompt: 'yes', lang: 'en-US', last: true });

    const inner = new HeuristicStubClient();
    let calls = 0;
    const client: JevClient = {
      ask(req: JevRequest) {
        calls += 1;
        if (calls === 2) throw new Error('boom');
        return inner.ask(req);
      },
    };
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null };
    const replay = await replayFrameLog(path, opts);
    expect(replay.skipped).toEqual(['line 3: turn failed: boom']);
    // setup + the first and third prompt turns; the second turn threw and produced no record.
    expect(replay.records).toHaveLength(3);
  });

  it('skips a line with a missing or unparsable ts instead of throwing or using NaN', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-badts-'));
    const path = join(dir, 'CA1.frames.jsonl');
    const write = (obj: unknown) => appendFileSync(path, JSON.stringify(obj) + '\n');
    write({ ts: new Date(0).toISOString(), dir: 'in', msg: { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} } });
    // line 2: no ts field at all
    write({ dir: 'in', msg: { type: 'prompt', voicePrompt: 'hi', lang: 'en-US', last: true } });
    // line 3: ts is present but not a parsable date
    write({ ts: 'not-a-date', dir: 'in', msg: { type: 'prompt', voicePrompt: 'still there', lang: 'en-US', last: true } });
    write({ ts: new Date(1_000).toISOString(), dir: 'in', msg: { type: 'prompt', voicePrompt: 'yes', lang: 'en-US', last: true } });

    const client = new HeuristicStubClient();
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null };
    const replay = await replayFrameLog(path, opts);
    expect(replay.skipped).toEqual(['line 2: missing or invalid ts', 'line 3: missing or invalid ts']);
    // setup (line 1) + the valid prompt (line 4); the two bad-ts lines never reach runTurn.
    expect(replay.records).toHaveLength(2);
  });
});
