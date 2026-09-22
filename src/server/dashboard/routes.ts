import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardBus } from './bus';
import { redactFrameLine, redactRecord } from './events';
import { readFrameLog, type ReadFrameLogLine } from '../frameLog';
import type { TraceRecord } from '../../trace/types';
import { spokenText } from '../../prompts/render';

export interface DashboardDeps { bus: DashboardBus; traceDir: string; enabled: boolean }

/** One trace record as `/dashboard/traces/<sid>` returns it: redacted, plus the line the caller heard. */
export type ReplayRecord = TraceRecord & { spokenText: string };

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HEARTBEAT_MS = 15_000;
/** The same shape `safeFileStem` produces, so nothing else can reach the filesystem. */
const SID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TRACES = 50;

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * What the caller heard on this turn, rendered here so the page never has to know the prompt
 * manifest. A record whose decision no longer renders — a prompt id or variable that has since
 * changed — is worth showing without its line rather than failing the whole trace.
 */
function spokenOf(record: TraceRecord): string {
  try {
    const text = spokenText(record.decision);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** The redacted records and frames of one trace. Both are raw on disk and public over this route. */
function readTrace(traceDir: string, sid: string): { records: ReplayRecord[]; frames: ReadFrameLogLine[] } {
  const records = readFileSync(join(traceDir, `${sid}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const record = redactRecord(JSON.parse(line) as TraceRecord);
      return { ...record, spokenText: spokenOf(record) };
    });
  const framesPath = join(traceDir, `${sid}.frames.jsonl`);
  // redactFrameLine widens the type back to FrameLogLine; readFrameLog's line number survives the
  // spread, so it is restored here rather than dropped from what the page gets.
  const frames = existsSync(framesPath) ? readFrameLog(framesPath).map((l) => ({ ...redactFrameLine(l), line: l.line })) : [];
  return { records, frames };
}

/** Returns true when the request was a dashboard route (handled), false to let the caller continue. */
export function handleDashboardRequest(req: IncomingMessage, res: ServerResponse, deps: DashboardDeps): boolean {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (!path.startsWith('/dashboard')) return false;
  if (!deps.enabled) return false;
  if (req.method !== 'GET') { send(res, 405, 'text/plain', 'method not allowed'); return true; }

  if (path === '/dashboard' || path === '/dashboard/') {
    send(res, 200, 'text/html; charset=utf-8', readFileSync(join(HERE, 'page.html')));
    return true;
  }
  if (path === '/dashboard/view.js') {
    send(res, 200, 'text/javascript; charset=utf-8', readFileSync(join(HERE, 'view.js')));
    return true;
  }
  if (path === '/dashboard/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const off = deps.bus.subscribe((event) => {
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    // A comment line keeps a proxy (and ngrok) from closing an idle stream between calls.
    const beat = setInterval(() => res.write(': hb\n\n'), HEARTBEAT_MS);
    beat.unref?.();
    req.on('close', () => { off(); clearInterval(beat); });
    return true;
  }
  if (path === '/dashboard/traces') {
    const rows = readdirSync(deps.traceDir)
      .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.frames.jsonl'))
      .map((f) => {
        const full = join(deps.traceDir, f);
        const text = readFileSync(full, 'utf8');
        const lines = text.split('\n').filter(Boolean);
        let startedAt: string | null = null;
        try { startedAt = (JSON.parse(lines[0] ?? '{}') as { ts?: string }).ts ?? null; } catch { startedAt = null; }
        return { callSid: f.slice(0, -'.jsonl'.length), startedAt, turns: lines.length, sizeBytes: statSync(full).size };
      })
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .slice(0, MAX_TRACES);
    send(res, 200, 'application/json', JSON.stringify(rows));
    return true;
  }
  const m = /^\/dashboard\/traces\/([^/]+)$/.exec(path);
  if (m) {
    let sid: string;
    try {
      sid = decodeURIComponent(m[1]!);
    } catch {
      send(res, 404, 'text/plain', 'not found');
      return true;
    }
    if (!SID.test(sid) || !existsSync(join(deps.traceDir, `${sid}.jsonl`))) {
      send(res, 404, 'text/plain', 'not found');
      return true;
    }
    send(res, 200, 'application/json', JSON.stringify(readTrace(deps.traceDir, sid)));
    return true;
  }
  send(res, 404, 'text/plain', 'not found');
  return true;
}
