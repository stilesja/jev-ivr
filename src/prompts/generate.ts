import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClips, recordableClips, type RecordableClip } from './clips';
import { readRecorded, RECORDED_FILE } from './sheet';

const TTS_URL = 'https://api.fish.audio/v1/tts';
const MODELS_URL = 'https://api.fish.audio/model';

export interface RequestOptions { voiceId: string; model: string; format: 'wav' | 'mp3'; tag: string; tags: Record<string, string> }
export interface GenerateOptions extends RequestOptions {
  audioDir: string;
  apiKey: string;
  candidates: number;
  force: boolean;
  only: string[] | null;
  dryRun: boolean;
}
export interface GenerateResult { generated: string[]; skipped: string[]; failed: Array<{ id: string; error: string }> }

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }>;

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
  const data = (await res.json!()) as { items?: Array<{ _id: string; title: string }> };
  const items = data.items ?? [];
  const hit = items.find((m) => m.title === voice);
  if (!hit) throw new Error(`no voice titled "${voice}"${items.length ? ` (found: ${items.map((m) => m.title).join(', ')})` : ''}`);
  return hit._id;
}

/** Merge generated clip texts into the sidecar prompts:check reads for stale detection. */
function recordGenerated(audioDir: string, entries: Record<string, string>): void {
  if (Object.keys(entries).length === 0) return;
  const merged = { ...(readRecorded(audioDir) ?? {}), ...entries };
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]!]));
  writeFileSync(join(audioDir, RECORDED_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
}

export async function generateClips(rows: RecordableClip[], o: GenerateOptions, fetchFn: Fetch): Promise<GenerateResult> {
  const result: GenerateResult = { generated: [], skipped: [], failed: [] };
  const present = discoverClips(o.audioDir);
  const wanted = o.only ? rows.filter((r) => o.only!.includes(r.id)) : rows;
  const recorded: Record<string, string> = {};
  for (const row of wanted) {
    if (!o.force && o.candidates === 1 && present.has(row.id)) { result.skipped.push(row.id); continue; }
    const req = ttsRequest(row, o);
    if (o.dryRun) { console.log(JSON.stringify({ id: row.id, ...req })); continue; }
    try {
      for (let n = 1; n <= o.candidates; n++) {
        const res = await fetchFn(req.url, { method: 'POST', headers: { ...req.headers, authorization: `Bearer ${o.apiKey}` }, body: JSON.stringify(req.body) });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.text ? await res.text() : ''}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        const target = o.candidates === 1 ? join(o.audioDir, `${row.id}.${o.format}`) : join(o.audioDir, 'candidates', `${row.id}-${n}.${o.format}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
      if (o.candidates === 1) recorded[row.id] = row.text;
      result.generated.push(row.id);
    } catch (e) {
      result.failed.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  recordGenerated(o.audioDir, recorded);
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
  const tags = JSON.parse(readFileSync(fileURLToPath(new URL('./tags.json', import.meta.url)), 'utf8')) as Record<string, string>;
  const voiceId = a['dry-run'] && !apiKey ? voice : await resolveVoice(voice, apiKey ?? '', fetch as unknown as Fetch);
  const r = await generateClips(recordableClips(), {
    audioDir: process.env.AUDIO_DIR?.trim() || 'assets/audio', apiKey: apiKey ?? '', voiceId, model: a.model!, format, tag: a.tag!, tags,
    candidates: Math.max(1, Number(a.candidates) || 1), force: a.force ?? false, only: a.only ? a.only.split(',').map((s) => s.trim()) : null, dryRun: a['dry-run'] ?? false,
  }, fetch as unknown as Fetch);
  console.log(`generated ${r.generated.length}, skipped ${r.skipped.length}, failed ${r.failed.length}`);
  for (const f of r.failed) console.log(`  ${f.id}: ${f.error}`);
  process.exitCode = r.failed.length ? 1 : 0;
}

if (process.argv[1] && basename(process.argv[1]) === 'generate.ts') main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
