import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OutboundFrame } from '../channel/frames';

const WORDS_PER_SECOND = 2.5;
const MIN_TEXT_MS = 500;
/** A clip we could not measure (mp3, missing) is assumed to be this long. */
const UNKNOWN_CLIP_MS = 1500;

/**
 * Duration of a PCM WAV from its header, or null when the buffer is not a parseable WAV.
 *
 * The chunk walk runs until both `fmt ` and `data` have been seen rather than stopping at
 * `data`: RIFF does not promise an order, and a file that puts its samples first would
 * otherwise measure as unparseable and fall back to the fixed unknown-clip estimate.
 */
export function wavDurationMs(b: Buffer): number | null {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let byteRate = 0;
  let dataSize: number | null = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 8 + 16 <= b.length) byteRate = b.readUInt32LE(pos + 16);
    else if (id === 'data' && dataSize === null) dataSize = Math.min(size, b.length - pos - 8);
    if (byteRate && dataSize !== null) break;
    pos += 8 + size + (size & 1);
  }
  if (!byteRate || dataSize === null) return null;
  return Math.round((dataSize / byteRate) * 1000);
}

/** Estimated speaking time at 2.5 words per second, at least 500ms. */
export function textEstimateMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(MIN_TEXT_MS, Math.round((words / WORDS_PER_SECOND) * 1000));
}

/** filename → ms for every wav directly under dir; mp3s are skipped (estimated at playback). */
export function clipDurations(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/\.wav$/i.test(name)) continue;
    const ms = wavDurationMs(readFileSync(join(dir, name)));
    if (ms !== null) out.set(name, ms);
  }
  return out;
}

/**
 * How long the frames take to play, for the no-input timer; approximate by design.
 * Deviation from spec §4: an mp3 clip (no header we parse) falls back to the fixed
 * unknown-clip estimate rather than the recording text's word count, because the
 * adapter does not have the recording text at send time, only the file name.
 */
export function playbackEstimateMs(frames: readonly OutboundFrame[], durations: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const f of frames) {
    if (f.type === 'text') total += textEstimateMs(f.token);
    else if (f.type === 'play') {
      const name = f.source.slice(f.source.lastIndexOf('/') + 1);
      total += (durations.get(name) ?? UNKNOWN_CLIP_MS) * Math.max(1, f.loop);
    }
  }
  return total;
}
