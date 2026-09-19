import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeWindow, MONTHS, WINDOWS } from '../core/extract/date';
import { discoverClips, recordableClips, vocabularyClipId } from './clips';

describe('discoverClips', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audio-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('maps clip ids to filenames for wav and mp3 and ignores everything else', () => {
    writeFileSync(join(dir, 'greeting.0.wav'), '');
    writeFileSync(join(dir, 'provider.chen.mp3'), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    writeFileSync(join(dir, '.gitkeep'), '');
    expect(discoverClips(dir)).toEqual(new Map([['greeting.0', 'greeting.0.wav'], ['provider.chen', 'provider.chen.mp3']]));
  });
  it('returns an empty map for a missing directory', () => {
    expect(discoverClips(join(dir, 'nope')).size).toBe(0);
  });
  it('rejects one id recorded in two formats', () => {
    writeFileSync(join(dir, 'greeting.0.wav'), '');
    writeFileSync(join(dir, 'greeting.0.mp3'), '');
    expect(() => discoverClips(dir)).toThrow(/greeting\.0.*wav.*mp3|greeting\.0.*mp3.*wav/);
  });
  it('discovers an uppercase extension, keeping the id case as written', () => {
    writeFileSync(join(dir, 'Greeting.0.WAV'), '');
    expect(discoverClips(dir)).toEqual(new Map([['Greeting.0', 'Greeting.0.WAV']]));
  });
  it('ignores a subdirectory even when its name looks like a clip file', () => {
    mkdirSync(join(dir, 'sub.wav'));
    expect(discoverClips(dir).size).toBe(0);
  });
});

describe('vocabularyClipId', () => {
  it('maps display values back to clip ids', () => {
    expect(vocabularyClipId('provider', 'Dr. Chen')).toBe('provider.chen');
    expect(vocabularyClipId('a', 'Dr. Cheng')).toBe('provider.cheng');
    expect(vocabularyClipId('intentLabel', 'cancel an appointment')).toBe('intent.cancel');
    expect(vocabularyClipId('b', 'ask about billing')).toBe('intent.billing');
    expect(vocabularyClipId('window', 'next week')).toBe('window.next_week');
    expect(vocabularyClipId('window', 'in September')).toBe('window.in_september');
    expect(vocabularyClipId('provider', 'Dr. Nobody')).toBeNull();
    expect(vocabularyClipId('memberId', '4471 8293')).toBeNull();
    expect(vocabularyClipId('date', 'Tuesday, September 22')).toBeNull();
  });
  it('resolves every label describeWindow can produce for a relative window or a bare month', () => {
    const labels = [
      ...WINDOWS.filter((label) => label !== 'none').map((label) => describeWindow({ start: '', end: '', label })),
      ...MONTHS.map((label) => describeWindow({ start: '', end: '', label })),
    ];
    for (const label of labels) {
      expect(vocabularyClipId('window', label)).not.toBeNull();
    }
  });
});

describe('recordableClips', () => {
  it('lists every fixed segment and every vocabulary clip once, with text and intonation', () => {
    const rows = recordableClips();
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.find((r) => r.id === 'greeting.0')).toMatchObject({ text: 'Thanks for calling the clinic. How can I help you today?', note: 'closed' });
    expect(rows.find((r) => r.id === 'ack_provider.0')).toMatchObject({ text: 'With', note: 'open' });
    expect(rows.find((r) => r.id === 'date_narrow_window.0')).toMatchObject({ text: 'Which day works for you?', note: 'closed' });
    expect(rows.find((r) => r.id === 'provider.chen')).toMatchObject({ text: 'Dr. Chen', note: 'closed' });
    expect(rows.find((r) => r.id === 'intent.reschedule')).toMatchObject({ text: 'reschedule an appointment', note: 'closed' });
    expect(rows.find((r) => r.id === 'window.this_week')).toMatchObject({ text: 'this week' });
    expect(rows.find((r) => r.id === 'window.in_january')).toMatchObject({ text: 'in January' });
    expect(rows.filter((r) => r.id.startsWith('provider.'))).toHaveLength(8);
    expect(rows.filter((r) => r.id.startsWith('intent.'))).toHaveLength(5);
    expect(rows.some((r) => r.id === 'memberId' || r.id.startsWith('date.'))).toBe(false);
    // A trailing "." after a variable (e.g. "With {provider}.") has nothing left to record
    // once its leading punctuation is stripped, so it is not a recordable row.
    expect(rows.some((r) => r.text === '')).toBe(false);
    expect(rows.some((r) => r.id === 'ack_provider.1')).toBe(false);
  });
  it('matches the recorded snapshot of clip ids and notes', () => {
    expect(recordableClips()).toMatchSnapshot();
  });
});
