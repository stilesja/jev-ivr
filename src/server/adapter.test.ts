import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleSocketClose,
  handleSocketMessage,
  MALFORMED_LIMIT,
  newConnectionContext,
  spokenDigits,
  TURN_ERROR_TEXT,
  type AdapterDeps,
} from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient } from '../jev/types';
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

/** A socket that accepts the write but never calls back, like a peer that has stopped reading. */
function silentSocket(): Fake {
  const s: Fake = {
    sent: [], closed: null,
    send(d) { s.sent.push(JSON.parse(d)); },
    close(code, reason) { s.closed = { code, reason }; },
  };
  return s;
}

/** A socket whose write callback reports an error for the frame types the predicate picks. */
function failingSocket(failOn: (type: string) => boolean): Fake {
  const s: Fake = {
    sent: [], closed: null,
    send(d, cb) {
      const msg = JSON.parse(d) as { type: string };
      if (failOn(msg.type)) { cb?.(new Error('socket write failed')); return; }
      s.sent.push(msg); cb?.();
    },
    close(code, reason) { s.closed = { code, reason }; },
  };
  return s;
}

function corpusClient(): JevClient {
  return new FixtureStubClient(loadCorpus('fixtures/corpus.jsonl'), { sharpness: 0.9, fallback: new HeuristicStubClient() });
}

function deps(clientOverride?: JevClient): AdapterDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-'));
  const client = clientOverride ?? corpusClient();
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0),
    opts: { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), now: () => 0 },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
  }), 60_000, () => 0);
  return { store, tokens: new CallTokens(60_000, () => 0), log: () => {}, dir };
}

/** Same deps, but with the log captured and a send timeout short enough for a test. */
function loggingDeps(sendTimeoutMs?: number): AdapterDeps & { dir: string; lines: string[] } {
  const d = deps();
  const lines: string[] = [];
  return { ...d, log: (line) => lines.push(line), lines, ...(sendTimeoutMs === undefined ? {} : { sendTimeoutMs }) };
}

/** Same deps, but with a short grace period so the end-close backstop test doesn't wait 30s. */
function graceDeps(endCloseGraceMs: number): AdapterDeps & { dir: string; lines: string[] } {
  const d = deps();
  const lines: string[] = [];
  return { ...d, log: (line) => lines.push(line), lines, endCloseGraceMs };
}

