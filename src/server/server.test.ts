import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import type { JevClient } from '../jev/types';

let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function start(client?: JevClient) {
  const traceDir = mkdtempSync(join(tmpdir(), 'server-'));
  const config = loadConfig({
    PUBLIC_HOST: 'localhost',
    TWILIO_AUTH_TOKEN: 't',
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: traceDir,
  });
  running = await startServer(config, { client, log: () => {} });
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

describe('server end to end', () => {
  it('greets on setup and rejects a bad token', async () => {
    const { relay, ws } = await connected();
    expect(relay.texts()).toEqual(['Thanks for calling the clinic. How can I help you today?']);
    const bad = await FakeRelay.connect(`${ws}?token=nope`);
    bad.setup('CA2');
    const end = await bad.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"unauthorized"}');
    expect((await bad.closed).code).toBe(1008);
  });

  it('runs the worked example over the socket and ends the call', async () => {
    const { relay, traceDir, callSid } = await connected();
    relay.prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week");
    expect((await relay.waitForTexts(2)).at(-1)).toBe("What's your member ID?");
    relay.prompt('four four seven one eight two nine three');
    expect((await relay.waitForTexts(4)).slice(-2)).toEqual(['Member ID 4471 8293.', 'Which day next week works for you?']);
    relay.prompt('Tuesday');
    const end = await relay.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"completed"}');
    expect(relay.texts().at(-1)).toBe('Your appointment with Dr. Chen is moved to Tuesday, September 22. Goodbye.');
    expect((await relay.closed).code).toBe(1000);
    expect(existsSync(join(traceDir, `${callSid}.jsonl`))).toBe(true);
    expect(existsSync(join(traceDir, `${callSid}.frames.jsonl`))).toBe(true);
    expect(readFileSync(join(traceDir, `${callSid}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(4);
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

  it('serializes a prompt and a digit that arrive back to back', async () => {
    const slow: JevClient = {
      ask: async (req) => {
        await new Promise((r) => setTimeout(r, 150));
        const { FixtureStubClient } = await import('../jev/fixtureStub');
        const { HeuristicStubClient } = await import('../jev/heuristicStub');
        const { loadCorpus } = await import('../jev/corpus');
        return new FixtureStubClient(loadCorpus('fixtures/corpus.jsonl'), { sharpness: 0.9, fallback: new HeuristicStubClient() }).ask(req);
      },
    };
    const s = await start(slow);
    const token = running!.tokens.mint('CA7');
    const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
    relay.setup('CA7');
    await relay.waitForTexts(1);
    relay.prompt('Cancel my appointment with Dr. Kim please');
    relay.dtmf('44718293');
    const end = await relay.waitFor((m) => m.type === 'end', 6000);
    expect(end.handoffData).toBe('{"reasonCode":"completed"}');
    const records = readFileSync(join(s.traceDir, 'CA7.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(records.map((r) => r.event.type)).toEqual(['setup', 'prompt', ...Array(8).fill('dtmf')]);
    expect(records[1].decision.promptId).toBe('ask_memberId');
  });

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
    expect(safeFileStem('../etc/passwd')).toBe('.._etc_passwd');
    expect(safeFileStem('')).toBe('unknown');
  });

  it('exposes health and refuses upgrades on other paths', async () => {
    const s = await start();
    const res = await fetch(`${s.base}/health`);
    expect(await res.json()).toEqual({ ok: true, sessions: 0 });
    await expect(FakeRelay.connect(`ws://127.0.0.1:${running!.port}/other`)).rejects.toBeDefined();
  });
});
