import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { discoverClips, recordableClips, type RecordableClip } from './clips';
import { readRecorded, RECORDED_FILE } from './sheet';
import tags from './tags.json';
import fishTags from './fishTags.json';

const TTS_URL = 'https://api.fish.audio/v1/tts';
const MODELS_URL = 'https://api.fish.audio/model';
const MAX_CANDIDATES = 20;
const MAX_ERROR_BODY = 200;

/** Fish Audio's documented S2 bracket-tag inventory (src/prompts/fishTags.json); the only tags tested against the web tool's picker. */
export const FISH_TAGS: ReadonlySet<string> = new Set(fishTags.tags);

/** Splits `[a][b]` into `['a', 'b']`; returns `[]` unless the whole string is one or more bracket groups with nothing between them. */
export function tagBodies(tag: string): string[] {
  if (!/^(\[[^[\]]+\])+$/.test(tag)) return [];
  return [...tag.matchAll(/\[([^[\]]+)\]/g)].map((m) => m[1]!);
}

/**
 * Every tag in `tags` (plus the `--tag` fallback) must be well-formed (`[body]` or `[a][b]`, or
 * empty for "no tag") and use only bodies from FISH_TAGS. Returns error messages, empty when clean.
 */
export function validateTags(tagMap: Record<string, string>, fallbackTag?: string): string[] {
  const errors: string[] = [];
  const check = (id: string, tag: string): void => {
    if (tag !== '' && tagBodies(tag).length === 0) {
      errors.push(`malformed tag "${tag}" for ${id}; expected [body] or [a][b]`);
      return;
    }
    for (const body of tagBodies(tag)) {
      if (!FISH_TAGS.has(body)) errors.push(`unsupported Fish tag "${body}" for ${id}`);
    }
  };
  for (const [id, tag] of Object.entries(tagMap)) check(id, tag);
  if (fallbackTag !== undefined) check('--tag', fallbackTag);
  return errors;
}

export interface RequestOptions { voiceId: string; model: string; format: 'wav' | 'mp3'; tag: string; tags: Record<string, string>; openComma: boolean }
export interface GenerateOptions extends RequestOptions {
  audioDir: string;
  apiKey: string;
  candidates: number;
  force: boolean;
  only: string[] | null;
  dryRun: boolean;
}
export interface GenerateResult {
  generated: string[];
  skipped: string[];
  failed: Array<{ id: string; error: string }>;
  /** Set only under --dry-run: the number of TTS requests the real run would have made (rows not skipped, times --candidates). */
  wouldGenerate?: number;
}

type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }>;

/**
 * The request for one clip, without the auth header, so it can be printed and tested. An `open`
 * row (followed by a variable in the manifest) gets a trailing comma in the request text when
 * `openComma` is set, so the TTS voice reads it with a non-final contour instead of falling at
 * the end; the sidecar still records `row.text` without the comma.
 */
export function ttsRequest(row: RecordableClip, o: RequestOptions) {
  const tag = o.tags[row.id] ?? o.tag;
  const text = row.note === 'open' && o.openComma ? `${row.text},` : row.text;
  return {
    url: TTS_URL,
    headers: { 'content-type': 'application/json', model: o.model },
    body: { text: tag ? `${tag} ${text}` : text, reference_id: o.voiceId, format: o.format, temperature: 0.7, prosody: { speed: 1, volume: 0 } },
  };
}

export interface ResolvedVoice { id: string; title: string | null; author: string | null }

/**
 * A hex id is used as is (title/author come back null, since it was never looked up). Anything
 * else must match a voice title exactly; Fish's library is public and many voices share a title,
 * so more than one exact match is an error rather than a silent pick of the first one.
 */
export async function resolveVoice(voice: string, apiKey: string, fetchFn: Fetch): Promise<ResolvedVoice> {
  if (/^[0-9a-f]{8,}$/i.test(voice)) return { id: voice, title: null, author: null };
  const res = await fetchFn(`${MODELS_URL}?title=${encodeURIComponent(voice)}&page_size=20`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`voice lookup failed: HTTP ${res.status}`);
  const data = (await res.json()) as { items?: Array<{ _id: string; title: string; author?: { nickname?: string; name?: string } }> };
  const items = data.items ?? [];
  const authorOf = (m: { author?: { nickname?: string; name?: string } }): string => m.author?.nickname ?? m.author?.name ?? 'unknown';
  const matches = items.filter((m) => m.title === voice);
  if (matches.length === 0) throw new Error(`no voice titled "${voice}"${items.length ? ` (found: ${items.map((m) => m.title).join(', ')})` : ''}`);
  if (matches.length > 1) {
    const listed = matches.map((m) => `${m._id} by ${authorOf(m)}`).join(', ');
    throw new Error(`voice title "${voice}" is ambiguous (${matches.length} matches): ${listed}; set FISH_VOICE to the id from the voice's page URL (fish.audio/m/<id>/)`);
  }
  const hit = matches[0]!;
  return { id: hit._id, title: hit.title, author: authorOf(hit) };
}

