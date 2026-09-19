import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnswerMap, JevRequest } from './types';

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
    if (!l || l.v !== 1 || typeof l.key !== 'string' || typeof l.answers !== 'object' || l.answers === null) throw new Error(`cassette ${path} line ${i + 1}: expected v:1 with a key and answers; the file is append-only, delete this line and re-record`);
    out.set(l.key, l as CassetteLine);
  });
  return out;
}

/** Synchronous append so a crash mid-run keeps everything recorded so far. */
export function appendCassette(path: string, line: CassetteLine): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + '\n');
}
