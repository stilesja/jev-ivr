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

  /** Serialize work per call: fn runs after everything previously queued for this call, errors are logged, the chain continues. */
  enqueue(callSid: string, fn: (entry: CallEntry) => Promise<void>): Promise<void> {
    const e = this.calls.get(callSid);
    if (!e) return Promise.resolve();
    const run = e.tail.then(() => fn(e)).catch((err: unknown) => {
      e.frames.write('log', { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    });
    e.tail = run;
    e.lastActivityMs = this.now();
    return run;
  }

  end(callSid: string): void {
    const e = this.calls.get(callSid);
    if (e) {
      e.ended = true;
      e.lastActivityMs = this.now();
    }
  }

  /** Remove sessions idle longer than the TTL. Returns the evicted call SIDs. */
  evictIdle(): string[] {
    const cutoff = this.now() - this.ttlMs;
    const gone: string[] = [];
    for (const [sid, e] of this.calls) {
      if (e.lastActivityMs < cutoff) {
        this.calls.delete(sid);
        gone.push(sid);
      }
    }
    return gone;
  }
}
