import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync as fsMkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FISH_TAGS, generateClips, pickCandidates, repairWavFiles, repairWavHeader, resolveVoice, tagBodies, ttsRequest, validateTags, type GenerateOptions } from './generate';
import { recordableClips } from './clips';
import tags from './tags.json';
import fishTags from './fishTags.json';

const row = { id: 'ack_provider.0', text: 'With', note: 'open' as const };

/** A synthetic PCM WAV: 44-byte header (RIFF/WAVE, a 16-byte `fmt `, a `data` chunk at offset 36) plus `sampleBytes` of sample data, with the given RIFF/data sizes written into the header regardless of whether they're true. */
function makeWav(riffSize: number, dataSize: number, sampleBytes = 1000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(riffSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(44100 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(sampleBytes, 1)]);
}

describe('ttsRequest', () => {
  it('prefixes the tag, sets the model header, and never includes the key in the printable form', () => {
    const r = ttsRequest(row, { voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[calm]', tags: { 'ack_provider.0': '[confident]' }, openComma: true });
    expect(r.url).toBe('https://api.fish.audio/v1/tts');
    expect(r.headers.model).toBe('s2.1-pro');
    expect(r.body).toEqual({ text: '[confident] With,', reference_id: 'v1', format: 'wav', temperature: 0.7, prosody: { speed: 1, volume: 0 } });
    expect(ttsRequest({ ...row, id: 'greeting.0' }, { voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[calm]', tags: {}, openComma: true }).body.text).toBe('[calm] With,');
    expect(JSON.stringify(r)).not.toMatch(/Bearer/);
  });

  it('omits the trailing comma on an open row when openComma is false, and never adds one to a closed row', () => {
    expect(ttsRequest(row, { voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[calm]', tags: { 'ack_provider.0': '[confident]' }, openComma: false }).body.text).toBe('[confident] With');
    const closed = { id: 'greeting.0', text: 'Hi.', note: 'closed' as const };
    expect(ttsRequest(closed, { voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[calm]', tags: {}, openComma: true }).body.text).toBe('[calm] Hi.');
    expect(ttsRequest(closed, { voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[calm]', tags: {}, openComma: false }).body.text).toBe('[calm] Hi.');
  });
});

describe('tagBodies', () => {
  it('splits one or more bracket groups, or returns [] for anything else', () => {
    expect(tagBodies('[calm]')).toEqual(['calm']);
    expect(tagBodies('[calm][soft tone]')).toEqual(['calm', 'soft tone']);
    expect(tagBodies('calm')).toEqual([]);
    expect(tagBodies('[a] [b]')).toEqual([]);
    expect(tagBodies('[]')).toEqual([]);
    expect(tagBodies('[[a]]')).toEqual([]);
  });
});

describe('FISH_TAGS', () => {
  it('has exactly 71 documented tags, with no duplicate hiding a missing one', () => {
    expect(FISH_TAGS.size).toBe(71);
    expect(fishTags.tags.length).toBe(71);
  });
});

describe('validateTags', () => {
  it('flags a tag whose body is not in the Fish inventory, for a clip id or the --tag fallback', () => {
    expect(validateTags({ 'greeting.0': '[calm]' })).toEqual([]);
    expect(validateTags({ 'greeting.0': '[warm and welcoming]' })).toEqual(['unsupported Fish tag "warm and welcoming" for greeting.0']);
    expect(validateTags({}, '[warm]')).toEqual(['unsupported Fish tag "warm" for --tag']);
    expect(validateTags({}, '[calm]')).toEqual([]);
  });

  it('flags a malformed tag (not [body] or [a][b], and not empty) rather than silently skipping it', () => {
    expect(validateTags({}, 'warm')).toEqual(['malformed tag "warm" for --tag; expected [body] or [a][b]']);
    expect(validateTags({ 'greeting.0': '[a] [b]' })).toEqual(['malformed tag "[a] [b]" for greeting.0; expected [body] or [a][b]']);
  });
});

describe('resolveVoice', () => {
  const ambiguousStub = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items: [
      { _id: 'abc123', title: 'Hanna', author: { nickname: 'nick1' } },
      { _id: 'def456', title: 'Hanna', author: { name: 'name2' } },
      { _id: 'zzz', title: 'Hannah B', author: { nickname: 'other' } },
    ] }),
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  it('returns a hex id unchanged, with title and author left null', async () => {
    expect(await resolveVoice('abc123def', 'k', ambiguousStub as never)).toEqual({ id: 'abc123def', title: null, author: null });
  });

  it('returns the single exact match with its title and author', async () => {
    expect(await resolveVoice('Hannah B', 'k', ambiguousStub as never)).toEqual({ id: 'zzz', title: 'Hannah B', author: 'other' });
  });

  it('throws listing every match by id and author when more than one item has the exact title', async () => {
    await expect(resolveVoice('Hanna', 'k', ambiguousStub as never)).rejects.toThrow(
      "voice title \"Hanna\" is ambiguous (2 matches): abc123 by nick1, def456 by name2; set FISH_VOICE to the id from the voice's page URL (fish.audio/m/<id>/)",
    );
  });

  it('keeps the existing no-match error, listing the titles that were found', async () => {
    await expect(resolveVoice('Hannahx', 'k', ambiguousStub as never)).rejects.toThrow(/no voice titled "Hannahx".*Hanna, Hanna, Hannah B/);
    await expect(resolveVoice('Nobody', 'k', async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as never)).rejects.toThrow(/no voice titled/);
  });
});

describe('generateClips', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audio-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const opts = (over: Partial<GenerateOptions> = {}): GenerateOptions => ({ audioDir: dir, apiKey: 'k', voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[calm]', tags: {}, openComma: true, candidates: 1, force: false, only: null, dryRun: false, ...over });
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

describe('pickCandidates', () => {
  let dir: string;
  const rows = [{ id: 'a.0', text: 'Hi.', note: 'closed' as const }];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audio-'));
    fsWriteFileSync(join(dir, 'a.0.mp3'), 'old-final');
    fsMkdirSync(join(dir, 'candidates'), { recursive: true });
    fsWriteFileSync(join(dir, 'candidates', 'a.0-1.wav'), 'candidate-1');
    fsWriteFileSync(join(dir, 'candidates', 'a.0-2.wav'), 'candidate-2');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('promotes the picked candidate, drops the stale final clip and the other candidates, and records the sidecar', () => {
    const r = pickCandidates(['a.0-2'], dir, rows);
    expect(r).toEqual({ picked: ['a.0-2'], errors: [] });
    expect(readFileSync(join(dir, 'a.0.wav'), 'utf8')).toBe('candidate-2');
    expect(readdirSync(dir).sort()).toEqual(['a.0.wav', 'candidates', 'recorded.json']);
    expect(readdirSync(join(dir, 'candidates'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'recorded.json'), 'utf8'))).toEqual({ 'a.0': 'Hi.' });
  });

  it('reports an unknown clip id and a missing candidate as errors, and leaves the tree unchanged', () => {
    const r = pickCandidates(['nope-1', 'a.0-9'], dir, rows);
    expect(r).toEqual({ picked: [], errors: [`unknown clip id: nope`, `no candidate a.0-9 under ${dir}/candidates`] });
    expect(readFileSync(join(dir, 'a.0.mp3'), 'utf8')).toBe('old-final');
    expect(readdirSync(join(dir, 'candidates')).sort()).toEqual(['a.0-1.wav', 'a.0-2.wav']);
    expect(readdirSync(dir).includes('recorded.json')).toBe(false);
  });
});

describe('repairWavHeader', () => {
  it('fixes a placeholder RIFF/data size to the true lengths', () => {
    const wav = makeWav(0xffffff24, 0xffffff00, 1000);
    const r = repairWavHeader(wav);
    expect(r.repaired).toBe(true);
    expect(r.bytes.readUInt32LE(4)).toBe(1036);
    expect(r.bytes.readUInt32LE(40)).toBe(1000);
    expect(r.bytes.length).toBe(wav.length);
  });

  it('leaves an already-correct header unchanged', () => {
    const wav = makeWav(1036, 1000, 1000);
    const r = repairWavHeader(wav);
    expect(r.repaired).toBe(false);
    expect(r.bytes).toEqual(wav);
  });

  it('returns non-wav or too-short input unchanged', () => {
    const id3 = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.alloc(60)]);
    expect(repairWavHeader(id3)).toEqual({ bytes: id3, repaired: false });
    const short = Buffer.from('RIFF');
    expect(repairWavHeader(short)).toEqual({ bytes: short, repaired: false });
  });
});

describe('repairWavFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audio-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('repairs placeholder wavs in place, leaves correct ones and mp3s alone, and reports counts', () => {
    fsWriteFileSync(join(dir, 'placeholder.wav'), makeWav(0xffffff24, 0xffffff00, 1000));
    fsWriteFileSync(join(dir, 'correct.wav'), makeWav(1036, 1000, 1000));
    fsWriteFileSync(join(dir, 'other.mp3'), 'not a wav');

    const r = repairWavFiles(dir);
    expect(r.checked).toBe(2);
    expect(r.repaired).toEqual(['placeholder.wav']);

    const fixed = readFileSync(join(dir, 'placeholder.wav'));
    expect(fixed.readUInt32LE(4)).toBe(1036);
    expect(fixed.readUInt32LE(40)).toBe(1000);
    expect(readFileSync(join(dir, 'other.mp3'), 'utf8')).toBe('not a wav');
  });
});

describe('generateClips (wav header repair)', () => {
  it('repairs a streamed placeholder header before writing the clip to disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audio-'));
    try {
      const placeholder = makeWav(0xffffff24, 0xffffff00, 1000);
      const fetchStub = async () => ({ ok: true, status: 200, arrayBuffer: async () => placeholder.buffer.slice(placeholder.byteOffset, placeholder.byteOffset + placeholder.byteLength) });
      const opts: GenerateOptions = { audioDir: dir, apiKey: 'k', voiceId: 'v1', model: 's2.1-pro', format: 'wav', tag: '[calm]', tags: {}, openComma: true, candidates: 1, force: false, only: null, dryRun: false };
      await generateClips([row], opts, fetchStub as never);
      const written = readFileSync(join(dir, 'ack_provider.0.wav'));
      expect(written.readUInt32LE(4)).toBe(1036);
      expect(written.readUInt32LE(40)).toBe(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tags.json', () => {
  it('names every recordable clip and nothing else, using only Fish inventory tags, with no leftover "continuing" suffix', () => {
    const ids = new Set(recordableClips().map((r) => r.id));
    const tagged = tags as Record<string, string>;
    expect(Object.keys(tagged).filter((id) => !ids.has(id))).toEqual([]);
    expect([...ids].filter((id) => !(id in tagged))).toEqual([]);
    for (const [id, tag] of Object.entries(tagged)) {
      const bodies = tagBodies(tag);
      expect(bodies.length, id).toBeGreaterThan(0);
      for (const body of bodies) expect(FISH_TAGS.has(body), `${id}: ${body}`).toBe(true);
      expect(tag, id).not.toMatch(/continuing/);
    }
  });
});