const setupMsg = (callSid: string, sessionId = 'VX1') => JSON.stringify({ type: 'setup', sessionId, callSid, from: '+1', to: '+2', customParameters: {} });
const prompt = (t: string) => JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true });
const texts = (s: Fake) => s.sent.filter((m) => (m as { type: string }).type === 'text').map((m) => (m as { token: string }).token);
type LogLine = { dir: string; msg: Record<string, unknown> };
const frameLines = (dir: string): LogLine[] =>
  readFileSync(join(dir, 'CA1.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LogLine);

describe('adapter', () => {
  it('greets on a setup with a valid token and creates the session', async () => {
    const d = deps();
    const tok = d.tokens.mint('CA1');
    const sock = fakeSocket();
    const ctx = newConnectionContext(tok, sock);
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
    await handleSocketMessage(d, sock, newConnectionContext('wrong', sock), setupMsg('CA1'));
    expect(sock.sent).toEqual([{ type: 'end', handoffData: '{"reasonCode":"unauthorized"}' }]);
    expect(sock.closed?.code).toBe(1008);
    expect(d.store.get('CA1')).toBeUndefined();
  });

  it('ignores messages before setup and counts malformed ones', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, prompt('hello'));
    await handleSocketMessage(d, sock, ctx, 'garbage');
    expect(sock.sent).toEqual([]);
    expect(ctx.malformed).toBe(1);
  });

  it('runs the worked example to completion and ends the call', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week"));
    expect(texts(sock).at(-1)).toBe("What's your member ID?");
    await handleSocketMessage(d, sock, ctx, prompt('four four seven one eight two nine three'));
    // The wire gets the digits spaced out; the session and the trace keep the readable form.
    expect(texts(sock).at(-1)).toBe('Your member ID is 4 4 7 1, 8 2 9 3. Is that right?');
    expect(d.store.get('CA1')?.session.lastPromptText).toBe('Your member ID is 4471 8293. Is that right?');
    await handleSocketMessage(d, sock, ctx, prompt('yes'));
    expect(texts(sock).at(-1)).toBe('next week. Which day works for you?');
    await handleSocketMessage(d, sock, ctx, prompt('Tuesday'));
    expect(texts(sock).at(-2)).toBe('For member ID 4 4 7 1, 8 2 9 3, your appointment with Dr. Chen is moved to Tuesday, September 22.');
    expect(texts(sock).at(-1)).toBe('Goodbye.');
    expect(sock.sent.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed","completed":["reschedule"]}' });
    // Twilio still has the queued clips to play; the server leaves the socket open for it and
    // only closes it if Twilio never does (see the grace-period test below).
    expect(sock.closed).toBeNull();
    expect(d.store.get('CA1')?.ended).toBe(true);
    const records = readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8').trim().split('\n');
    expect(records).toHaveLength(5);
    const frames = readFileSync(join(d.dir, 'CA1.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(frames.filter((f) => f.dir === 'in')).toHaveLength(5);
    expect(frames.filter((f) => f.dir === 'out').length).toBeGreaterThanOrEqual(6);
  });

  it('closes the socket itself if Twilio never closes it within the end-close grace period', async () => {
    const d = graceDeps(20);
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week"));
    await handleSocketMessage(d, sock, ctx, prompt('four four seven one eight two nine three'));
    await handleSocketMessage(d, sock, ctx, prompt('yes'));
    await handleSocketMessage(d, sock, ctx, prompt('Tuesday'));
    expect(sock.closed).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(sock.closed).toEqual({ code: 1000, reason: 'end grace elapsed' });
    expect(d.lines.some((l) => l.includes('did not close after end'))).toBe(true);
  });

  it('cancels the end-close backstop once Twilio actually closes the socket', async () => {
    const d = graceDeps(20);
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week"));
    await handleSocketMessage(d, sock, ctx, prompt('four four seven one eight two nine three'));
    await handleSocketMessage(d, sock, ctx, prompt('yes'));
    await handleSocketMessage(d, sock, ctx, prompt('Tuesday'));
    // Twilio closing the connection itself, exactly as the ws 'close' handler reports it.
    await handleSocketClose(d, ctx);
    await new Promise((r) => setTimeout(r, 100));
    // The backstop must not have fired a redundant close after the real one.
    expect(sock.closed).toBeNull();
  });

  it('feeds dtmf digits one message at a time and speaks once the slot fills', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt('Cancel my appointment with Dr. Kim please'));
    const before = sock.sent.length;
    for (const digit of '4471829') await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'dtmf', digit }));
    expect(sock.sent.length).toBe(before);
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'dtmf', digit: '#' }));
    expect(sock.sent.length).toBe(before);
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'dtmf', digit: '3' }));
    expect(texts(sock).at(-2)).toBe('For member ID 4 4 7 1, 8 2 9 3, your appointment with Dr. Kim is cancelled.');
    expect(texts(sock).at(-1)).toBe('Goodbye.');
  });

  it('records an interrupt as barge-in on the next prompt turn', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'Thanks for', durationUntilInterruptMs: 400 }));
    await handleSocketMessage(d, sock, ctx, prompt('I need to reschedule my appointment'));
    const records = readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = records.at(-1);
    expect(last.event.last).toBe(true);
    expect(last.turnState.asr.bargeIn).toBe(true);
    expect(last.decision.promptId).toBe('ask_memberId');
  });

  it('drops a non-final prompt without running a turn, and logs it once', async () => {
    const d = loggingDeps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    const afterGreeting = sock.sent.length;
    const partial = (t: string) => JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: false });
    await handleSocketMessage(d, sock, ctx, partial('I need to'));
    await handleSocketMessage(d, sock, ctx, partial('I need to reschedule my'));
    expect(sock.sent.length).toBe(afterGreeting);
    // One trace record so far: the setup turn. No turn ran for either partial.
    expect(readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    const dropped = frameLines(d.dir).filter((f) => f.dir === 'log' && f.msg.droppedPartial !== undefined);
    expect(dropped.map((f) => f.msg.droppedPartial)).toEqual(['I need to', 'I need to reschedule my']);
    // Both are in the frame log as received, but the operator log says it once per connection.
    expect(d.lines.filter((l) => l.includes('non-final prompt'))).toHaveLength(1);
    // The final prompt that follows is handled normally.
    await handleSocketMessage(d, sock, ctx, prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week"));
    expect(texts(sock).at(-1)).toBe("What's your member ID?");
  });

  it('truncates a very long partial in the frame log', async () => {
    const d = loggingDeps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'prompt', voicePrompt: 'x'.repeat(200), lang: 'en-US', last: false }));
    const dropped = frameLines(d.dir).find((f) => f.dir === 'log' && f.msg.droppedPartial !== undefined);
    expect(dropped?.msg.droppedPartial).toBe('x'.repeat(80));
  });

  it('closes the socket after ten malformed messages', async () => {
    const d = loggingDeps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    for (let i = 0; i < MALFORMED_LIMIT - 1; i++) await handleSocketMessage(d, sock, ctx, 'garbage');
    expect(sock.closed).toBeNull();
    await handleSocketMessage(d, sock, ctx, 'garbage');
    expect(ctx.malformed).toBe(MALFORMED_LIMIT);
    expect(sock.closed).toEqual({ code: 1007, reason: 'malformed messages' });
    expect(frameLines(d.dir).some((f) => f.dir === 'log' && f.msg.malformedLimit === MALFORMED_LIMIT)).toBe(true);
  });

  it('gives up on a send whose callback never fires', async () => {
    const d = loggingDeps(20);
    const sock = silentSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    // The greeting was written but never acknowledged, so the send is abandoned and the socket dropped.
    expect(sock.sent).toHaveLength(1);
    expect(d.store.get('CA1')?.socket).toBeNull();
    const failed = frameLines(d.dir).find((f) => f.dir === 'log' && f.msg.sendFailed !== undefined);
    expect(failed?.msg.sendFailed).toBe('text');
    expect((failed?.msg.error as { message: string }).message).toBe('send timeout');
    expect(d.lines.some((l) => l.includes('send timeout'))).toBe(true);
  });

  it('resumes a session on a second setup for the same call and replays the last prompt', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt('I need to reschedule my appointment'));
    await handleSocketClose(d, ctx);
    expect(d.store.get('CA1')?.socket).toBeNull();
    const sock2 = fakeSocket();
    const ctx2 = newConnectionContext(d.tokens.mint('CA1'), sock2);
    await handleSocketMessage(d, sock2, ctx2, setupMsg('CA1', 'VX2'));
    expect(texts(sock2)).toEqual(["What's your member ID?"]);
    await handleSocketMessage(d, sock2, ctx2, prompt('Dr. Chen'));
    // The form asks for the member ID before the date, so the re-ask repeats; the provider fill
    // below is what proves the turn ran on the session the first connection left behind.
    expect(texts(sock2)).toEqual(["What's your member ID?", "What's your member ID?"]);
    expect(d.store.get('CA1')?.session.slots.provider.value).toBe('chen');
  });

  it('a late close from a replaced socket does not detach the live one', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    const sock2 = fakeSocket();
    const ctx2 = newConnectionContext(d.tokens.mint('CA1'), sock2);
    await handleSocketMessage(d, sock2, ctx2, setupMsg('CA1', 'VX2'));
    expect(sock.closed).toEqual({ code: 1000, reason: 'replaced by reconnect' });
    expect(d.store.get('CA1')?.socket).toBe(sock2);
    await handleSocketClose(d, ctx);
    expect(d.store.get('CA1')?.socket).toBe(sock2);
    await handleSocketMessage(d, sock2, ctx2, prompt('I need to reschedule my appointment'));
    expect(texts(sock2).at(-1)).toBe("What's your member ID?");
    expect(frameLines(d.dir).some((f) => f.dir === 'log' && f.msg.staleSocketClosed === true)).toBe(true);
  });

  it('a send failure still ends the call cleanly', async () => {
    const d = deps();
    const sock = failingSocket((type) => type === 'text');
    const tok = d.tokens.mint('CA1');
    const ctx = newConnectionContext(tok, sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    expect(d.store.get('CA1')?.socket).toBeNull();
    for (const t of ["I need to reschedule my appointment, it's with Dr. Chen sometime next week", 'four four seven one eight two nine three', 'yes', 'Tuesday']) {
      await handleSocketMessage(d, sock, ctx, prompt(t));
    }
    expect(d.store.get('CA1')?.ended).toBe(true);
    expect(d.tokens.verify(tok, 'CA1')).toBe(false);
    // Nothing reached the wire, so nothing is logged as sent, and the detached socket is not closed twice.
    expect(sock.closed).toBeNull();
    const lines = frameLines(d.dir);
    expect(lines.some((f) => f.dir === 'log' && f.msg.sendFailed === 'text')).toBe(true);
    expect(lines.filter((f) => f.dir === 'out')).toHaveLength(0);
    expect(lines.some((f) => f.dir === 'log' && (f.msg.dropped as { type?: string } | undefined)?.type === 'end')).toBe(true);
  });

  it('a throwing turn speaks an apology and keeps the call alive', async () => {
    const base = corpusClient();
    let fail = true;
    const d = deps({
      ask: async (req) => {
        if (fail) { fail = false; throw new Error('boom'); }
        return base.ask(req);
      },
    });
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt('I need to reschedule my appointment'));
    expect(texts(sock).at(-1)).toBe(TURN_ERROR_TEXT);
    expect(d.store.get('CA1')?.ended).toBe(false);
    await handleSocketMessage(d, sock, ctx, prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week"));
    expect(texts(sock).at(-1)).toBe("What's your member ID?");
    const failed = frameLines(d.dir).find((f) => f.dir === 'log' && f.msg.turnFailed !== undefined);
    expect((failed?.msg.turnFailed as { message: string }).message).toBe('boom');
  });

  it('logs inbound frames that arrive after the call ended', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    for (const t of ["I need to reschedule my appointment, it's with Dr. Chen sometime next week", 'four four seven one eight two nine three', 'yes', 'Tuesday']) {
      await handleSocketMessage(d, sock, ctx, prompt(t));
    }
    expect(d.store.get('CA1')?.ended).toBe(true);
    const settled = sock.sent.length;
    await handleSocketMessage(d, sock, ctx, prompt('hello? are you still there?'));
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'dtmf', digit: '5' }));
    expect(sock.sent.length).toBe(settled);
    const inbound = frameLines(d.dir).filter((f) => f.dir === 'in');
    expect(inbound).toHaveLength(7);
    expect(inbound.at(-2)?.msg.voicePrompt).toBe('hello? are you still there?');
    expect(inbound.at(-1)?.msg.digit).toBe('5');
  });
});

