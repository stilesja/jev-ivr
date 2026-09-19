import { createHash } from 'node:crypto';
import type { JevRequest } from './types';

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
