import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  forgetNoInput,
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
import { textEstimateMs } from '../prompts/playback';
import { promptText, type RenderContext } from '../prompts/render';
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

function deps(clientOverride?: JevClient, render?: RenderContext): AdapterDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-'));
  const client = clientOverride ?? corpusClient();
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0),
    opts: { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), now: () => 0, render: render ?? null },
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
    // The member ID fills silently: the next question follows it straight away.
    expect(texts(sock).at(-1)).toBe('next week. Which day works for you?');
    await handleSocketMessage(d, sock, ctx, prompt('Tuesday'));
    // The summary reads the whole form back. The wire gets the digits spaced out; the session
    // and the trace keep the readable form.
    expect(texts(sock).at(-1)).toBe('Your appointment with Dr. Chen would move to Tuesday, September 22, member ID 4 4 7 1, 8 2 9 3. Shall I make that change?');
    expect(d.store.get('CA1')?.session.lastPromptText).toBe('Your appointment with Dr. Chen would move to Tuesday, September 22, member ID 4471 8293. Shall I make that change?');
    await handleSocketMessage(d, sock, ctx, prompt('yes'));
    expect(texts(sock).at(-2)).toBe('Your appointment is moved.');
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
    await handleSocketMessage(d, sock, ctx, prompt('Tuesday'));
    await handleSocketMessage(d, sock, ctx, prompt('yes'));
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
    await handleSocketMessage(d, sock, ctx, prompt('Tuesday'));
    await handleSocketMessage(d, sock, ctx, prompt('yes'));
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
    expect(texts(sock).at(-1)).toBe('Your appointment with Dr. Kim would be cancelled, member ID 4 4 7 1, 8 2 9 3. Shall I cancel it?');
    await handleSocketMessage(d, sock, ctx, prompt('yes'));
    expect(texts(sock).at(-2)).toBe('Your appointment is cancelled.');
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
    for (const t of ["I need to reschedule my appointment, it's with Dr. Chen sometime next week", 'four four seven one eight two nine three', 'Tuesday', 'yes']) {
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
    for (const t of ["I need to reschedule my appointment, it's with Dr. Chen sometime next week", 'four four seven one eight two nine three', 'Tuesday', 'yes']) {
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

describe('no-input timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const GREETING = promptText('greeting', {});
  const NO_INPUT = promptText('no_input', {});
  const NOMATCH_OPEN = promptText('nomatch_open', {});
  const DTMF_MENU = promptText('nomatch_dtmf_menu', {});
  const MAX_ATTEMPTS = promptText('handoff_max_attempts', {});
  const WAIT = 100;
  /** When the greeting's timer fires: the wait plus how long the greeting takes to speak. */
  const GREETING_DEADLINE = textEstimateMs(GREETING) + WAIT;

  /** deps with the no-input wait armed, and one measured clip so a play frame can be estimated. */
  function noInputDeps(noInputMs = WAIT, render?: RenderContext): AdapterDeps & { dir: string } {
    return { ...deps(undefined, render), noInputMs, clipDurations: new Map([['greeting.0.wav', 2000]]) };
  }

  /** A connected call that has just heard the greeting, with its no-input timer armed. */
  async function greeted(d: AdapterDeps): Promise<{ sock: Fake; ctx: ReturnType<typeof newConnectionContext> }> {
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    return { sock, ctx };
  }

  const silenceLines = (dir: string) => frameLines(dir).filter((f) => f.dir === 'in' && f.msg.type === 'silence');

  it('arms after a prompt with the playback estimate added and fires a silence turn', async () => {
    const d = noInputDeps();
    const { sock } = await greeted(d);
    expect(texts(sock)).toEqual([GREETING]);
    expect(vi.getTimerCount()).toBe(1);
    const armed = frameLines(d.dir).find((f) => f.dir === 'log' && f.msg.noInputArmedMs !== undefined);
    expect(armed?.msg.noInputArmedMs).toBe(GREETING_DEADLINE);

    await vi.advanceTimersByTimeAsync(GREETING_DEADLINE - 1);
    expect(texts(sock)).toEqual([GREETING]);
    await vi.advanceTimersByTimeAsync(1);
    // The ack goes out as its own frame, ahead of the question the ladder re-asks.
    expect(texts(sock)).toEqual([GREETING, NO_INPUT, NOMATCH_OPEN]);
    expect(d.store.get('CA1')?.session.intentAttempts).toBe(1);
    expect(silenceLines(d.dir)).toHaveLength(1);
  });

  it('uses the clip duration for a play frame', async () => {
    const render: RenderContext = { clips: new Map([['greeting.0', 'greeting.0.wav']]), audioBase: 'https://h/audio/' };
    const d = noInputDeps(WAIT, render);
    const { sock } = await greeted(d);
    // The whole greeting is one recorded clip, so the estimate is the wav's own 2000 ms.
    expect(sock.sent).toEqual([{ type: 'play', source: 'https://h/audio/greeting.0.wav', loop: 1, preemptible: false, interruptible: true }]);
    await vi.advanceTimersByTimeAsync(2000 + WAIT - 1);
    expect(texts(sock)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(texts(sock)).toEqual([NO_INPUT, NOMATCH_OPEN]);
  });

  const partial = (t: string) => JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: false });
  const digit = (d: string) => JSON.stringify({ type: 'dtmf', digit: d });
  const interrupt = JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'Thanks for', durationUntilInterruptMs: 400 });

  const clearing: Array<[string, string]> = [
    ['a final prompt', prompt('I need to reschedule my appointment')],
    ['a partial prompt', partial('I need to')],
    ['a digit', digit('2')],
    ['a keypad terminator', digit('#')],
    ['an interrupt', interrupt],
  ];
  for (const [label, message] of clearing) {
    it(`is cleared by ${label}`, async () => {
      const d = noInputDeps();
      const { sock, ctx } = await greeted(d);
      // The caller reacts with a moment of the wait left, so the greeting's deadline passes below.
      await vi.advanceTimersByTimeAsync(GREETING_DEADLINE - 50);
      await handleSocketMessage(d, sock, ctx, message);
      // Far enough to be past the greeting's own deadline, one ms short of the shortest wait
      // any of these could have restarted.
      await vi.advanceTimersByTimeAsync(WAIT - 1);
      expect(texts(sock)).not.toContain(NO_INPUT);
      expect(silenceLines(d.dir)).toHaveLength(0);
      // A silence turn would have spent an attempt on the intent ladder; nothing did.
      expect(d.store.get('CA1')?.session.intentAttempts).toBe(0);
    });
  }

  // Clearing without re-arming would strand the caller: these are the frames that cancel the
  // wait without a prompt decision of their own to restart it.
  const restarting: Array<[string, string[]]> = [
    ['a partial prompt', [partial('I need to')]],
    ['a keypad terminator', [digit('#')]],
    ['an interrupt', [interrupt]],
  ];
  for (const [label, messages] of restarting) {
    it(`restarts the wait after ${label}`, async () => {
      const d = noInputDeps();
      const { sock, ctx } = await greeted(d);
      for (const m of messages) await handleSocketMessage(d, sock, ctx, m);
      // Nothing was spoken, so the restarted wait is the bare configured one.
      await vi.advanceTimersByTimeAsync(WAIT - 1);
      expect(texts(sock)).toEqual([GREETING]);
      await vi.advanceTimersByTimeAsync(1);
      expect(texts(sock)).toEqual([GREETING, NO_INPUT, NOMATCH_OPEN]);
      expect(d.store.get('CA1')?.session.intentAttempts).toBe(1);
    });
  }

  it('restarts the wait after digits that only fill the keypad buffer', async () => {
    const d = noInputDeps();
    const { sock, ctx } = await greeted(d);
    await handleSocketMessage(d, sock, ctx, prompt('I need to reschedule my appointment'));
    expect(texts(sock).at(-1)).toBe(promptText('ask_memberId', {}));
    // Two digits of an eight digit ID: the turn runs but decides nothing, so only this re-arm
    // keeps the caller from being left with a half-typed buffer and an open line.
    for (const n of ['4', '4']) await handleSocketMessage(d, sock, ctx, digit(n));
    expect(d.store.get('CA1')?.session.dtmfBuffer).toBe('44');
    await vi.advanceTimersByTimeAsync(WAIT - 1);
    expect(texts(sock)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(texts(sock).slice(-2)).toEqual([NO_INPUT, promptText('ask_memberId_retry', {})]);
    // Silence abandons the half-typed ID rather than carrying it into the retry.
    expect(d.store.get('CA1')?.session.dtmfBuffer).toBe('');
  });

  it('arms after the apology a failed turn speaks', async () => {
    const base = corpusClient();
    let fail = true;
    const client: JevClient = {
      ask: async (req) => {
        if (fail) {
          fail = false;
          throw new Error('boom');
        }
        return base.ask(req);
      },
    };
    const d: AdapterDeps & { dir: string } = { ...deps(client), noInputMs: WAIT, clipDurations: new Map() };
    const { sock, ctx } = await greeted(d);
    await handleSocketMessage(d, sock, ctx, prompt('I need to reschedule my appointment'));
    expect(texts(sock).at(-1)).toBe(TURN_ERROR_TEXT);
    await vi.advanceTimersByTimeAsync(textEstimateMs(TURN_ERROR_TEXT) + WAIT);
    // "Please say that again" is a question; a caller who says nothing after it walks the ladder.
    expect(texts(sock).slice(-2)).toEqual([NO_INPUT, NOMATCH_OPEN]);
  });

  it('estimates on the frames as they went out, digit spacing included', async () => {
    const d = noInputDeps();
    const { sock, ctx } = await greeted(d);
    for (const t of ["I need to reschedule my appointment, it's with Dr. Chen sometime next week", 'four four seven one eight two nine three', 'Tuesday']) {
      await handleSocketMessage(d, sock, ctx, prompt(t));
    }
    const spoken = texts(sock).at(-1)!;
    expect(spoken).toContain('4 4 7 1, 8 2 9 3');
    const armed = frameLines(d.dir).filter((f) => f.dir === 'log' && f.msg.noInputArmedMs !== undefined).at(-1);
    expect(armed?.msg.noInputArmedMs).toBe(textEstimateMs(spoken) + WAIT);
    // Twilio reads eight separate digits, which takes longer than the readable form the session
    // keeps; estimating on the unrewritten text would have cut the wait short.
    const readable = d.store.get('CA1')!.session.lastPromptText;
    expect(textEstimateMs(readable)).toBeLessThan(textEstimateMs(spoken));
  });

  it('is cleared by a reconnect setup', async () => {
    const d = noInputDeps();
    await greeted(d);
    const sock2 = fakeSocket();
    const ctx2 = newConnectionContext(d.tokens.mint('CA1'), sock2);
    await handleSocketMessage(d, sock2, ctx2, setupMsg('CA1', 'VX2'));
    // The reconnect replays the last prompt without running a turn, so nothing re-arms.
    expect(texts(sock2)).toEqual([GREETING]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(texts(sock2)).toEqual([GREETING]);
    expect(silenceLines(d.dir)).toHaveLength(0);
  });

  it('forgetting a call cancels its wait', async () => {
    const d = noInputDeps();
    const { sock } = await greeted(d);
    expect(vi.getTimerCount()).toBe(1);
    forgetNoInput('CA1');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(texts(sock)).toEqual([GREETING]);
    expect(silenceLines(d.dir)).toHaveLength(0);
  });

  it('stops the wait the moment a final prompt arrives, not when its turn answers', async () => {
    const base = corpusClient();
    const slow: JevClient = {
      ask: async (req) => {
        await new Promise((r) => setTimeout(r, 500));
        return base.ask(req);
      },
    };
    const d: AdapterDeps & { dir: string } = { ...deps(slow), noInputMs: WAIT, clipDurations: new Map() };
    const { sock, ctx } = await greeted(d);
    expect(vi.getTimerCount()).toBe(1);
    const running = handleSocketMessage(d, sock, ctx, prompt('I need to reschedule my appointment'));
    // The frame has been logged and the wait dropped, but the turn itself has not started yet:
    // the caller is audibly there, so nothing should still be counting down while the model thinks.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    await running;
    expect(texts(sock)).toEqual([GREETING, "What's your member ID?"]);
    expect(silenceLines(d.dir)).toHaveLength(0);
  });

  it('is a no-op when the caller spoke just as it fired', async () => {
    const d = noInputDeps();
    const { sock, ctx } = await greeted(d);
    // Synchronous on purpose: the timer's callback queues the silence turn, and nothing has
    // drained the per-call queue yet.
    vi.advanceTimersByTime(GREETING_DEADLINE);
    // handleSocketMessage clears the timer before its first await, so the queued closure finds
    // the generation already moved on and does nothing.
    await handleSocketMessage(d, sock, ctx, prompt('I need to reschedule my appointment'));
    expect(texts(sock)).toEqual([GREETING, "What's your member ID?"]);
    expect(silenceLines(d.dir)).toHaveLength(0);
    expect(d.store.get('CA1')?.session.intentAttempts).toBe(0);
  });

  it('never arms after a completion', async () => {
    const d = noInputDeps();
    const { sock, ctx } = await greeted(d);
    for (const t of ["I need to reschedule my appointment, it's with Dr. Chen sometime next week", 'four four seven one eight two nine three', 'Tuesday', 'yes']) {
      await handleSocketMessage(d, sock, ctx, prompt(t));
    }
    expect(sock.sent.at(-1)).toMatchObject({ type: 'end' });
    // Only the end-close backstop is left; the no-input timer is gone.
    expect(vi.getTimerCount()).toBe(1);
    await handleSocketClose(d, ctx);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(texts(sock)).not.toContain(NO_INPUT);
  });

  it('never arms after a handoff', async () => {
    const d = noInputDeps();
    const { sock, ctx } = await greeted(d);
    await handleSocketMessage(d, sock, ctx, prompt('I want to talk to a person'));
    expect(sock.sent.at(-1)).toMatchObject({ type: 'end', handoffData: '{"reasonCode":"live-agent"}' });
    expect(vi.getTimerCount()).toBe(1);
    await handleSocketClose(d, ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-arms after its own re-ask and walks the ladder to the keypad menu and the handoff', async () => {
    const d = noInputDeps();
    const { sock, ctx } = await greeted(d);
    await vi.advanceTimersByTimeAsync(GREETING_DEADLINE);
    expect(texts(sock)).toEqual([GREETING, NO_INPUT, NOMATCH_OPEN]);

    await vi.advanceTimersByTimeAsync(textEstimateMs(NO_INPUT) + textEstimateMs(NOMATCH_OPEN) + WAIT);
    expect(texts(sock).slice(-2)).toEqual([NO_INPUT, DTMF_MENU]);

    await vi.advanceTimersByTimeAsync(textEstimateMs(NO_INPUT) + textEstimateMs(DTMF_MENU) + WAIT);
    expect(texts(sock).slice(-2)).toEqual([NO_INPUT, MAX_ATTEMPTS]);
    expect(sock.sent.at(-1)).toMatchObject({ type: 'end', handoffData: '{"reasonCode":"max-attempts"}' });
    expect(d.store.get('CA1')?.ended).toBe(true);
    expect(silenceLines(d.dir)).toHaveLength(3);
    // The handoff stops the ladder: what is left is the end-close backstop, not another wait.
    expect(vi.getTimerCount()).toBe(1);
    await handleSocketClose(d, ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is cleared by a socket close', async () => {
    const d = noInputDeps();
    const { sock, ctx } = await greeted(d);
    expect(vi.getTimerCount()).toBe(1);
    await handleSocketClose(d, ctx);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(texts(sock)).toEqual([GREETING]);
    expect(silenceLines(d.dir)).toHaveLength(0);
  });

  it('never arms when the wait is zero', async () => {
    const d = noInputDeps(0);
    const { sock } = await greeted(d);
    expect(texts(sock)).toEqual([GREETING]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(texts(sock)).toEqual([GREETING]);
    expect(frameLines(d.dir).some((f) => f.dir === 'log' && f.msg.noInputArmedMs !== undefined)).toBe(false);
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
    // The summary's member ID arrives as a text frame of its own, between recorded clips.
    expect(spokenDigits('4471 8293')).toBe('4 4 7 1, 8 2 9 3');
    expect(spokenDigits('1234 and 5678')).toBe('1 2 3 4 and 5 6 7 8');
  });
});
