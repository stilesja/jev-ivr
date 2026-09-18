import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer, type ServerOverrides } from './index';
import { loadConfig } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import type { JevClient } from '../jev/types';

let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

/** Shaped like a minted token (32 hex), but never minted: the upgrade itself must refuse it. */
const UNMINTED_TOKEN = 'f'.repeat(32);

function makeConfig(extra: Record<string, string> = {}) {
  const traceDir = mkdtempSync(join(tmpdir(), 'server-'));
  const config = loadConfig({
    PUBLIC_HOST: 'localhost',
    TWILIO_AUTH_TOKEN: 't',
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: traceDir,
    ...extra,
  });
  return { traceDir, config };
}

async function start(client?: JevClient, overrides: Omit<ServerOverrides, 'client' | 'log'> = {}) {
  const { traceDir, config } = makeConfig();
  running = await startServer(config, { client, log: () => {}, ...overrides });
  return { traceDir, base: `http://127.0.0.1:${running.port}`, ws: `ws://127.0.0.1:${running.port}/conversation` };
}

async function connected(callSid = 'CA1') {
  const s = await start();
  const token = running!.tokens.mint(callSid);
  const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
  relay.setup(callSid);
  await relay.waitForTexts(1);
  return { ...s, relay, callSid };
}

/** The corpus is expensive to load, so the delaying client shares one fixture client across its calls. */
let sharedStub: JevClient | null = null;
async function fixtureStub(): Promise<JevClient> {
  if (!sharedStub) {
    const { FixtureStubClient } = await import('../jev/fixtureStub');
    const { HeuristicStubClient } = await import('../jev/heuristicStub');
    const { loadCorpus } = await import('../jev/corpus');
    sharedStub = new FixtureStubClient(loadCorpus('fixtures/corpus.jsonl'), { sharpness: 0.9, fallback: new HeuristicStubClient() });
  }
  return sharedStub;
}

