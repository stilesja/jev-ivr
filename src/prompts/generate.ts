import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { discoverClips, recordableClips, type RecordableClip } from './clips';
import { readRecorded, RECORDED_FILE } from './sheet';
import tags from './tags.json';

const TTS_URL = 'https://api.fish.audio/v1/tts';
const MODELS_URL = 'https://api.fish.audio/model';
const MAX_CANDIDATES = 20;
const MAX_ERROR_BODY = 200;

export interface RequestOptions { voiceId: string; model: string; format: 'wav' | 'mp3'; tag: string; tags: Record<string, string> }
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

/** The request for one clip, without the auth header, so it can be printed and tested. */
export function ttsRequest(row: RecordableClip, o: RequestOptions) {
  const tag = o.tags[row.id] ?? o.tag;
  return {
    url: TTS_URL,
    headers: { 'content-type': 'application/json', model: o.model },
    body: { text: tag ? `${tag} ${row.text}` : row.text, reference_id: o.voiceId, format: o.format, temperature: 0.7, prosody: { speed: 1, volume: 0 } },
  };
}

/** A hex id is used as is; anything else must match a voice title exactly. */
export async function resolveVoice(voice: string, apiKey: string, fetchFn: Fetch): Promise<string> {
  if (/^[0-9a-f]{8,}$/i.test(voice)) return voice;
  const res = await fetchFn(`${MODELS_URL}?title=${encodeURIComponent(voice)}&page_size=20`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`voice lookup failed: HTTP ${res.status}`);
  const data = (await res.json()) as { items?: Array<{ _id: string; title: string }> };
  const items = data.items ?? [];
  const hit = items.find((m) => m.title === voice);
  if (!hit) throw new Error(`no voice titled "${voice}"${items.length ? ` (found: ${items.map((m) => m.title).join(', ')})` : ''}`);
  return hit._id;
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

async function main(): Promise<void> {
  const { parseArgs } = await import('node:util');
  const { values: a } = parseArgs({ options: {
    voice: { type: 'string' }, model: { type: 'string', default: 's2.1-pro' }, format: { type: 'string', default: 'wav' },
    tag: { type: 'string', default: '[warm]' }, candidates: { type: 'string', default: '1' }, only: { type: 'string' },
    force: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
  } });
  const apiKey = process.env.FISH_AUDIO_API_KEY?.trim();
  const voice = a.voice ?? process.env.FISH_VOICE?.trim();
  if (!a['dry-run'] && !apiKey) throw new Error('FISH_AUDIO_API_KEY is not set');
  if (!voice) throw new Error('pass --voice <title or id> or set FISH_VOICE');
  const format = a.format === 'mp3' ? 'mp3' : 'wav';
  // Dry run never resolves the voice (a network call) even when a key happens to be set: it only
  // ever prints requests, so the id printed is whatever was passed on the command line.
  const voiceId = a['dry-run'] ? voice : await resolveVoice(voice, apiKey ?? '', fetch);
  const r = await generateClips(recordableClips(), {
    audioDir: process.env.AUDIO_DIR?.trim() || 'assets/audio',
    apiKey: apiKey ?? '',
    voiceId,
    model: a.model!,
    format,
    tag: a.tag!,
    tags: tags as Record<string, string>,
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
