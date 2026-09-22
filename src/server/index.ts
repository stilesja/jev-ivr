import { createServer, type Server } from 'node:http';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeConfig, loadConfig, type ServerConfig } from './config';
import { createRequestHandler } from './http';
import { attachWebSocketServer } from './ws';
import { forgetNoInput } from './adapter';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { buildHints } from './hints';
import { DashboardBus } from './dashboard/bus';
import { redactRecord } from './dashboard/events';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { buildClient, DEFAULT_CORPUS_FILE } from '../run/client';
import { localDateIso } from '../run/clock';
import type { JevClient } from '../jev/types';
import { TraceWriter } from '../trace/writer';
import type { TurnObserver } from '../run/turn';
import { spokenText } from '../prompts/render';
import { clipVersions, discoverClips, recordableClips } from '../prompts/clips';
import { clipDurations } from '../prompts/playback';
import { coverage, readRecorded } from '../prompts/sheet';

export interface RunningServer {
  server: Server;
  port: number;
  store: SessionStore;
  tokens: CallTokens;
  /** The dashboard's event bus, or undefined when DASHBOARD=off. */
  bus?: DashboardBus;
  close(): Promise<void>;
}

export interface ServerOverrides {
  client?: JevClient;
  now?: () => number;
  log?: (line: string) => void;
  /** Tests use a short deadline so a connection that never sends setup does not hold the suite open. */
  setupTimeoutMs?: number;
  /** Tests use a short grace period to prove the end-close backstop fires without waiting 30 seconds. */
  endCloseGraceMs?: number;
  /** Tests use a short wait so a silence turn runs without sitting through the configured seven seconds. */
  noInputMs?: number;
}

const TOKEN_TTL_MS = 10 * 60 * 1000;
const EVICT_EVERY_MS = 60 * 1000;
/** How long a shutdown waits for turns already in flight before it terminates the sockets anyway. */
const DRAIN_TIMEOUT_MS = 2_000;

/**
 * Call SIDs come from Twilio (CA + 32 hex), but they arrive over the socket, so never let one shape a path.
 * Dots are replaced too, not only separators: a SID of `CA1.frames` would otherwise write its trace to
 * `CA1.frames.jsonl` and collide with call CA1's frame log.
 */
export function safeFileStem(callSid: string): string {
  const cleaned = callSid.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length ? cleaned.slice(0, 64) : 'unknown';
}

export async function startServer(config: ServerConfig, overrides: ServerOverrides = {}): Promise<RunningServer> {
  const log = overrides.log ?? ((line: string) => console.log(`[server] ${line}`));
  const now = overrides.now ?? (() => Date.now());
  const thresholds = { ...DEFAULT_THRESHOLDS };
  const client = overrides.client ?? buildClient(config.jevClient, DEFAULT_CORPUS_FILE, thresholds);
  // Wall-clock date in the configured zone: a caller at 8pm Pacific means today, not tomorrow.
  const todayIso = () => config.todayOverride ?? localDateIso(now(), config.timezone);

  const clips = discoverClips(config.audioDir);
  const durations = clipDurations(config.audioDir);
  let recorded: Record<string, string> | null;
  try {
    recorded = readRecorded(config.audioDir);
  } catch (e) {
    log(`audio: ignoring unreadable recorded.json: ${e instanceof Error ? e.message : String(e)}`);
    recorded = null;
  }
  const cov = coverage(recordableClips(), clips, recorded);
  const missingSuffix =
    cov.missing.length === 0
      ? ''
      : `: missing ${cov.missing.slice(0, 10).join(', ')}${cov.missing.length > 10 ? ` +${cov.missing.length - 10} more` : ''}`;
  log(`audio: ${cov.present} of ${cov.total} clips present in ${config.audioDir} (${cov.missing.length} segments fall back to TTS)${missingSuffix}`);
  if (cov.stale.length > 0) {
    log(`audio: ${cov.stale.length} stale clips (recorded text differs from the sheet): ${cov.stale.join(', ')}`);
  }
  const noInputMs = overrides.noInputMs ?? config.noInputMs;
  log(noInputMs > 0 ? `no-input: ${noInputMs} ms after playback (${durations.size} clip durations)` : 'no-input: off');
  // The coverage/count logic above stays on the unversioned map; only what the caller actually
  // fetches carries the content hash, so a regenerated clip is never served from Twilio's cache.
  const render = { clips: clipVersions(config.audioDir, clips), audioBase: `https://${config.publicHost}/audio/` };

  const bus = config.dashboard ? new DashboardBus() : undefined;
  log(bus ? 'dashboard: /dashboard' : 'dashboard: off');

  const store = new SessionStore(
    (callSid) => {
      const file = safeFileStem(callSid);
      const trace = new TraceWriter(join(config.traceDir, `${file}.jsonl`));
      // The turn index the record of the turn now starting will carry. `bookkeep` increments the
      // session's counter before the record is built, so the record of the first turn is 1 and the
      // live session's counter is one behind. Read from the store, not from the resources object
      // below: the store spreads these into its own entry, and it is the entry's `session` the
      // adapter replaces after every turn. (`history` is no substitute: HISTORY_WINDOW caps it.)
      const askedTurnIndex = () => (store.get(callSid)?.session.turnIndex ?? 0) + 1;
      const observe: TurnObserver | null = bus
        ? {
            asked: (questions, turnState, at) => bus.publish({ type: 'asked', callSid, at, turnIndex: askedTurnIndex(), questions, turnState }),
            // Published record is redacted for the dashboard bus; the trace file on disk (written
            // by opts.trace above) keeps the unredacted record.
            turn: (record, at) => bus.publish({ type: 'turn', callSid, at, record: redactRecord(record), spoken: spokenText(record.decision) }),
          }
        : null;
      return {
        session: newSession(callSid, now()),
        opts: { client, thresholds, todayIso: todayIso(), trace, now, render, observe },
        trace,
        frames: new FrameLog(join(config.traceDir, `${file}.frames.jsonl`), now),
      };
    },
    config.sessionTtlMs,
    now,
    config.sessionMaxAgeMs,
  );
  const tokens = new CallTokens(TOKEN_TTL_MS, now);
  const deps = { config, store, tokens, hints: buildHints(), log, bus };

  const server = createServer(createRequestHandler(deps));
  const wss = attachWebSocketServer(
    server,
    { store, tokens, log, endCloseGraceMs: overrides.endCloseGraceMs, noInputMs, clipDurations: durations, bus, handoffNumber: config.handoffNumber },
    overrides.setupTimeoutMs,
  );
  const evictor = setInterval(() => {
    for (const sid of store.evictIdle()) {
      // An evicted call with a socket gets here again through the socket's own close, but one
      // whose socket had already gone would otherwise leave its no-input bookkeeping behind.
      forgetNoInput(sid);
      log(`${sid}: evicted idle session`);
    }
    const swept = tokens.evictExpired();
    if (swept) log(`swept ${swept} expired call tokens`);
  }, EVICT_EVERY_MS);
  evictor.unref();

  // listen reports failure as an 'error' event, which is unhandled (and fatal) unless it is awaited here.
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(config.port, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
  } catch (err) {
    clearInterval(evictor);
    wss.close();
    throw err;
  }
  const port = (server.address() as { port: number }).port;

  return {
    server,
    port,
    store,
    tokens,
    bus,
    close: async () => {
      clearInterval(evictor);
      // Let turns that are already running finish (and flush their frames) before the sockets go away.
      const tails = store.tails();
      if (tails.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(tails),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
    },
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
