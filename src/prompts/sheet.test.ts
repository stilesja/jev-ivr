import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coverage, readRecorded, renderSheet } from './sheet';

describe('sheet', () => {
  it('prints one tab-separated line per clip with id, text, and note', () => {
    const out = renderSheet([{ id: 'a.0', text: 'With', note: 'open' }, { id: 'provider.chen', text: 'Dr. Chen', note: 'closed' }]);
    expect(out.split('\n')).toEqual(['id\ttext\tnote', 'a.0\tWith\topen', 'provider.chen\tDr. Chen\tclosed']);
  });

  it('reports coverage, the missing ids, unused clips, and stale clips', () => {
    const rows = [{ id: 'a.0', text: 'Hello', note: 'closed' as const }, { id: 'a.1', text: 'World', note: 'closed' as const }];
    const clips = new Map([['a.0', 'a.0.wav'], ['stray', 'stray.wav']]);
    expect(coverage(rows, clips, null)).toEqual({ present: 1, total: 2, missing: ['a.1'], unused: ['stray'], stale: [] });
    expect(coverage(rows, clips, { 'a.0': 'Hello' })).toEqual({ present: 1, total: 2, missing: ['a.1'], unused: ['stray'], stale: [] });
    expect(coverage(rows, clips, { 'a.0': 'Hi' })).toEqual({ present: 1, total: 2, missing: ['a.1'], unused: ['stray'], stale: ['a.0'] });
  });

  describe('readRecorded', () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('returns null when recorded.json is absent', () => {
      dir = mkdtempSync(join(tmpdir(), 'audio-'));
      expect(readRecorded(dir)).toBeNull();
    });

    it('returns the parsed object when present', () => {
      dir = mkdtempSync(join(tmpdir(), 'audio-'));
      writeFileSync(join(dir, 'recorded.json'), JSON.stringify({ 'a.0': 'Hello' }));
      expect(readRecorded(dir)).toEqual({ 'a.0': 'Hello' });
    });

    it('throws on a malformed file', () => {
      dir = mkdtempSync(join(tmpdir(), 'audio-'));
      writeFileSync(join(dir, 'recorded.json'), '{not json');
      expect(() => readRecorded(dir)).toThrow();
    });
  });
});
