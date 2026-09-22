import type { DashboardEvent } from './events';

/** An event as it leaves the bus: numbered, so the SSE stream has an `id` and a page can tell gaps. */
export type PublishedEvent = DashboardEvent & { seq: number };

export type Subscriber = (event: PublishedEvent) => void;

/**
 * Fans dashboard events out to subscribers and keeps the current call's history so a page
 * opened mid-call catches up. Follows the most recent call: a `call_started` for a new CallSid
 * drops the previous history, and later events for an older call are ignored.
 */
export class DashboardBus {
  private history: PublishedEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private callSid: string | null = null;
  private seq = 0;

  constructor(private readonly maxHistory = 2000) {}

  /**
   * One delivery to one subscriber. A watcher of a call can never change the call, so a throw is
   * swallowed here rather than in each caller: both the live fan-out and the history replay go
   * through this, which is what keeps a subscriber that throws on an old event from being refused
   * the new ones.
   */
  private deliver(fn: Subscriber, event: PublishedEvent): void {
    try { fn(event); } catch { /* a broken subscriber never breaks a call */ }
  }

  publish(event: DashboardEvent): void {
    if (event.type === 'call_started') {
      this.callSid = event.callSid;
      this.history = [];
    } else if (event.callSid !== this.callSid) {
      return;
    }
    // `seq` is globally monotonic, not per call: it is the SSE id, and a page that reconnects
    // across a call boundary must never be handed an id it has already seen.
    const numbered: PublishedEvent = { ...event, seq: ++this.seq };
    this.history.push(numbered);
    if (this.history.length > this.maxHistory) {
      // Keep call_started at index 0, drop the oldest of the rest.
      this.history.splice(1, this.history.length - this.maxHistory);
    }
    for (const s of this.subscribers) this.deliver(s, numbered);
  }

  /** Replays the history, then streams. Returns the unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    for (const e of this.history) this.deliver(fn, e);
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  current(): string | null { return this.callSid; }
  size(): number { return this.subscribers.size; }
}
