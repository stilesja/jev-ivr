import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { discoverClips, recordableClips, type RecordableClip } from './clips';

export function renderSheet(rows: RecordableClip[]): string {
  return ['id\ttext\tnote', ...rows.map((r) => `${r.id}\t${r.text}\t${r.note}`)].join('\n');
}

export interface Coverage { present: number; total: number; missing: string[]; unused: string[]; stale: string[] }

/** The sidecar the generator writes: clip id → the text that was recorded. */
export const RECORDED_FILE = 'recorded.json';

/**
 * The recorded-text sidecar for `dir`, or null when the generator hasn't written one yet.
 * A read/parse failure (including a directory at that path) or a valid-JSON-but-wrong-shape
 * file throws with the path so the error is legible, not a raw stack.
 */
export function readRecorded(dir: string): Record<string, string> | null {
  const path = join(dir, RECORDED_FILE);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path}: expected an object of clip id → text`);
  }
  return parsed as Record<string, string>;
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

/** The `check` command's report, as lines to print and the exit code to set; split out so both can be tested without capturing stdout. */
export function checkReport(c: Coverage, dir: string): { lines: string[]; exitCode: number } {
  const lines: string[] = [`audio: ${c.present} of ${c.total} clips present in ${dir} (${c.missing.length} segments fall back to TTS)`];
  for (const id of c.missing) lines.push(`  missing ${id}`);
  for (const id of c.stale) lines.push(`  stale   ${id} (recorded text differs from the sheet; regenerate with pnpm prompts:generate --only ${id} --force)`);
  for (const id of c.unused) lines.push(`  unused  ${id}`);
  return { lines, exitCode: c.missing.length || c.stale.length ? 1 : 0 };
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
    const { lines, exitCode } = checkReport(c, dir);
    for (const line of lines) console.log(line);
    process.exitCode = exitCode;
    return;
  }
  console.error('usage: sheet | check');
  process.exitCode = 2;
}

// sweep.ts's entry follows the same shape: guard so importing this module (as index.ts does
// for coverage/readRecorded) never runs the CLI, and a thrown error prints its message, not a stack.
if (process.argv[1] && basename(process.argv[1]) === 'sheet.ts') {
  try {
    main();
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
