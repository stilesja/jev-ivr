import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestHandler, decideActionTwiml, type HttpDeps } from './http';
import { loadConfig } from './config';
import { computeTwilioSignature } from './signature';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';

const TOKEN = 'authtok';
let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function deps(overrides: Record<string, string> = {}): HttpDeps {
  const dir = mkdtempSync(join(tmpdir(), 'http-'));
  const config = loadConfig({ PUBLIC_HOST: 'demo.ngrok.app', TWILIO_AUTH_TOKEN: TOKEN, HANDOFF_NUMBER: '+15551234567', RECONNECT_LIMIT: '1', ...overrides });
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0),
    opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18' },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000);
  return { config, store, tokens: new CallTokens(60_000), hints: 'Dr. Chen', log: () => {} };
}

async function listen(d: HttpDeps): Promise<string> {
  server = createServer(createRequestHandler(d));
  await new Promise<void>((r) => server!.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

async function post(base: string, path: string, params: Record<string, string>, sign = true, host = 'demo.ngrok.app') {
  const body = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = computeTwilioSignature(`https://${host}${path}`, params, TOKEN);
  const res = await fetch(base + path, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

describe('http routes', () => {
  it('serves health', async () => {
    const base = await listen(deps());
    const res = await fetch(base + '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessions: 0 });
  });

  it('answers /voice with connect TwiML and a token bound to the call', async () => {
    const d = deps();
    const base = await listen(d);
    const r = await post(base, '/voice', { CallSid: 'CA1', From: '+1', To: '+2' });
    expect(r.status).toBe(200);
    const token = /token=([0-9a-f]{32})/.exec(r.text)?.[1];
    expect(token).toBeDefined();
    expect(d.tokens.verify(token!, 'CA1')).toBe(true);
    expect(r.text).toContain('hints="Dr. Chen"');
  });

  it('rejects a missing or bad signature', async () => {
    const base = await listen(deps());
    expect((await post(base, '/voice', { CallSid: 'CA1' }, false)).status).toBe(403);
    expect((await post(base, '/cr-action', { CallSid: 'CA1' }, true, 'other.host')).status).toBe(403);
  });

  it('honors SIGNATURE_CHECK=off', async () => {
    const base = await listen(deps({ SIGNATURE_CHECK: 'off' }));
    expect((await post(base, '/voice', { CallSid: 'CA1' }, false)).status).toBe(200);
  });

  it('returns 404 elsewhere', async () => {
    const base = await listen(deps());
    expect((await fetch(base + '/nope')).status).toBe(404);
  });

  it('returns 413 for an oversized body', async () => {
    const base = await listen(deps());
    const big = 'x'.repeat(70 * 1024);
    const r = await post(base, '/voice', { CallSid: 'CA1', Big: big });
    expect(r.status).toBe(413);
  });

  it('returns 400 for /voice without CallSid', async () => {
    const base = await listen(deps());
    const r = await post(base, '/voice', { From: '+1' });
    expect(r.status).toBe(400);
  });

  it('answers HEAD /health', async () => {
    const base = await listen(deps());
    const res = await fetch(base + '/health', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('decideActionTwiml', () => {
  it('hangs up on completed, dials on any other handoff reason, and revokes the token', () => {
    const d = deps();
    d.tokens.mint('CA1');
    expect(decideActionTwiml(d, { CallSid: 'CA1', HandoffData: '{"reasonCode":"completed"}' }).twiml).toContain('<Hangup/>');
    expect(d.tokens.verify('x', 'CA1')).toBe(false);
    expect(decideActionTwiml(d, { CallSid: 'CA2', HandoffData: '{"reasonCode":"live-agent"}' }).twiml).toContain('<Dial>+15551234567</Dial>');
    expect(decideActionTwiml(d, { CallSid: 'CA3', HandoffData: 'not json' }).twiml).toContain('<Dial>');
  });

  it('reconnects a live call up to the limit, then apologizes and dials', () => {
    const d = deps();
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const first = decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(first.twiml).toContain('<ConversationRelay');
    const token = /token=([0-9a-f]{32})/.exec(first.twiml)![1]!;
    expect(d.tokens.verify(token, 'CA1')).toBe(true);
    expect(d.store.get('CA1')?.reconnects).toBe(1);
    const second = decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(second.twiml).toContain('<Say>');
    expect(second.twiml).toContain('<Dial>+15551234567</Dial>');
    expect(d.store.get('CA1')?.ended).toBe(true);
  });

  it('hangs up for an unknown or finished call', () => {
    const d = deps();
    expect(decideActionTwiml(d, { CallSid: 'CA9', CallStatus: 'completed' }).twiml).toContain('<Hangup/>');
    d.store.create('CA1', { send: () => {}, close: () => {} });
    d.store.end('CA1');
    expect(decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress' }).twiml).toContain('<Hangup/>');
  });

  it('hangs up when the caller hung up', () => {
    const d = deps();
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const token = d.tokens.mint('CA1');
    const result = decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'completed', SessionStatus: 'completed' });
    expect(result.twiml).toContain('<Hangup/>');
    expect(d.store.get('CA1')?.ended).toBe(true);
    expect(d.tokens.verify(token, 'CA1')).toBe(false);
  });

  it('treats empty HandoffData as absent', () => {
    const d = deps();
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const result = decideActionTwiml(d, { CallSid: 'CA1', HandoffData: '', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(result.twiml).toContain('<ConversationRelay');
    expect(result.twiml).not.toContain('<Dial>');
  });
});