describe('spokenDigits', () => {
  it('spaces a member ID out into single digits with a pause between groups', () => {
    expect(spokenDigits('Member ID 4471 8293.')).toBe('Member ID 4 4 7 1, 8 2 9 3.');
  });

  it('spaces a single long run', () => {
    expect(spokenDigits('Your code is 44718293.')).toBe('Your code is 4 4 7 1 8 2 9 3.');
  });

  it('leaves short numbers alone', () => {
    expect(spokenDigits('Your appointment with Dr. Chen is moved to Tuesday, September 22.')).toBe(
      'Your appointment with Dr. Chen is moved to Tuesday, September 22.',
    );
    expect(spokenDigits('Press 1 for scheduling, 2 for billing.')).toBe('Press 1 for scheduling, 2 for billing.');
    expect(spokenDigits('123')).toBe('123');
  });

  it('leaves text with no digits untouched', () => {
    expect(spokenDigits(TURN_ERROR_TEXT)).toBe(TURN_ERROR_TEXT);
    expect(spokenDigits('')).toBe('');
  });

  it('handles more than two groups and does not join across other words', () => {
    expect(spokenDigits('1234 5678 9012')).toBe('1 2 3 4, 5 6 7 8, 9 0 1 2');
    expect(spokenDigits('1234 and 5678')).toBe('1 2 3 4 and 5 6 7 8');
  });
});
