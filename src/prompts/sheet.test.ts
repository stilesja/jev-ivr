import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReport, coverage, readRecorded, renderSheet, type Coverage } from './sheet';
import { recordableClips } from './clips';

describe('sheet', () => {
  it('prints one tab-separated line per clip with id, text, and note', () => {
    const out = renderSheet([{ id: 'a.0', text: 'With', note: 'open' }, { id: 'provider.chen', text: 'Dr. Chen', note: 'closed' }]);
    expect(out.split('\n')).toEqual(['id\ttext\tnote', 'a.0\tWith\topen', 'provider.chen\tDr. Chen\tclosed']);
  });

  it('has no tab, CR, or LF in any recordable clip text (the TSV has no escaping)', () => {
    for (const row of recordableClips()) {
      expect(row.text, row.id).not.toMatch(/[\t\r\n]/);
    }
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

    it('throws with the path on a malformed file', () => {
      dir = mkdtempSync(join(tmpdir(), 'audio-'));
      writeFileSync(join(dir, 'recorded.json'), '{not json');
      expect(() => readRecorded(dir)).toThrow(/recorded\.json/);
    });

    it('throws on a valid-JSON-but-wrong-shape sidecar', () => {
      dir = mkdtempSync(join(tmpdir(), 'audio-'));
      for (const bad of ['null', '"just a string"', '["a", "b"]']) {
        writeFileSync(join(dir, 'recorded.json'), bad);
        expect(() => readRecorded(dir), bad).toThrow(/recorded\.json/);
      }
    });
  });

  describe('checkReport', () => {
    it('reports exit 0 and one line for clean coverage', () => {
      const c: Coverage = { present: 2, total: 2, missing: [], unused: [], stale: [] };
      const { lines, exitCode } = checkReport(c, 'assets/audio');
      expect(lines).toEqual(['audio: 2 of 2 clips present in assets/audio (0 segments fall back to TTS)']);
      expect(exitCode).toBe(0);
    });

    it('lists missing, stale, and unused clips and reports exit 1', () => {
      const c: Coverage = { present: 1, total: 2, missing: ['a.1'], unused: ['stray'], stale: ['a.0'] };
      const { lines, exitCode } = checkReport(c, 'assets/audio');
      expect(lines).toEqual([
        'audio: 1 of 2 clips present in assets/audio (1 segments fall back to TTS)',
        '  missing a.1',
        '  stale   a.0 (recorded text differs from the sheet; regenerate with pnpm prompts:generate --only a.0 --force)',
        '  unused  stray',
      ]);
      expect(exitCode).toBe(1);
    });
  });
});
