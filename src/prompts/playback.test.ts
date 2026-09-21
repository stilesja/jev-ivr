import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipDurations, playbackEstimateMs, textEstimateMs, wavDurationMs } from './playback';

function wav(samples: number, rate = 44100, channels = 1, bits = 16): Buffer {
  const data = samples * channels * (bits / 8);
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * (bits / 8), 28);
  b.writeUInt16LE(channels * (bits / 8), 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36);
  b.writeUInt32LE(data, 40);
  return b;
}

describe('wavDurationMs', () => {
  it('reads the data chunk against the byte rate', () => {
    expect(wavDurationMs(wav(44100))).toBe(1000);
    expect(wavDurationMs(wav(22050, 44100, 2))).toBe(500);
  });
  it('finds the format chunk when the samples come first', () => {
    // RIFF does not fix the chunk order; a data-then-fmt file is still a WAV we can measure.
    const src = wav(44100);
    const fmt = src.subarray(12, 12 + 8 + 16);
    const data = src.subarray(36);
    const out = Buffer.concat([src.subarray(0, 12), data, fmt]);
    expect(wavDurationMs(out)).toBe(1000);
  });

  it('returns null for a non-wav or truncated buffer', () => {
    expect(wavDurationMs(Buffer.from('ID3xxxxxx'))).toBeNull();
    expect(wavDurationMs(wav(100).subarray(0, 20))).toBeNull();
  });
});

describe('textEstimateMs', () => {
  it('estimates 2.5 words per second, at least half a second', () => {
    expect(textEstimateMs('Thanks for calling Stiles Family Medical Practice. How can I help you today?')).toBe(5200);
    expect(textEstimateMs('Goodbye.')).toBe(500);
  });
});

describe('clipDurations and playbackEstimateMs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audio-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('maps filenames to durations and sums a frame list', () => {
    writeFileSync(join(dir, 'greeting.0.wav'), wav(88200));
    writeFileSync(join(dir, 'x.mp3'), 'not parsed');
    const d = clipDurations(dir);
    expect(d.get('greeting.0.wav')).toBe(2000);
    expect(d.has('x.mp3')).toBe(false);
    const frames = [
      { type: 'play' as const, source: 'https://h/audio/greeting.0.wav', loop: 1, preemptible: false, interruptible: true },
      { type: 'text' as const, token: '4471 8293', last: true, lang: 'en-US', interruptible: false, preemptible: false },
      { type: 'play' as const, source: 'https://h/audio/missing.wav', loop: 1, preemptible: false, interruptible: true },
      { type: 'end' as const, handoffData: '{}' },
    ];
    expect(playbackEstimateMs(frames, d)).toBe(2000 + 800 + 1500);
  });
  it('finds a clip duration through a content-hash query string on the source', () => {
    writeFileSync(join(dir, 'greeting.0.wav'), wav(88200));
    const d = clipDurations(dir);
    const frames = [
      { type: 'play' as const, source: 'https://h/audio/greeting.0.wav?v=abc1234567', loop: 1, preemptible: false, interruptible: true },
    ];
    expect(playbackEstimateMs(frames, d)).toBe(2000);
  });
});
