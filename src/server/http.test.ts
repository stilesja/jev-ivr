import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipName, createRequestHandler, decideActionTwiml, type HttpDeps } from './http';
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

function deps(overrides: Record<string, string> = {}, audioDir?: string): HttpDeps {
  const dir = mkdtempSync(join(tmpdir(), 'http-'));
  const config = loadConfig({
    PUBLIC_HOST: 'demo.ngrok.app',
    TWILIO_AUTH_TOKEN: TOKEN,
    HANDOFF_NUMBER: '+15551234567',
    RECONNECT_LIMIT: '1',
    AUDIO_DIR: audioDir ?? dir,
    ...overrides,
  });
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

async function get(base: string, path: string) {
  const res = await fetch(base + path);
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) };
}

async function head(base: string, path: string) {
  const res = await fetch(base + path, { method: 'HEAD' });
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) };
}

describe('http routes', () => {
  it('serves health, counting live sessions apart from ended ones still retained', async () => {
    const d = deps();
    const base = await listen(d);
    expect(await (await fetch(base + '/health')).json()).toEqual({ ok: true, sessions: 0, retained: 0 });
    const sock = { send: () => {}, close: () => {} };
    d.store.create('CA1', sock);
    d.store.create('CA2', sock);
    expect(await (await fetch(base + '/health')).json()).toEqual({ ok: true, sessions: 2, retained: 0 });
    d.store.end('CA2');
    const res = await fetch(base + '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessions: 1, retained: 1 });
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

  it('serves audio clips with the right type and cache headers, and nothing else under /audio', async () => {
    const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
    const base = await listen(deps({}, audioDir));
    const get_ = (path: string) => get(base, path);
    const head_ = (path: string) => head(base, path);
    writeFileSync(join(audioDir, 'greeting.0.wav'), Buffer.from('RIFFdata'));
    writeFileSync(join(audioDir, 'Loud.0.WAV'), Buffer.from('RIFFloud'));
    const ok = await get_('/audio/greeting.0.wav');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('audio/wav');
    expect(ok.headers['cache-control']).toBe('public, max-age=86400');
    expect(ok.body.toString()).toBe('RIFFdata');
    // No Twilio signature header is sent, and /audio still answers 200: this route is not gated
    // by the signature check that /voice and /cr-action apply.
    const headRes = await head_('/audio/greeting.0.wav');
    expect(headRes.status).toBe(200);
    expect(headRes.headers['content-length']).toBe(String(Buffer.byteLength('RIFFdata')));
    expect(headRes.body.length).toBe(0);
    expect((await get_('/audio/Loud.0.WAV')).headers['content-type']).toBe('audio/wav');
    expect((await get_('/audio/missing.wav')).status).toBe(404);
    expect((await get_('/audio/notes.txt')).status).toBe(404);
    // fetch's URL parser collapses a literal `../` before the request is even sent, so these
    // traversal attempts are shaped to survive that normalization and actually reach the
    // server: an escaped `/` inside what would otherwise be a `..` segment.
    expect((await get_('/audio/..%2fpackage.json')).status).toBe(404);
    expect((await get_('/audio/%2e%2e%2fetc%2fpasswd')).status).toBe(404);
    expect((await get_('/audio/sub%2fclip.wav')).status).toBe(404);
    expect((await get_('/audio/%E0%A4%A')).status).toBe(404);
  });

  it('serves a clip when the request carries a content-hash query string', async () => {
    const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
    const base = await listen(deps({}, audioDir));
    writeFileSync(join(audioDir, 'greeting.0.wav'), Buffer.from('RIFFdata'));
    const res = await get(base, '/audio/greeting.0.wav?v=abc1234567');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(res.body.toString()).toBe('RIFFdata');
  });
});

describe('clipName', () => {
  it('decodes a well-formed clip name and rejects traversal, wrong extensions, and bad percent-encoding', () => {
    expect(clipName('greeting.0.wav')).toBe('greeting.0.wav');
    expect(clipName('Loud.0.WAV')).toBe('Loud.0.WAV');
    expect(clipName('..%2fpackage.json')).toBeNull();
    expect(clipName('%2e%2e%2fetc%2fpasswd')).toBeNull();
    expect(clipName('sub%2fclip.wav')).toBeNull();
    expect(clipName('notes.txt')).toBeNull();
    expect(clipName('%E0%A4%A')).toBeNull();
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

  it('decides on the reason code alone, whatever else the handoff data carries', () => {
    const d = deps();
    // The end frame also reports completed forms, the unstarted queue and the slots the call
    // collected; those ride through to Twilio untouched and must not change the decision here.
    const data = '{"reasonCode":"billing","completed":["reschedule"],"queued":["cancel"],"slots":{"memberId":"4471 8293"}}';
    const r = decideActionTwiml(d, { CallSid: 'CA1', HandoffData: data });
    expect(r.twiml).toContain('<Dial>+15551234567</Dial>');
    expect(r.note).toBe('dial:billing');
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
