import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { discoverClips, recordableClips, type RecordableClip } from './clips';

export function renderSheet(rows: RecordableClip[]): string {
  return ['id\ttext\tnote', ...rows.map((r) => `${r.id}\t${r.text}\t${r.note}`)].join('\n');
}

export interface Coverage { present: number; total: number; missing: string[]; unused: string[]; stale: string[] }

/** The sidecar the generator writes: clip id → the text that was recorded. */
export const RECORDED_FILE = 'recorded.json';

/** The recorded-text sidecar for `dir`, or null when the generator hasn't written one yet. A malformed file throws. */
export function readRecorded(dir: string): Record<string, string> | null {
  const path = join(dir, RECORDED_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

/**
 * How well `clips` (a directory listing from discoverClips) covers `rows` (the recording
 * sheet). `stale` catches the case a template edit silently makes an existing recording say
 * the wrong thing: fixed clip ids are positional (`<promptId>.<n>`), so nothing else would
 * notice that the file on disk no longer matches the sheet text at that position.
 */
export function coverage(rows: RecordableClip[], clips: Map<string, string>, recorded: Record<string, string> | null): Coverage {
  const ids = new Set(rows.map((r) => r.id));
  const missing = rows.filter((r) => !clips.has(r.id)).map((r) => r.id);
  const unused = [...clips.keys()].filter((id) => !ids.has(id)).sort();
  const stale = recorded
    ? rows.filter((r) => clips.has(r.id) && recorded[r.id] !== undefined && recorded[r.id] !== r.text).map((r) => r.id)
    : [];
  return { present: rows.length - missing.length, total: rows.length, missing, unused, stale };
}

function main(): void {
  const mode = process.argv[2];
  const dir = process.env.AUDIO_DIR?.trim() || 'assets/audio';
  const rows = recordableClips();
  if (mode === 'sheet') {
    console.log(renderSheet(rows));
    return;
  }
  if (mode === 'check') {
    const c = coverage(rows, discoverClips(dir), readRecorded(dir));
    console.log(`audio: ${c.present} of ${c.total} clips present in ${dir} (${c.missing.length} segments fall back to TTS)`);
    for (const id of c.missing) console.log(`  missing ${id}`);
    for (const id of c.stale) console.log(`  stale   ${id} (recorded text differs from the sheet; regenerate with --force --only ${id})`);
    for (const id of c.unused) console.log(`  unused  ${id}`);
    process.exitCode = c.missing.length || c.stale.length ? 1 : 0;
    return;
  }
  console.error('usage: sheet | check');
  process.exitCode = 2;
}

if (process.argv[1] && basename(process.argv[1]) === 'sheet.ts') main();
