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
  lastActivityMs: number;
  ended: boolean;
  tail: Promise<void>;
  inFlight: number;
}

export type CallFactory = (callSid: string) => CallResources;

export class SessionStore {
  private readonly calls = new Map<string, CallEntry>();

  constructor(
    private readonly factory: CallFactory,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(callSid: string): CallEntry | undefined {
    return this.calls.get(callSid);
  }

  size(): number {
    return this.calls.size;
  }

  create(callSid: string, socket: SocketLike): CallEntry {
    if (this.calls.has(callSid)) throw new Error(`session for ${callSid} already exists`);
    const entry: CallEntry = {
      ...this.factory(callSid),
      callSid,
      socket,
      reconnects: 0,
      lastActivityMs: this.now(),
      ended: false,
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
      e.ended = true;
      e.lastActivityMs = this.now();
    }
  }

  /** Remove sessions idle longer than the TTL. Skips sessions with in-flight work. Returns the evicted call SIDs. */
  evictIdle(): string[] {
    const cutoff = this.now() - this.ttlMs;
    const gone: string[] = [];
    for (const [sid, e] of this.calls) {
      if (e.inFlight > 0) continue;
      if (e.lastActivityMs < cutoff) {
        if (e.socket) e.socket.close(1000, 'session evicted');
        this.calls.delete(sid);
        gone.push(sid);
      }
    }
    return gone;
  }
}
