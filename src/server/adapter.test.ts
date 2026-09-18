import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSocketClose, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';

type Fake = SocketLike & { sent: unknown[]; closed: { code?: number; reason?: string } | null };
function fakeSocket(): Fake {
  const s: Fake = {
    sent: [], closed: null,
    send(d, cb) { s.sent.push(JSON.parse(d)); cb?.(); },
    close(code, reason) { s.closed = { code, reason }; },
  };
  return s;
}

function deps(): AdapterDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-'));
  const client = new FixtureStubClient(loadCorpus('fixtures/corpus.jsonl'), { sharpness: 0.9, fallback: new HeuristicStubClient() });
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0),
    opts: { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), now: () => 0 },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
  }), 60_000, () => 0);
  return { store, tokens: new CallTokens(60_000, () => 0), log: () => {}, dir };
}

const setupMsg = (callSid: string, sessionId = 'VX1') => JSON.stringify({ type: 'setup', sessionId, callSid, from: '+1', to: '+2', customParameters: {} });
const prompt = (t: string) => JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true });
const texts = (s: Fake) => s.sent.filter((m) => (m as { type: string }).type === 'text').map((m) => (m as { token: string }).token);

describe('adapter', () => {
  it('greets on a setup with a valid token and creates the session', async () => {
    const d = deps();
    const tok = d.tokens.mint('CA1');
    const sock = fakeSocket();
    const ctx = newConnectionContext(tok);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    expect(ctx.callSid).toBe('CA1');
    expect(texts(sock)).toEqual(['Thanks for calling the clinic. How can I help you today?']);
    expect(d.store.get('CA1')?.session.lastPromptId).toBe('greeting');
    expect(existsSync(join(d.dir, 'CA1.frames.jsonl'))).toBe(true);
  });

  it('refuses a bad token with an end message and closes', async () => {
    const d = deps();
    d.tokens.mint('CA1');
    const sock = fakeSocket();
    await handleSocketMessage(d, sock, newConnectionContext('wrong'), setupMsg('CA1'));
    expect(sock.sent).toEqual([{ type: 'end', handoffData: '{"reasonCode":"unauthorized"}' }]);
    expect(sock.closed?.code).toBe(1008);
    expect(d.store.get('CA1')).toBeUndefined();
  });

  it('ignores messages before setup and counts malformed ones', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt('hello'));
    await handleSocketMessage(d, sock, ctx, 'garbage');
    expect(sock.sent).toEqual([]);
    expect(ctx.malformed).toBe(1);
  });

  it('runs the worked example to completion and ends the call', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week"));
    expect(texts(sock).at(-1)).toBe("What's your member ID?");
    await handleSocketMessage(d, sock, ctx, prompt('four four seven one eight two nine three'));
    expect(texts(sock).slice(-2)).toEqual(['Member ID 4471 8293.', 'Which day next week works for you?']);
    await handleSocketMessage(d, sock, ctx, prompt('Tuesday'));
    expect(texts(sock).at(-1)).toBe('Your appointment with Dr. Chen is moved to Tuesday, September 22. Goodbye.');
    expect(sock.sent.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed"}' });
    expect(sock.closed?.code).toBe(1000);
    expect(d.store.get('CA1')?.ended).toBe(true);
    const records = readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8').trim().split('\n');
    expect(records).toHaveLength(4);
    const frames = readFileSync(join(d.dir, 'CA1.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(frames.filter((f) => f.dir === 'in')).toHaveLength(4);
    expect(frames.filter((f) => f.dir === 'out').length).toBeGreaterThanOrEqual(6);
  });

  it('feeds dtmf digits one message at a time and speaks once the slot fills', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt('Cancel my appointment with Dr. Kim please'));
    const before = sock.sent.length;
    for (const digit of '4471829') await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'dtmf', digit }));
    expect(sock.sent.length).toBe(before);
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'dtmf', digit: '#' }));
    expect(sock.sent.length).toBe(before);
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'dtmf', digit: '3' }));
    expect(texts(sock).at(-1)).toBe('Your appointment with Dr. Kim is cancelled. Goodbye.');
  });

  it('forces prompts to final and records an interrupt as barge-in on the next turn', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'Thanks for', durationUntilInterruptMs: 400 }));
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'prompt', voicePrompt: 'I need to reschedule my appointment', last: false }));
    const records = readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = records.at(-1);
    expect(last.event.last).toBe(true);
    expect(last.turnState.asr.bargeIn).toBe(true);
    expect(last.decision.promptId).toBe('ask_memberId');
  });

  it('resumes a session on a second setup for the same call and replays the last prompt', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt('I need to reschedule my appointment'));
    await handleSocketClose(d, ctx);
    expect(d.store.get('CA1')?.socket).toBeNull();
    const sock2 = fakeSocket();
    const ctx2 = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock2, ctx2, setupMsg('CA1', 'VX2'));
    expect(texts(sock2)).toEqual(["What's your member ID?"]);
    await handleSocketMessage(d, sock2, ctx2, prompt('Dr. Chen'));
    // The form asks for the member ID before the date, so the re-ask repeats; the provider fill
    // below is what proves the turn ran on the session the first connection left behind.
    expect(texts(sock2)).toEqual(["What's your member ID?", "What's your member ID?"]);
    expect(d.store.get('CA1')?.session.slots.provider.value).toBe('chen');
  });
});