/** Write `data` to `target` via a same-directory temp file plus rename, so a reader never sees a partial file. */
function writeAtomic(target: string, data: string | Buffer): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}

/** Throws when the response body is not a plausible clip: empty, or (for wav) missing the RIFF header. */
function validateAudio(bytes: Buffer, format: 'wav' | 'mp3'): void {
  if (bytes.length === 0) throw new Error('empty response');
  if (format === 'wav' && bytes.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a wav response');
}

export async function generateClips(rows: RecordableClip[], o: GenerateOptions, fetchFn: Fetch): Promise<GenerateResult> {
  if (!Number.isInteger(o.candidates) || o.candidates < 1 || o.candidates > MAX_CANDIDATES) {
    throw new Error(`candidates must be an integer from 1 to ${MAX_CANDIDATES}, got ${o.candidates}`);
  }
  if (o.only) {
    const known = new Set(rows.map((r) => r.id));
    const unknown = o.only.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`unknown clip id(s): ${unknown.join(', ')}`);
  }

  const result: GenerateResult = { generated: [], skipped: [], failed: [] };
  const present = discoverClips(o.audioDir);
  const wanted = o.only ? rows.filter((r) => o.only!.includes(r.id)) : rows;

  // Read once, not per clip: a per-row re-read would just re-report the same error every time.
  let sidecar: Record<string, string>;
  try {
    sidecar = readRecorded(o.audioDir) ?? {};
  } catch (e) {
    console.error(`recorded.json unreadable, starting a fresh sidecar: ${e instanceof Error ? e.message : String(e)}`);
    sidecar = {};
  }

  let wouldGenerate = 0;
  for (const row of wanted) {
    if (!o.force && o.candidates === 1 && present.has(row.id)) {
      result.skipped.push(row.id);
      continue;
    }
    const req = ttsRequest(row, o);
    if (o.dryRun) {
      wouldGenerate += o.candidates;
      console.log(JSON.stringify({ id: row.id, ...req }));
      continue;
    }
    try {
      for (let n = 1; n <= o.candidates; n++) {
        const res = await fetchFn(req.url, { method: 'POST', headers: { ...req.headers, authorization: `Bearer ${o.apiKey}` }, body: JSON.stringify(req.body) });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, MAX_ERROR_BODY)}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        validateAudio(bytes, o.format);
        const target = o.candidates === 1 ? join(o.audioDir, `${row.id}.${o.format}`) : join(o.audioDir, 'candidates', `${row.id}-${n}.${o.format}`);
        writeAtomic(target, bytes);
      }
      // Only a final (non-candidate) clip counts as "recorded"; candidates are auditioned by hand
      // and copied into place later. Persisted after every successful clip, not batched at the
      // end, so a failure partway through the run doesn't lose the clips that already succeeded.
      if (o.candidates === 1) {
        sidecar = { ...sidecar, [row.id]: row.text };
        const sorted = Object.fromEntries(Object.keys(sidecar).sort().map((k) => [k, sidecar[k]!]));
        writeAtomic(join(o.audioDir, RECORDED_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
      }
      result.generated.push(row.id);
    } catch (e) {
      result.failed.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (o.dryRun) result.wouldGenerate = wouldGenerate;
  return result;
}

const PICK_FORMAT = /^(.+)-(\d+)$/;

/** Splits an `<id>-<n>` pick token; `n` is `''` when the token has no trailing `-<digits>`. */
function splitPick(pick: string): { id: string; n: string } {
  const m = PICK_FORMAT.exec(pick);
  return m ? { id: m[1]!, n: m[2]! } : { id: pick, n: '' };
}

/**
 * Promotes an auditioned candidate (`candidates/<id>-<n>.wav|mp3`, written by a `--candidates`
 * run) to the final clip `<audioDir>/<id>.<ext>`, then deletes the other candidates for that id
 * and records the id in the sidecar. No network, no key: this only moves files that a previous
 * generate run already wrote. Each pick is independent; one bad pick does not stop the rest, and
 * a pick that errors leaves the tree untouched for that id.
 */
export function pickCandidates(picks: string[], audioDir: string, rows: RecordableClip[]): { picked: string[]; errors: string[] } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const candidatesDir = join(audioDir, 'candidates');
  const picked: string[] = [];
  const errors: string[] = [];

  let sidecar: Record<string, string>;
  try {
    sidecar = readRecorded(audioDir) ?? {};
  } catch (e) {
    console.error(`recorded.json unreadable, starting a fresh sidecar: ${e instanceof Error ? e.message : String(e)}`);
    sidecar = {};
  }
  let sidecarChanged = false;

  for (const pick of picks) {
    const { id, n } = splitPick(pick);
    const row = byId.get(id);
    if (!row) { errors.push(`unknown clip id: ${id}`); continue; }

    const ext = (['wav', 'mp3'] as const).find((e) => existsSync(join(candidatesDir, `${id}-${n}.${e}`)));
    if (!ext) { errors.push(`no candidate ${id}-${n} under ${audioDir}/candidates`); continue; }

    // Remove any existing final clip in either format first, so the id is never recorded twice.
    for (const e of ['wav', 'mp3'] as const) {
      const existing = join(audioDir, `${id}.${e}`);
      if (existsSync(existing)) rmSync(existing);
    }
    renameSync(join(candidatesDir, `${id}-${n}.${ext}`), join(audioDir, `${id}.${ext}`));

    // Delete the other candidates left over for this id (the picked one already moved away).
    let leftovers: string[] = [];
    try { leftovers = readdirSync(candidatesDir); } catch { leftovers = []; }
    for (const name of leftovers) {
      if (!name.startsWith(`${id}-`)) continue;
      const rest = name.slice(id.length + 1);
      if (/^\d+\.(wav|mp3)$/.test(rest)) rmSync(join(candidatesDir, name));
    }

    sidecar = { ...sidecar, [id]: row.text };
    sidecarChanged = true;
    picked.push(pick);
  }

  if (sidecarChanged) {
    const sorted = Object.fromEntries(Object.keys(sidecar).sort().map((k) => [k, sidecar[k]!]));
    writeAtomic(join(audioDir, RECORDED_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
  }

  return { picked, errors };
}

async function main(): Promise<void> {
  const { parseArgs } = await import('node:util');
  const { values: a } = parseArgs({ options: {
    voice: { type: 'string' }, model: { type: 'string', default: 's2.1-pro' }, format: { type: 'string', default: 'wav' },
    tag: { type: 'string', default: '[calm]' }, candidates: { type: 'string', default: '1' }, only: { type: 'string' },
    force: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, 'plain-open': { type: 'boolean', default: false },
    pick: { type: 'string' },
  } });
  const audioDir = process.env.AUDIO_DIR?.trim() || 'assets/audio';
  // --pick only moves files a previous generate run already wrote; it needs no key and no voice,
  // so it runs (and exits) before either is checked.
  if (a.pick) {
    const picks = a.pick.split(',').map((s) => s.trim()).filter(Boolean);
    const r = pickCandidates(picks, audioDir, recordableClips());
    for (const p of r.picked) {
      const { id, n } = splitPick(p);
      console.log(`picked ${id} from candidate ${n}`);
    }
    for (const e of r.errors) console.log(`  ${e}`);
    process.exitCode = r.errors.length ? 1 : 0;
    return;
  }
  const apiKey = process.env.FISH_AUDIO_API_KEY?.trim();
  const voice = a.voice ?? process.env.FISH_VOICE?.trim();
  if (!a['dry-run'] && !apiKey) throw new Error('FISH_AUDIO_API_KEY is not set');
  if (!voice) throw new Error('pass --voice <title or id> or set FISH_VOICE');
  const format = a.format === 'mp3' ? 'mp3' : 'wav';
  const tagErrors = validateTags(tags as Record<string, string>, a.tag);
  if (tagErrors.length) throw new Error(tagErrors.join('; '));
  // Dry run never resolves the voice (a network call) even when a key happens to be set: it only
  // ever prints requests, so the id printed is whatever was passed on the command line.
  let voiceId: string;
  if (a['dry-run']) {
    voiceId = voice;
    console.log(`voice: ${voice} (not resolved on a dry run)`);
  } else {
    const resolved = await resolveVoice(voice, apiKey ?? '', fetch);
    voiceId = resolved.id;
    console.log(resolved.title !== null ? `voice: ${resolved.title} by ${resolved.author} (${resolved.id})` : `voice: ${resolved.id}`);
  }
  const r = await generateClips(recordableClips(), {
    audioDir,
    apiKey: apiKey ?? '',
    voiceId,
    model: a.model!,
    format,
    tag: a.tag!,
    tags: tags as Record<string, string>,
    openComma: !a['plain-open'],
    candidates: Number(a.candidates),
    force: a.force ?? false,
    only: a.only ? a.only.split(',').map((s) => s.trim()) : null,
    dryRun: a['dry-run'] ?? false,
  }, fetch);
  if (r.wouldGenerate !== undefined) {
    console.log(`would generate ${r.wouldGenerate}`);
  } else {
    console.log(`generated ${r.generated.length}, skipped ${r.skipped.length}, failed ${r.failed.length}`);
  }
  for (const f of r.failed) console.log(`  ${f.id}: ${f.error}`);
  process.exitCode = r.failed.length ? 1 : 0;
}

if (process.argv[1] && basename(process.argv[1]) === 'generate.ts') main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
