import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateClips, resolveVoice, ttsRequest, type GenerateOptions } from './generate';
import { recordableClips } from './clips';
import tags from './tags.json';

const row = { id: 'ack_provider.0', text: 'With', note: 'open' as const };

describe('ttsRequest', () => {
  it('prefixes the tag, sets the model header, and never includes the key in the printable form', () => {
    const r = ttsRequest(row, { voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[warm]', tags: { 'ack_provider.0': '[warm and brisk]' } });
    expect(r.url).toBe('https://api.fish.audio/v1/tts');
    expect(r.headers.model).toBe('s2.1-pro');
    expect(r.body).toEqual({ text: '[warm and brisk] With', reference_id: 'v1', format: 'wav', temperature: 0.7, prosody: { speed: 1, volume: 0 } });
    expect(ttsRequest({ ...row, id: 'greeting.0' }, { voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[warm]', tags: {} }).body.text).toBe('[warm] With');
    expect(JSON.stringify(r)).not.toMatch(/Bearer/);
  });
});

describe('resolveVoice', () => {
  it('returns an id unchanged and looks a title up in the list response', async () => {
    const fetchStub = async (url: string) => ({ ok: true, status: 200, json: async () => ({ items: [{ _id: 'abc123', title: 'Hanna' }, { _id: 'zzz', title: 'Hannah B' }] }), arrayBuffer: async () => new ArrayBuffer(0) });
    expect(await resolveVoice('abc123def', 'k', fetchStub as never)).toBe('abc123def');
    expect(await resolveVoice('Hanna', 'k', fetchStub as never)).toBe('abc123');
    await expect(resolveVoice('Hannah', 'k', fetchStub as never)).rejects.toThrow(/no voice titled "Hannah".*Hanna, Hannah B/);
    await expect(resolveVoice('Nobody', 'k', async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as never)).rejects.toThrow(/no voice titled/);
  });
});

describe('generateClips', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audio-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const opts = (over: Partial<GenerateOptions> = {}): GenerateOptions => ({ audioDir: dir, apiKey: 'k', voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[warm]', tags: {}, candidates: 1, force: false, only: null, dryRun: false, ...over });
  const calls: string[] = [];
  const fetchStub = async (_url: string, init: { body: string }) => { calls.push(JSON.parse(init.body).text); return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('RIFF' + calls.length).buffer }; };

  it('writes missing clips only, skips present ones, records what was generated, and reports counts', async () => {
    const r = await generateClips([row, { id: 'greeting.0', text: 'Hi.', note: 'closed' }], opts(), fetchStub as never);
    expect(readdirSync(dir).sort()).toEqual(['ack_provider.0.wav', 'greeting.0.wav', 'recorded.json']);
    expect(readFileSync(join(dir, 'ack_provider.0.wav'), 'utf8')).toBe('RIFF1');
    expect(JSON.parse(readFileSync(join(dir, 'recorded.json'), 'utf8'))).toEqual({ 'ack_provider.0': 'With', 'greeting.0': 'Hi.' });
    expect(r).toEqual({ generated: ['ack_provider.0', 'greeting.0'], skipped: [], failed: [] });
    const again = await generateClips([row], opts(), fetchStub as never);
    expect(again.skipped).toEqual(['ack_provider.0']);
    expect(calls).toHaveLength(2);
  });

  it('merges into an existing sidecar and overwrites the entry on --force', async () => {
    await generateClips([row], opts(), fetchStub as never);
    await generateClips([{ id: 'greeting.0', text: 'Hi.', note: 'closed' }], opts(), fetchStub as never);
    await generateClips([{ ...row, text: 'With!' }], opts({ force: true }), fetchStub as never);
    expect(JSON.parse(readFileSync(join(dir, 'recorded.json'), 'utf8'))).toEqual({ 'ack_provider.0': 'With!', 'greeting.0': 'Hi.' });
  });

  it('writes candidates under candidates/<id>-<n> when asked, without touching the sidecar, and honors --only', async () => {
    await generateClips([row, { id: 'greeting.0', text: 'Hi.', note: 'closed' }], opts({ candidates: 2, only: ['greeting.0'] }), fetchStub as never);
    expect(readdirSync(join(dir, 'candidates')).sort()).toEqual(['greeting.0-1.wav', 'greeting.0-2.wav']);
    expect(readdirSync(dir).includes('ack_provider.0.wav')).toBe(false);
    expect(readdirSync(dir).includes('recorded.json')).toBe(false);
  });

  it('records a failure and keeps going, and dry-run writes nothing', async () => {
    const failing = async () => ({ ok: false, status: 500, text: async () => 'boom', arrayBuffer: async () => new ArrayBuffer(0) });
    const r = await generateClips([row, { id: 'greeting.0', text: 'Hi.', note: 'closed' }], opts(), failing as never);
    expect(r.failed).toEqual([{ id: 'ack_provider.0', error: 'HTTP 500: boom' }, { id: 'greeting.0', error: 'HTTP 500: boom' }]);
    expect(readdirSync(dir)).toEqual([]);
    const dry = await generateClips([row], opts({ dryRun: true }), failing as never);
    expect(dry.generated).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('rejects an unknown --only id before making any request', async () => {
    const mustNotBeCalled = async () => { throw new Error('fetch should not have been called'); };
    await expect(generateClips([row], opts({ only: ['nope', 'also-nope'] }), mustNotBeCalled as never)).rejects.toThrow(
      'unknown clip id(s): nope, also-nope',
    );
  });

  it('rejects a candidates count outside 1..20', async () => {
    await expect(generateClips([row], opts({ candidates: 0 }), fetchStub as never)).rejects.toThrow(/candidates must be an integer from 1 to 20/);
    await expect(generateClips([row], opts({ candidates: 21 }), fetchStub as never)).rejects.toThrow(/candidates must be an integer from 1 to 20/);
    await expect(generateClips([row], opts({ candidates: 1.5 }), fetchStub as never)).rejects.toThrow(/candidates must be an integer from 1 to 20/);
  });

  it('rejects a response that is not a plausible wav, and writes nothing for it', async () => {
    const badBody = async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('{"error":"x"}').buffer });
    const r = await generateClips([row], opts(), badBody as never);
    expect(r.failed).toEqual([{ id: 'ack_provider.0', error: 'not a wav response' }]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps a partial run: the clip and sidecar entry for the row that succeeded exist, the failed one does not', async () => {
    let n = 0;
    const mixed = async () => {
      n += 1;
      if (n === 1) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('RIFFok').buffer };
      return { ok: false, status: 500, text: async () => 'boom', arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const r = await generateClips([row, { id: 'greeting.0', text: 'Hi.', note: 'closed' }], opts(), mixed as never);
    expect(r.generated).toEqual(['ack_provider.0']);
    expect(r.failed).toEqual([{ id: 'greeting.0', error: 'HTTP 500: boom' }]);
    expect(readdirSync(dir).sort()).toEqual(['ack_provider.0.wav', 'recorded.json']);
    expect(JSON.parse(readFileSync(join(dir, 'recorded.json'), 'utf8'))).toEqual({ 'ack_provider.0': 'With' });
  });

  it('records a rejected fetch (a network error) in failed, with its message', async () => {
    const networkError = async () => { throw new Error('getaddrinfo ENOTFOUND api.fish.audio'); };
    const r = await generateClips([row], opts(), networkError as never);
    expect(r.failed).toEqual([{ id: 'ack_provider.0', error: 'getaddrinfo ENOTFOUND api.fish.audio' }]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never logs the API key during a dry run', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await generateClips([row], opts({ apiKey: 'SECRET', dryRun: true }), fetchStub as never);
    } finally {
      spy.mockRestore();
    }
    for (const call of spy.mock.calls) {
      for (const arg of call) expect(String(arg)).not.toMatch(/SECRET/);
    }
  });

  it('starts a fresh sidecar (and reports why) when the existing recorded.json is malformed', async () => {
    fsWriteFileSync(join(dir, 'recorded.json'), 'not json');
    // vi.spyOn(console, 'error') does not observe calls made from inside generateClips in this
    // suite (vitest's own console interception appears to intervene), so restore-after-use a
    // plain override instead of relying on the spy here.
    const origError = console.error;
    const logs: unknown[][] = [];
    console.error = (...a: unknown[]) => { logs.push(a); };
    try {
      await generateClips([row], opts(), fetchStub as never);
    } finally {
      console.error = origError;
    }
    expect(logs.some((c) => String(c[0]).startsWith('recorded.json unreadable, starting a fresh sidecar:'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'recorded.json'), 'utf8'))).toEqual({ 'ack_provider.0': 'With' });
  });
});

describe('tags.json', () => {
  it('names every recordable clip and nothing else, in bracket syntax, with open segments marked', () => {
    const ids = new Set(recordableClips().map((r) => r.id));
    const tagged = tags as Record<string, string>;
    expect(Object.keys(tagged).filter((id) => !ids.has(id))).toEqual([]);
    expect([...ids].filter((id) => !(id in tagged))).toEqual([]);
    for (const [id, tag] of Object.entries(tagged)) expect(tag, id).toMatch(/^\[[a-z ,]+\]$/);
    for (const r of recordableClips()) {
      if (r.note === 'open') expect(tagged[r.id], r.id).toMatch(/continuing\]$/);
      else expect(tagged[r.id], r.id).not.toMatch(/continuing/);
    }
  });
});
