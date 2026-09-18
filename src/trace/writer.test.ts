import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceWriter, buildTraceRecord } from './writer';
import { newSession } from '../core/session';
import { resolve } from '../core/turn';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { setupFrame } from '../channel/frames';

describe('trace', () => {
  it('builds a v1 record and appends one JSON line per write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const path = join(dir, 'out', 'run.jsonl');
    const writer = new TraceWriter(path);
    const event = setupFrame('s');
    const result = resolve(newSession('s', 0), event, null, { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS } });
    const record = buildTraceRecord({
      result, event, questions: null, response: null, error: null,
      timing: { planMs: 0, askMs: 0, resolveMs: 1, totalMs: 1 }, ts: '2026-09-18T00:00:00.000Z',
      pricePerMtok: 0.042,
    });
    writer.write(record);
    writer.write(record);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.v).toBe(1);
    expect(parsed.sessionId).toBe('s');
    expect(parsed.source).toBe('none');
    expect(parsed.decision.kind).toBe('prompt');
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 0, estimated: true, costUsd: 0 });
  });
});
