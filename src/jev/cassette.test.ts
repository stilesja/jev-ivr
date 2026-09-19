import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCassette, canonicalJson, CassetteClient, loadCassette, requestKey, type CassetteLine } from './cassette';
import type { JevRequest, QuestionMap } from './types';
import { JevClientError, type AnswerMap, type JevClient, type JevResponse } from './types';
import { choice, noul } from '../testing/answers';

const questions: QuestionMap = {
  intent: { type: 'choice', instructions: 'What does the caller want?', criteria: { cancel: null, none: null } },
  ok: { type: 'noul', instructions: 'Is it fine?' },
};

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('drops undefined-valued keys', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
  });

  it('escapes strings like JSON.stringify', () => {
    expect(canonicalJson({ t: 'a "quoted" line\n' })).toBe('{"t":"a \\"quoted\\" line\\n"}');
  });

  it('emits null for array elements JSON.stringify cannot represent, like JSON.stringify', () => {
    expect(canonicalJson([1, undefined, () => 1, 3])).toBe('[1,null,null,3]');
    expect(canonicalJson({ a: [undefined] })).toBe('{"a":[null]}');
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalJson([1, , 3])).toBe('[1,null,3]');
  });
});

describe('requestKey', () => {
  const state = { asr: { text: 'cancel my appointment', isFinal: true }, activeForm: null };

  it('is a 64-char hex sha256 that is stable under key order', () => {
    const a = requestKey({ state, questions });
    const b = requestKey({ state: { activeForm: null, asr: { isFinal: true, text: 'cancel my appointment' } }, questions });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('ignores timeoutMs and signal', () => {
    const base: JevRequest = { state, questions };
    expect(requestKey({ ...base, timeoutMs: 5, signal: new AbortController().signal })).toBe(requestKey(base));
  });

  it('changes when state or questions change', () => {
    const a = requestKey({ state, questions });
    expect(requestKey({ state: { ...state, activeForm: 'cancel' }, questions })).not.toBe(a);
    expect(requestKey({ state, questions: { ok: questions.ok! } })).not.toBe(a);
  });

  it('has a frozen digest so a canonical-form change is caught here, not as cassette misses', () => {
    expect(requestKey({ state, questions })).toBe('866aec084970efac11e63920bf5541b114742c6017a91cfe87136978a2a3b35a');
  });
});

function line(key: string, extra: Partial<CassetteLine> = {}): CassetteLine {
  return {
    v: 1,
    key,
    model: 'jev-1.13.0',
    text: 'cancel my appointment',
    answers: { intent: choice({ cancel: 0.9, none: 0.1 }), ok: noul(0.8) },
    usage: { inputTokens: 100, outputTokens: 10 },
    recordedAt: '2026-09-18T00:00:00.000Z',
    ...extra,
  };
}

describe('cassette file', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cassette-'));
    path = join(dir, 'nested', 'jev-1.13.0.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads an empty map when the file does not exist', () => {
    expect(loadCassette(path).size).toBe(0);
  });

  it('appends one JSON line per call, creating the directory', () => {
    appendCassette(path, line('a'.repeat(64)));
    appendCassette(path, line('b'.repeat(64)));
    const raw = readFileSync(path, 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
    expect(raw.endsWith('\n')).toBe(true);
    expect(loadCassette(path).get('b'.repeat(64))?.text).toBe('cancel my appointment');
  });

  it('lets a later line for the same key win', () => {
    appendCassette(path, line('a'.repeat(64), { model: 'old' }));
    appendCassette(path, line('a'.repeat(64), { model: 'new' }));
    const loaded = loadCassette(path);
    expect(loaded.size).toBe(1);
    expect(loaded.get('a'.repeat(64))?.model).toBe('new');
  });

  it('fails the load naming the bad line number', () => {
    const flat = join(dir, 'jev-1.13.0.jsonl');
    writeFileSync(flat, `${JSON.stringify(line('a'.repeat(64)))}\n{"v":2,"key":"x"}\nnot json\n`);
    expect(() => loadCassette(flat)).toThrow(/line 2/);
  });

  it('fails the load on a line with no key', () => {
    const flat = join(dir, 'jev-1.13.0.jsonl');
    writeFileSync(flat, `{"v":1,"model":"m"}\n`);
    expect(() => loadCassette(flat)).toThrow(/line 1/);
  });

  it('fails the load on a truncated trailing line, naming its line number and the fix', () => {
    const flat = join(dir, 'jev-1.13.0.jsonl');
    writeFileSync(flat, `${JSON.stringify(line('a'.repeat(64)))}\n{"v":1,"key":"b`);
    expect(() => loadCassette(flat)).toThrow(/jev-1\.13\.0\.jsonl line 2: not JSON.*delete this line/);
  });

  it('fails the load on a line with no answers', () => {
    const flat = join(dir, 'jev-1.13.0.jsonl');
    writeFileSync(flat, `{"v":1,"key":"${'a'.repeat(64)}","model":"m"}\n`);
    expect(() => loadCassette(flat)).toThrow(/line 1: expected v:1 with key, model, answers and usage/);
  });

  it('fails the load on a line with answers but no usage', () => {
    const flat = join(dir, 'jev-1.13.0.jsonl');
    writeFileSync(flat, `{"v":1,"key":"${'a'.repeat(64)}","model":"m","answers":{}}\n`);
    expect(() => loadCassette(flat)).toThrow(/line 1: expected v:1 with key, model, answers and usage/);
  });
});

function fakeInner(answers: AnswerMap): JevClient & { calls: number; last?: JevRequest } {
  const inner = {
    calls: 0,
    last: undefined as JevRequest | undefined,
    async ask(req: JevRequest): Promise<JevResponse> {
      inner.calls += 1;
      inner.last = req;
      return { answers, model: 'jev-1.13.0', usage: { inputTokens: 42, outputTokens: 7, estimated: false }, latencyMs: 3, source: 'jev' };
    },
  };
  return inner;
}

describe('CassetteClient', () => {
  const state = { asr: { text: 'cancel my appointment', isFinal: true }, activeForm: null };
  const answers: AnswerMap = { intent: choice({ cancel: 0.9, none: 0.1 }), ok: noul(0.8) };
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cassette-'));
    path = join(dir, 'jev-1.13.0.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('replays a hit with source recorded and the recorded usage', async () => {
    appendCassette(path, line(requestKey({ state, questions }), { answers }));
    const r = await new CassetteClient({ path, mode: 'replay' }).ask({ state, questions });
    expect(r.source).toBe('recorded');
    expect(r.model).toBe('jev-1.13.0');
    expect(r.answers).toEqual(answers);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 10, estimated: false });
  });

  it('throws a JevClientError naming the key, text and path on a replay miss', async () => {
    const key = requestKey({ state, questions });
    await expect(new CassetteClient({ path, mode: 'replay' }).ask({ state, questions })).rejects.toThrow(JevClientError);
    await expect(new CassetteClient({ path, mode: 'replay' }).ask({ state, questions })).rejects.toThrow('cassette miss: ' + key + ' cancel my appointment (' + path + ')');
  });

  it('records a miss through the inner client once and replays it afterwards', async () => {
    const inner = fakeInner(answers);
    const client = new CassetteClient({ path, mode: 'record', inner, now: () => Date.UTC(2026, 8, 18) });
    const first = await client.ask({ state, questions, timeoutMs: 1500 });
    expect(first.source).toBe('jev');
    expect(inner.calls).toBe(1);
    expect(inner.last?.timeoutMs).toBe(1500);
    const second = await client.ask({ state, questions });
    expect(second.source).toBe('recorded');
    expect(inner.calls).toBe(1);
    const saved = loadCassette(path).get(requestKey({ state, questions }));
    expect(saved).toMatchObject({ v: 1, model: 'jev-1.13.0', text: 'cancel my appointment', usage: { inputTokens: 42, outputTokens: 7 }, recordedAt: '2026-09-18T00:00:00.000Z' });
    expect(saved?.answers).toEqual(answers);
  });

  it('requires an inner client in record mode', () => {
    expect(() => new CassetteClient({ path, mode: 'record' })).toThrow(/inner/);
  });

  it('passes an inner client failure through without recording', async () => {
    const inner: JevClient = { ask: async () => { throw new JevClientError('boom'); } };
    await expect(new CassetteClient({ path, mode: 'record', inner }).ask({ state, questions })).rejects.toThrow('boom');
    expect(loadCassette(path).size).toBe(0);
  });

  it('rejects a replay whose recorded line model differs from expectModel', async () => {
    appendCassette(path, line(requestKey({ state, questions }), { model: 'other', answers }));
    await expect(new CassetteClient({ path, mode: 'replay', expectModel: 'jev-1.13.0' }).ask({ state, questions })).rejects.toThrow(/expected jev-1\.13\.0/);
  });

  it('rejects a record miss whose live model differs from expectModel, without recording', async () => {
    const inner = fakeInner(answers);
    await expect(new CassetteClient({ path, mode: 'record', inner, expectModel: 'jev-9' }).ask({ state, questions })).rejects.toThrow(/not recorded/);
    expect(loadCassette(path).size).toBe(0);
  });

  it('preload throws on a corrupt file before any ask', () => {
    writeFileSync(path, `${JSON.stringify(line(requestKey({ state, questions })))}\n{"v":1,"key":"b`);
    expect(() => new CassetteClient({ path, mode: 'replay' }).preload()).toThrow(/line 2/);
  });
});
