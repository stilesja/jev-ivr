import type { Session } from '../core/session';
import type { RunOptions } from '../run/turn';
import type { TraceWriter } from '../trace/writer';
import type { FrameLog } from './frameLog';

/** The subset of a ws.WebSocket the adapter uses, so tests can substitute a fake. */
export interface SocketLike {
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export interface CallResources {
  session: Session;
  opts: RunOptions;
  trace: TraceWriter;
  frames: FrameLog;
}

export interface CallEntry extends CallResources {
  callSid: string;
  socket: SocketLike | null;
  reconnects: number;
  createdAtMs: number;
  lastActivityMs: number;
  ended: boolean;
  /** When `ended` was first set, so an ended call is retained for a fixed grace period, not a TTL. */
  endedAtMs: number | null;
  tail: Promise<void>;
  inFlight: number;
}

export type CallFactory = (callSid: string) => CallResources;

/**
 * How long an ended call is kept after it ends. Long enough for a late `/cr-action` callback or a
 * stray frame to find the session it belongs to, short enough that a busy line does not accumulate
 * finished calls for the half hour the idle TTL would allow.
 */
export const ENDED_GRACE_MS = 60_000;

/** Nothing legitimate keeps one phone call alive this long; past it the entry is a leak. */
export const DEFAULT_SESSION_MAX_AGE_MS = 7_200_000;

export class SessionStore {
  private readonly calls = new Map<string, CallEntry>();

  constructor(
    private readonly factory: CallFactory,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxAgeMs: number = DEFAULT_SESSION_MAX_AGE_MS,
  ) {}

  get(callSid: string): CallEntry | undefined {
    return this.calls.get(callSid);
  }

  /** Every entry the store is holding, ended ones included. */
  size(): number {
    return this.calls.size;
  }

  /** Entries for calls that have not ended: the sessions that could still speak to a caller. */
  liveCount(): number {
    let n = 0;
    for (const e of this.calls.values()) if (!e.ended) n += 1;
    return n;
  }

  create(callSid: string, socket: SocketLike): CallEntry {
    if (this.calls.has(callSid)) throw new Error(`session for ${callSid} already exists`);
    const entry: CallEntry = {
      ...this.factory(callSid),
      callSid,
      socket,
      reconnects: 0,
      createdAtMs: this.now(),
      lastActivityMs: this.now(),
      ended: false,
      endedAtMs: null,
      tail: Promise.resolve(),
      inFlight: 0,
    };
    this.calls.set(callSid, entry);
    return entry;
  }

  attach(callSid: string, socket: SocketLike): CallEntry | undefined {
    const e = this.calls.get(callSid);
    if (!e) return undefined;
    e.socket = socket;
    e.lastActivityMs = this.now();
    return e;
  }

  detach(callSid: string): void {
    const e = this.calls.get(callSid);
    if (e) e.socket = null;
  }

  touch(callSid: string): void {
    const e = this.calls.get(callSid);
    if (e) e.lastActivityMs = this.now();
  }

  /**
   * Serialize work per call: fn runs after everything previously queued for this call, errors
   * are logged, the chain continues. A call already ended skips the fn (a turn queued behind
   * the completing turn must not speak after the end). The chain itself can never become a
   * rejected promise, even if logging the error fails (e.g. ENOSPC) - a poisoned tail would
   * cause every later enqueue to silently skip its fn forever.
   */
  enqueue(callSid: string, fn: (entry: CallEntry) => Promise<void>): Promise<void> {
    const e = this.calls.get(callSid);
    if (!e) return Promise.resolve();
    const run = e.tail
      .then(async () => {
        if (e.ended) return;
        e.inFlight++;
        try {
          await fn(e);
        } finally {
          e.inFlight--;
        }
      })
      .catch((err: unknown) => {
        const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';
        const message = err instanceof Error ? `${err.name}: ${err.message}${stack}` : String(err);
        try {
          e.frames.write('log', { error: message });
        } catch (logErr) {
          console.error(`sessions: failed to log turn error for ${callSid}`, message, logErr);
        }
      });
    e.tail = run.catch(() => {});
    e.lastActivityMs = this.now();
    return run;
  }

  /** The queue tail of every live call, so a shutdown can wait for turns that are already running. */
  tails(): Promise<void>[] {
    return [...this.calls.values()].map((e) => e.tail);
  }

  end(callSid: string): void {
    const e = this.calls.get(callSid);
    if (e) {
      // `end` is idempotent and can arrive twice (the adapter and the action callback both call
      // it), but the grace period runs from the first end, not the last.
      if (!e.ended) e.endedAtMs = this.now();
      e.ended = true;
      e.lastActivityMs = this.now();
    }
  }

  /**
   * Remove sessions that have outlived their usefulness, and return the evicted call SIDs.
   *
   * Three reasons to go: the entry is older than `maxAgeMs` (a hard cap, which is the only one
   * that ignores in-flight work - an entry that old is stuck, and waiting for a turn that will
   * never finish is what leaked it), the call ended more than `ENDED_GRACE_MS` ago, or it has
   * been idle longer than the TTL.
   */
  evictIdle(): string[] {
    const now = this.now();
    const idleCutoff = now - this.ttlMs;
    const gone: string[] = [];
    for (const [sid, e] of this.calls) {
      const expired = now - e.createdAtMs >= this.maxAgeMs;
      if (!expired) {
        if (e.inFlight > 0) continue;
        const graceOver = e.ended && e.endedAtMs !== null && now - e.endedAtMs >= ENDED_GRACE_MS;
        if (!graceOver && e.lastActivityMs >= idleCutoff) continue;
      }
      if (e.socket) e.socket.close(1000, expired ? 'session expired' : 'session evicted');
      this.calls.delete(sid);
      gone.push(sid);
    }
    return gone;
  }
}
