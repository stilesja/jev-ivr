import { createServer, type Server } from 'node:http';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeConfig, loadConfig, type ServerConfig } from './config';
import { createRequestHandler } from './http';
import { attachWebSocketServer } from './ws';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { buildHints } from './hints';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { buildClient, DEFAULT_CORPUS_FILE } from '../run/client';
import type { JevClient } from '../jev/types';
import { TraceWriter } from '../trace/writer';

export interface RunningServer {
  server: Server;
  port: number;
  store: SessionStore;
  tokens: CallTokens;
  close(): Promise<void>;
}

export interface ServerOverrides {
  client?: JevClient;
  now?: () => number;
  log?: (line: string) => void;
}

const TOKEN_TTL_MS = 10 * 60 * 1000;
const EVICT_EVERY_MS = 60 * 1000;

/**
 * Call SIDs come from Twilio (CA + 32 hex), but they arrive over the socket, so never let one shape a path.
 * Dots survive (they are legal in a file name); separators do not, so no stem can escape the trace directory
 * and no stem is a bare `.` or `..` component once the `.jsonl` suffix is appended.
 */
export function safeFileStem(callSid: string): string {
  const cleaned = callSid.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length ? cleaned.slice(0, 64) : 'unknown';
}

export async function startServer(config: ServerConfig, overrides: ServerOverrides = {}): Promise<RunningServer> {
  const log = overrides.log ?? ((line: string) => console.log(`[server] ${line}`));
  const now = overrides.now ?? (() => Date.now());
  const thresholds = { ...DEFAULT_THRESHOLDS };
  const client = overrides.client ?? buildClient(config.jevClient, DEFAULT_CORPUS_FILE, thresholds);
  const todayIso = () => config.todayOverride ?? new Date(now()).toISOString().slice(0, 10);

  const store = new SessionStore(
    (callSid) => {
      const file = safeFileStem(callSid);
      const trace = new TraceWriter(join(config.traceDir, `${file}.jsonl`));
      return {
        session: newSession(callSid, now()),
        opts: { client, thresholds, todayIso: todayIso(), trace, now },
        trace,
        frames: new FrameLog(join(config.traceDir, `${file}.frames.jsonl`), now),
      };
    },
    config.sessionTtlMs,
    now,
  );
  const tokens = new CallTokens(TOKEN_TTL_MS, now);
  const deps = { config, store, tokens, hints: buildHints(), log };

  const server = createServer(createRequestHandler(deps));
  const wss = attachWebSocketServer(server, { store, tokens, log });
  const evictor = setInterval(() => {
    for (const sid of store.evictIdle()) log(`${sid}: evicted idle session`);
    const swept = tokens.evictExpired();
    if (swept) log(`swept ${swept} expired call tokens`);
  }, EVICT_EVERY_MS);
  evictor.unref();

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const port = (server.address() as { port: number }).port;

  return {
    server,
    port,
    store,
    tokens,
    close: () =>
      new Promise((resolve) => {
        clearInterval(evictor);
        for (const c of wss.clients) c.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    const config = loadConfig(process.env);
    console.log(`[server] ${describeConfig(config)}`);
    if (!config.signatureCheck) console.log('[server] WARNING: Twilio signature validation is OFF');
    const running = await startServer(config);
    console.log(`[server] listening on ${running.port}; voice webhook https://${config.publicHost}/voice`);
    const stop = () => {
      console.log('[server] shutting down');
      void running.close().then(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