describe('server end to end', () => {
  it('greets on setup and refuses a well-shaped token that was never minted', async () => {
    const { relay, ws } = await connected();
    expect(relay.texts()).toEqual(['Thanks for calling the clinic. How can I help you today?']);
    // The upgrade knows the token but not the call SID, and this one is live for no call at all,
    // so it never gets a socket to send setup on.
    await expect(FakeRelay.connect(`${ws}?token=${UNMINTED_TOKEN}`)).rejects.toThrow(/401/);
  });

  it('refuses a setup whose token belongs to another call', async () => {
    const s = await start();
    // Minted for CA1, so the upgrade passes; the binding to a call SID is still checked at setup.
    const token = running!.tokens.mint('CA1');
    const bad = await FakeRelay.connect(`${s.ws}?token=${token}`);
    bad.setup('CA2');
    const end = await bad.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"unauthorized"}');
    expect((await bad.closed).code).toBe(1008);
    expect(running!.store.get('CA2')).toBeUndefined();
  });

  it('logs a relay error frame and keeps the call going', async () => {
    const { relay, traceDir, callSid } = await connected();
    relay.error('Text-to-speech failed for the previous token');
    relay.prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week");
    expect((await relay.waitForTexts(2)).at(-1)).toBe("What's your member ID?");
    const frames = readFileSync(join(traceDir, `${callSid}.frames.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> });
    const err = frames.find((f) => f.dir === 'in' && f.msg.type === 'error');
    expect(err?.msg.description).toBe('Text-to-speech failed for the previous token');
    // An error frame is state, not a turn: it produces no decision and no frames of its own.
    const records = readFileSync(join(traceDir, `${callSid}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.map((r) => r.event.type)).toEqual(['setup', 'error', 'prompt']);
    expect(records[1].decision.kind).toBe('ignore');
    relay.assertKnownTypes();
  });

  it('refuses an upgrade without a token', async () => {
    const s = await start();
    await expect(FakeRelay.connect(s.ws)).rejects.toBeDefined();
    await expect(FakeRelay.connect(`${s.ws}?token=nope`)).rejects.toBeDefined();
  });

  it('closes a connection that never sends setup', async () => {
    const s = await start(undefined, { setupTimeoutMs: 500 });
    const token = running!.tokens.mint('CA9');
    const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
    expect((await relay.closed).code).toBe(1008);
  });

  it('keeps a call open after the setup deadline once setup succeeded', async () => {
    const s = await start(undefined, { setupTimeoutMs: 500 });
    const token = running!.tokens.mint('CA8');
    const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
    relay.setup('CA8');
    await relay.waitForTexts(1);
    await new Promise((r) => setTimeout(r, 1000));
    relay.prompt('I need to reschedule my appointment');
    expect((await relay.waitForTexts(2)).length).toBe(2);
    const stillOpen = Symbol('open');
    const settled = await Promise.race([relay.closed, new Promise((r) => setTimeout(() => r(stillOpen), 100))]);
    expect(settled).toBe(stillOpen);
  });

  it('does not time out an authenticated call whose first turn is slow', async () => {
    const slow: JevClient = {
      ask: async (req) => {
        const stub = await fixtureStub();
        await new Promise((r) => setTimeout(r, 500));
        return stub.ask(req);
      },
    };
    const s = await start(slow, { setupTimeoutMs: 500 });
    const token = running!.tokens.mint('CA10');
    const first = await FakeRelay.connect(`${s.ws}?token=${token}`);
    first.setup('CA10');
    await first.waitForTexts(1);
    // Only prompt turns consult the model, so the way a setup handler outlives the deadline is a
    // reconnect whose replay queues behind a slow turn that is already running.
    first.prompt('I need to reschedule my appointment');
    const again = await FakeRelay.connect(`${s.ws}?token=${token}`);
    again.setup('CA10', 'VX-slow');
    const stillOpen = Symbol('open');
    const settled = await Promise.race([again.closed, new Promise((r) => setTimeout(() => r(stillOpen), 1000))]);
    expect(settled).toBe(stillOpen);
    // The reconnect hears the replayed prompt, and the slow turn's own frames land on this socket too.
    expect((await again.waitForTexts(1)).length).toBeGreaterThanOrEqual(1);
  });

  it('reports a port in use as a clean error', async () => {
    await start();
    const { config } = makeConfig({ PORT: String(running!.port) });
    await expect(startServer(config, { log: () => {} })).rejects.toThrow(/EADDRINUSE/);
  });

  it('runs the worked example over the socket and ends the call', async () => {
    const { relay, traceDir, callSid } = await connected();
    relay.prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week");
    expect((await relay.waitForTexts(2)).at(-1)).toBe("What's your member ID?");
    relay.prompt('four four seven one eight two nine three');
    // Twilio's TTS would read "4471 8293" as two numbers, so the wire carries spaced digits.
    expect((await relay.waitForTexts(4)).slice(-2)).toEqual(['Member ID 4 4 7 1, 8 2 9 3.', 'Which day next week works for you?']);
    relay.prompt('Tuesday');
    const end = await relay.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"completed"}');
    expect(relay.texts().at(-1)).toBe('Your appointment with Dr. Chen is moved to Tuesday, September 22. Goodbye.');
    expect((await relay.closed).code).toBe(1000);
    expect(existsSync(join(traceDir, `${callSid}.jsonl`))).toBe(true);
    expect(existsSync(join(traceDir, `${callSid}.frames.jsonl`))).toBe(true);
    expect(readFileSync(join(traceDir, `${callSid}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(4);
    relay.assertKnownTypes();
  });

  it('handles dtmf and agent handoff', async () => {
    const { relay } = await connected();
    relay.prompt('Cancel my appointment with Dr. Kim please');
    await relay.waitForTexts(2);
    relay.dtmf('44718293');
    const end = await relay.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"completed"}');
    const token2 = running!.tokens.mint('CA5');
    const second = await FakeRelay.connect(`ws://127.0.0.1:${running!.port}/conversation?token=${token2}`);
    second.setup('CA5');
    await second.waitForTexts(1);
    second.prompt('I want to talk to a person');
    const handoff = await second.waitFor((m) => m.type === 'end');
    expect(handoff.handoffData).toBe('{"reasonCode":"live-agent"}');
    expect(second.texts().at(-1)).toBe('One moment while I connect you to someone who can help.');
  });

  it(
    'serializes a prompt and a digit that arrive back to back',
    async () => {
      const slow: JevClient = {
        ask: async (req) => {
          const stub = await fixtureStub();
          await new Promise((r) => setTimeout(r, 150));
          return stub.ask(req);
        },
      };
      const s = await start(slow);
      const token = running!.tokens.mint('CA7');
      const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
      relay.setup('CA7');
      await relay.waitForTexts(1);
      relay.prompt('Cancel my appointment with Dr. Kim please');
      relay.dtmf('44718293');
      const end = await relay.waitFor((m) => m.type === 'end', 4000);
      expect(end.handoffData).toBe('{"reasonCode":"completed"}');
      const records = readFileSync(join(s.traceDir, 'CA7.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(records.map((r) => r.event.type)).toEqual(['setup', 'prompt', ...Array(8).fill('dtmf')]);
      expect(records[1].decision.promptId).toBe('ask_memberId');
    },
    { timeout: 8000 },
  );

  it('records an interrupt as barge-in on the next prompt turn', async () => {
    const { relay, traceDir, callSid } = await connected();
    relay.interrupt('Thanks for', 300);
    relay.prompt('I need to reschedule my appointment');
    await relay.waitForTexts(2);
    const records = readFileSync(join(traceDir, `${callSid}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(records.at(-1).turnState.asr.bargeIn).toBe(true);
  });

  it('sanitizes call sids before building file names', async () => {
    const { safeFileStem } = await import('./index');
    expect(safeFileStem('CA' + 'a'.repeat(32))).toBe('CA' + 'a'.repeat(32));
    expect(safeFileStem('../etc/passwd')).toBe('___etc_passwd');
    expect(safeFileStem('CA1.frames')).toBe('CA1_frames');
    expect(safeFileStem('')).toBe('unknown');
  });

  it('exposes health and refuses upgrades on other paths', async () => {
    const s = await start();
    const res = await fetch(`${s.base}/health`);
    expect(await res.json()).toEqual({ ok: true, sessions: 0, retained: 0 });
    await expect(FakeRelay.connect(`ws://127.0.0.1:${running!.port}/other`)).rejects.toBeDefined();
  });

  it('reconnects a dropped call through the action callback and resumes the form', async () => {
    const { relay, base, ws, callSid } = await connected();
    relay.prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week");
    await relay.waitForTexts(2);
    relay.close();
    await relay.closed;
    const body = new URLSearchParams({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' }).toString();
    const res = await fetch(`${base}/cr-action`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const twiml = await res.text();
    expect(twiml).toContain('<ConversationRelay');
    const token = /token=([0-9a-f]{32})/.exec(twiml)![1]!;
    const again = await FakeRelay.connect(`${ws}?token=${token}`);
    again.setup(callSid, 'VX-second');
    expect(await again.waitForTexts(1)).toEqual(["What's your member ID?"]);
    again.prompt('four four seven one eight two nine three');
    expect((await again.waitForTexts(3)).at(-1)).toBe('Which day next week works for you?');
    const done = await fetch(`${base}/cr-action`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' }).toString(),
    });
    expect(await done.text()).toContain('<ConversationRelay');
    // That callback minted a fresh token for the call, so the one this connection used is now
    // stale: it is live for no call at all and the upgrade refuses it before any setup.
    await expect(FakeRelay.connect(`${ws}?token=${token}`)).rejects.toThrow(/401/);
    const third = await fetch(`${base}/cr-action`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' }).toString(),
    });
    expect(await third.text()).toContain('<Dial>+15551234567</Dial>');
    expect(running!.store.get(callSid)?.ended).toBe(true);
  });
});
