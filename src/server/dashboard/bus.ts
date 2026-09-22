import type { DashboardEvent } from './events';

export type Subscriber = (event: DashboardEvent) => void;

/**
 * Fans dashboard events out to subscribers and keeps the current call's history so a page
 * opened mid-call catches up. Follows the most recent call: a `call_started` for a new CallSid
 * drops the previous history, and later events for an older call are ignored.
 */
export class DashboardBus {
  private history: DashboardEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private callSid: string | null = null;
  private seq = 0;

  constructor(private readonly maxHistory = 2000) {}

  publish(event: DashboardEvent): void {
    if (event.type === 'call_started') {
      this.callSid = event.callSid;
      this.history = [];
    } else if (event.callSid !== this.callSid) {
      return;
    }
    const numbered = { ...event, seq: ++this.seq };
    this.history.push(numbered);
    if (this.history.length > this.maxHistory) {
      // Keep call_started at index 0, drop the oldest of the rest.
      this.history.splice(1, this.history.length - this.maxHistory);
    }
    for (const s of this.subscribers) {
      try { s(numbered); } catch { /* a broken subscriber never breaks a call */ }
    }
  }

  /** Replays the history, then streams. Returns the unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    for (const e of this.history) fn(e);
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  current(): string | null { return this.callSid; }
  size(): number { return this.subscribers.size; }
}
