import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { JevClientError, type AnswerMap, type JevClient, type JevRequest, type JevResponse } from './types';

/** JSON with object keys sorted at every level, arrays in order, no whitespace. Object keys whose value is undefined are dropped; any other value JSON.stringify cannot represent becomes null. Input is expected to be a JsonValue; toJSON methods are not honored. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  const parts = Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
  return `{${parts.join(',')}}`;
}

/** Identity of a request for the cassette: what is asked and about what, not how long we waited. */
export function requestKey(req: JevRequest): string {
  return createHash('sha256').update(canonicalJson({ state: req.state, questions: req.questions })).digest('hex');
}

export interface CassetteLine {
  v: 1;
  key: string;
  model: string;
  /** state.asr.text, so a person can grep the file */
  text: string;
  answers: AnswerMap;
  usage: { inputTokens: number; outputTokens: number };
  recordedAt: string;
}

/** Later lines for the same key win. A missing file is an empty cassette. */
export function loadCassette(path: string): Map<string, CassetteLine> {
  const out = new Map<string, CassetteLine>();
  if (!existsSync(path)) return out;
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((raw, i) => {
    if (raw.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`cassette ${path} line ${i + 1}: not JSON (${raw.slice(0, 60)}); the file is append-only, delete this line and re-record`);
    }
    const l = parsed as Partial<CassetteLine> | null;
    const usage = l?.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
    const usageOk = typeof usage === 'object' && usage !== null && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number';
    if (!l || l.v !== 1 || typeof l.key !== 'string' || typeof l.model !== 'string' || typeof l.answers !== 'object' || l.answers === null || !usageOk)
      throw new Error(`cassette ${path} line ${i + 1}: expected v:1 with key, model, answers and usage; the file is append-only, delete this line and re-record`);
    out.set(l.key, l as CassetteLine);
  });
  return out;
}

/** Synchronous append so a crash mid-run keeps everything recorded so far. */
export function appendCassette(path: string, line: CassetteLine): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + '\n');
}

export type CassetteMode = 'replay' | 'record';

export interface CassetteOptions {
  path: string;
  mode: CassetteMode;
  /** required in record mode: answers a miss and is recorded */
  inner?: JevClient;
  now?: () => number;
  /** when set, a recorded or replayed line whose model differs fails the run: the file is named for one model */
  expectModel?: string;
}

function textOf(state: unknown): string {
  const s = state as { asr?: { text?: string } } | null;
  return s?.asr?.text ?? '';
}

/**
 * Replays recorded answers keyed by requestKey. In record mode a miss goes to the inner
 * client and is appended to the file; in replay mode a miss is a client error, so a stale
 * cassette shows up as a failed turn rather than a silently different answer.
 *
 * Not safe for concurrent identical asks: two overlapping misses both call the inner client
 * and both append. The runner is sequential.
 */
export class CassetteClient implements JevClient {
  private lines: Map<string, CassetteLine> | null = null;

  constructor(private readonly opts: CassetteOptions) {
    if (opts.mode === 'record' && !opts.inner) throw new Error('CassetteClient: record mode needs an inner client');
  }

  private load(): Map<string, CassetteLine> {
    if (this.lines) return this.lines;
    const lines = loadCassette(this.opts.path);
    if (this.opts.expectModel) {
      for (const [key, l] of lines) {
        if (l.model !== this.opts.expectModel) throw new Error(`cassette ${this.opts.path}: line for key ${key} has model ${l.model}, expected ${this.opts.expectModel}`);
      }
    }
    this.lines = lines;
    return this.lines;
  }

  /** Load now so a corrupt file fails at startup rather than on the first ask. */
  preload(): void {
    this.load();
  }

  async ask(req: JevRequest): Promise<JevResponse> {
    const started = performance.now();
    const key = requestKey(req);
    const hit = this.load().get(key);
    if (hit) {
      return {
        answers: hit.answers,
        model: hit.model,
        usage: { ...hit.usage, estimated: false },
        latencyMs: performance.now() - started,
        source: 'recorded',
      };
    }
    if (this.opts.mode === 'replay') throw new JevClientError(`cassette miss: ${key} ${textOf(req.state)} (${this.opts.path})`);
    const res = await this.opts.inner!.ask(req);
    if (this.opts.expectModel && res.model !== this.opts.expectModel) throw new Error(`cassette ${this.opts.path}: live answer came from ${res.model}, expected ${this.opts.expectModel}; not recorded`);
    const line: CassetteLine = {
      v: 1,
      key,
      model: res.model,
      text: textOf(req.state),
      answers: res.answers,
      usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens },
      recordedAt: new Date((this.opts.now ?? Date.now)()).toISOString(),
    };
    appendCassette(this.opts.path, line);
    this.load().set(key, line);
    return res;
  }
}
