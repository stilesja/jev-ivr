import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENDED_GRACE_MS, SessionStore, type SocketLike } from './sessions';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import { FrameLog } from './frameLog';

type Fake = SocketLike & { sent: string[]; closed: boolean; closeArgs: { code?: number; reason?: string } | null };
function fakeSocket(): Fake {
  const s: Fake = {
    sent: [] as string[], closed: false, closeArgs: null,
    send(d: string, cb?: (e?: Error) => void) { s.sent.push(d); cb?.(); },
    close(code?: number, reason?: string) { s.closed = true; s.closeArgs = { code, reason }; },
  };
  return s;
}

function store(now: () => number, ttl = 1000, maxAge = 7_200_000) {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  return new SessionStore((callSid) => ({
    session: newSession(callSid, now()),
    opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), now),
  }), ttl, now, maxAge);
}

describe('SessionStore', () => {
  it('creates, gets, detaches and attaches', () => {
    const s = store(() => 0);
    const sock = fakeSocket();
    const e = s.create('CA1', sock);
    expect(s.get('CA1')).toBe(e);
    expect(e.socket).toBe(sock);
    s.detach('CA1');
    expect(e.socket).toBeNull();
    const sock2 = fakeSocket();
    expect(s.attach('CA1', sock2)?.socket).toBe(sock2);
    expect(s.attach('CA9', sock2)).toBeUndefined();
    expect(() => s.create('CA1', sock)).toThrow(/exists/);
  });

  it('runs queued work one at a time in order and survives an error', async () => {
    const s = store(() => 0);
    s.create('CA1', fakeSocket());
    const order: string[] = [];
    const p1 = s.enqueue('CA1', async () => { await new Promise((r) => setTimeout(r, 30)); order.push('a'); });
    const p2 = s.enqueue('CA1', async () => { order.push('b'); throw new Error('boom'); });
    const p3 = s.enqueue('CA1', async () => { order.push('c'); });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(await s.enqueue('CA9', async () => {})).toBeUndefined();
  });

  it('ends and evicts idle sessions', () => {
    let t = 0;
    const s = store(() => t, 1000);
    s.create('CA1', fakeSocket());
    s.create('CA2', fakeSocket());
    s.end('CA1');
    expect(s.get('CA1')?.ended).toBe(true);
    t = 500;
    s.touch('CA2');
    t = 1200;
    expect(s.evictIdle().sort()).toEqual(['CA1']);
    t = 1600;
    expect(s.evictIdle()).toEqual(['CA2']);
    expect(s.size()).toBe(0);
  });

  it('keeps the queue alive when the frame log itself throws', async () => {
    const s = store(() => 0);
    const e = s.create('CA1', fakeSocket());
    e.frames.write = () => {
      throw new Error('disk');
    };
    let ran = false;
    const p1 = s.enqueue('CA1', async () => {
      throw new Error('boom');
    });
    const p2 = s.enqueue('CA1', async () => {
      ran = true;
    });
    await Promise.all([p1, p2]);
    expect(ran).toBe(true);
    await expect(e.tail).resolves.toBeUndefined();
  });

  it('skips queued work after end', async () => {
    const s = store(() => 0);
    s.create('CA1', fakeSocket());
    let secondRan = false;
    const p1 = s.enqueue('CA1', async () => {
      await new Promise((r) => setTimeout(r, 20));
      s.end('CA1');
    });
    const p2 = s.enqueue('CA1', async () => {
      secondRan = true;
    });
    await Promise.all([p1, p2]);
    expect(secondRan).toBe(false);
  });

  it('does not evict a session with work in flight', async () => {
    let t = 0;
    const s = store(() => t, 1000);
    s.create('CA1', fakeSocket());
    const p = s.enqueue('CA1', async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await new Promise((r) => setTimeout(r, 0));
    t = 2000;
    expect(s.evictIdle()).toEqual([]);
    await p;
    expect(s.evictIdle()).toEqual(['CA1']);
  });

  it('evicts an entry past the max age even with work in flight', async () => {
    let t = 0;
    const s = store(() => t, 1_000_000, 5000);
    const sock = fakeSocket();
    s.create('CA1', sock);
    let released!: () => void;
    const p = s.enqueue('CA1', () => new Promise<void>((r) => { released = r; }));
    await new Promise((r) => setTimeout(r, 0));
    expect(s.get('CA1')?.inFlight).toBe(1);
    // The idle TTL is far away and the turn is still running, so only the age cap can remove it.
    t = 4999;
    expect(s.evictIdle()).toEqual([]);
    t = 5000;
    expect(s.evictIdle()).toEqual(['CA1']);
    expect(sock.closeArgs).toEqual({ code: 1000, reason: 'session expired' });
    expect(s.get('CA1')).toBeUndefined();
    released();
    await p;
  });

  it('retains an ended call for the grace period, then drops it, and counts live sessions', () => {
    let t = 0;
    const s = store(() => t, 1_000_000);
    s.create('CA1', fakeSocket());
    s.create('CA2', fakeSocket());
    expect(s.liveCount()).toBe(2);
    s.end('CA1');
    expect(s.liveCount()).toBe(1);
    expect(s.size()).toBe(2);
    // A second end (the action callback after the adapter) must not restart the grace period.
    t = ENDED_GRACE_MS - 1;
    s.end('CA1');
    expect(s.evictIdle()).toEqual([]);
    t = ENDED_GRACE_MS;
    expect(s.evictIdle()).toEqual(['CA1']);
    expect(s.size()).toBe(1);
    expect(s.liveCount()).toBe(1);
  });

  it('closes a live socket on eviction', () => {
    let t = 0;
    const s = store(() => t, 1000);
    const sock = fakeSocket();
    s.create('CA1', sock);
    t = 2000;
    expect(s.evictIdle()).toEqual(['CA1']);
    expect(sock.closed).toBe(true);
  });
});
