import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameLog, readFrameLog } from './frameLog';

describe('FrameLog', () => {
  it('appends one JSON line per message with direction and timestamp, and reads them back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frames-'));
    const path = join(dir, 'calls', 'CA1.frames.jsonl');
    let t = 1_000;
    const log = new FrameLog(path, () => t);
    log.write('in', { type: 'setup', callSid: 'CA1' });
    t = 1_500;
    log.write('out', { type: 'text', token: 'hi' });
    log.write('http', { route: '/cr-action', CallSid: 'CA1' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ ts: '1970-01-01T00:00:01.000Z', dir: 'in', msg: { type: 'setup', callSid: 'CA1' } });
    expect(readFrameLog(path).map((l) => l.dir)).toEqual(['in', 'out', 'http']);
  });

  it('skips a truncated last line and reports it via onSkip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frames-'));
    const path = join(dir, 'calls', 'CA2.frames.jsonl');
    const log = new FrameLog(path, () => 1_000);
    log.write('in', { type: 'setup', callSid: 'CA2' });
    appendFileSync(path, '{"ts":"x","dir":"in","msg":{"type":');
    const skipped: number[] = [];
    const lines = readFrameLog(path, (lineNumber) => skipped.push(lineNumber));
    expect(lines).toHaveLength(1);
    expect(skipped).toEqual([2]);
  });
});
