import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardBus } from './bus';
import { redactFrameLine, redactRecord } from './events';
import { readFrameLog, type ReadFrameLogLine } from '../frameLog';
import type { TraceRecord } from '../../trace/types';
import { spokenText } from '../../prompts/render';

// `enabled` duplicates `deps.bus`'s existence in production (src/server/index.ts only builds a
// bus when the dashboard is on, and src/server/http.ts only reaches this module when that bus is
// present); it is kept as its own field so routes.test.ts can exercise "disabled" against a real
// bus without also having to fake a config.
export interface DashboardDeps { bus: DashboardBus; traceDir: string; enabled: boolean }

/** One trace record as `/dashboard/traces/<sid>` returns it: redacted, plus the line the caller heard. */
export type ReplayRecord = TraceRecord & { spokenText: string };

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HEARTBEAT_MS = 15_000;
/** The same shape `safeFileStem` produces, so nothing else can reach the filesystem. */
const SID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TRACES = 50;
/** A viewer whose socket has stalled must not make the server buffer the whole call. */
const MAX_STREAM_BACKLOG = 1_000_000;

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, headOnly = false): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  if (headOnly) res.end(); else res.end(body);
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

/**
 * The parseable lines of a trace file. A killed process leaves a partial last line behind, and one
 * truncated line is no reason to fail the whole route, so unparseable lines are dropped.
 */
function traceLines(path: string): TraceRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        // A line that parses but isn't a plain object -- `null`, an array, a bare number or
        // string -- is as malformed as one that doesn't parse at all: redactRecord walks it as a
        // record and a `null` reaches Object.entries and throws.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
        return [parsed as TraceRecord];
      } catch {
        return [];
      }
    });
}

/** The redacted records and frames of one trace. Both are raw on disk and public over this route. */
function readTrace(traceDir: string, sid: string): { records: ReplayRecord[]; frames: ReadFrameLogLine[] } {
  const records = traceLines(join(traceDir, `${sid}.jsonl`)).map((raw) => {
    const record = redactRecord(raw);
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
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) { send(res, 405, 'text/plain', 'method not allowed'); return true; }

  if (path === '/dashboard' || path === '/dashboard/') {
    send(res, 200, 'text/html; charset=utf-8', readFileSync(join(HERE, 'page.html')), head);
    return true;
  }
  if (path === '/dashboard/view.js') {
    send(res, 200, 'text/javascript; charset=utf-8', readFileSync(join(HERE, 'view.js')), head);
    return true;
  }
  if (path === '/dashboard/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    // A HEAD is a probe, not a viewer: answer the headers and subscribe nothing.
    if (head) { res.end(); return true; }
    res.write(': connected\n\n');
    const off = deps.bus.subscribe((event) => {
      // A stalled viewer is dropped frames, not unbounded memory; the page notices the gap in
      // `seq` and shows a warning rather than reloading on its own (page.html's `es.onmessage`).
      if (res.writableLength > MAX_STREAM_BACKLOG) return;
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    // A comment line keeps a proxy (and ngrok) from closing an idle stream between calls.
    const beat = setInterval(() => res.write(': hb\n\n'), HEARTBEAT_MS);
    beat.unref?.();
    req.on('close', () => { off(); clearInterval(beat); });
    return true;
  }
  if (path === '/dashboard/traces') {
    // Nothing creates the trace directory until the first call, so an empty dashboard is the
    // normal state of a fresh checkout rather than a 500.
    let names: string[];
    try {
      names = readdirSync(deps.traceDir);
    } catch {
      names = [];
    }
    const rows = names
      .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.frames.jsonl'))
      .flatMap((f) => {
        const full = join(deps.traceDir, f);
        try {
          const stat = statSync(full);
          return [{ f, full, mtimeMs: stat.mtimeMs, sizeBytes: stat.size }];
        } catch {
          return [];
        }
      })
      // Newest first by mtime, so only the files the page can show are read off disk.
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_TRACES)
      .map(({ f, full, sizeBytes }) => {
        const lines = traceLines(full);
        return { callSid: f.slice(0, -'.jsonl'.length), startedAt: lines[0]?.ts ?? null, turns: lines.length, sizeBytes };
      })
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    send(res, 200, 'application/json', JSON.stringify(rows), head);
    return true;
  }
  const m = /^\/dashboard\/traces\/([^/]+)$/.exec(path);
  if (m) {
    let sid: string;
    try {
      sid = decodeURIComponent(m[1]!);
    } catch {
      send(res, 404, 'text/plain', 'not found', head);
      return true;
    }
    if (!SID.test(sid) || !existsSync(join(deps.traceDir, `${sid}.jsonl`))) {
      send(res, 404, 'text/plain', 'not found', head);
      return true;
    }
    send(res, 200, 'application/json', JSON.stringify(readTrace(deps.traceDir, sid)), head);
    return true;
  }
  send(res, 404, 'text/plain', 'not found', head);
  return true;
}
