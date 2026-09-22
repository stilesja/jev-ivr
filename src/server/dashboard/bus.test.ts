import { describe, expect, it, vi } from 'vitest';
import { DashboardBus, type PublishedEvent } from './bus';
import { maskNumber, type DashboardEvent, type DashboardEventType } from './events';

const started = (callSid: string, at = 1): DashboardEvent => ({ type: 'call_started', callSid, at, from: '…2926', todayIso: '2026-09-21', thresholds: {} });
const dtmf = (callSid: string, digit: string, at = 2): DashboardEvent => ({ type: 'dtmf', callSid, at, digit });

describe('DashboardBus', () => {
  it('fans out to subscribers and numbers events', () => {
    const bus = new DashboardBus();
    const a = vi.fn(); const b = vi.fn();
    bus.subscribe(a); bus.subscribe(b);
    bus.publish(started('CA1'));
    bus.publish(dtmf('CA1', '1'));
    expect(a).toHaveBeenCalledTimes(2);
    expect(b.mock.calls.map((c) => c[0].seq)).toEqual([1, 2]);
  });

  it('replays the history to a late subscriber', () => {
    const bus = new DashboardBus();
    bus.publish(started('CA1'));
    bus.publish(dtmf('CA1', '1'));
    const late = vi.fn();
    bus.subscribe(late);
    expect(late.mock.calls.map((c) => c[0].type)).toEqual(['call_started', 'dtmf']);
  });

  it('resets the history when a new call starts and ignores events for older calls', () => {
    const bus = new DashboardBus();
    bus.publish(started('CA1'));
    bus.publish(dtmf('CA1', '1'));
    bus.publish(started('CA2', 5));
    bus.publish(dtmf('CA1', '2', 6)); // a straggler from the old call
    const late = vi.fn();
    bus.subscribe(late);
    expect(late.mock.calls.map((c) => [c[0].type, c[0].callSid])).toEqual([['call_started', 'CA2']]);
  });

  it('bounds the history', () => {
    const bus = new DashboardBus(3);
    bus.publish(started('CA1'));
    for (let i = 0; i < 5; i++) bus.publish(dtmf('CA1', String(i), 10 + i));
    const late = vi.fn();
    bus.subscribe(late);
    // The call_started event is always kept, then the newest two.
    expect(late.mock.calls.map((c) => c[0].type)).toEqual(['call_started', 'dtmf', 'dtmf']);
  });

  it('subscribes a subscriber that throws on the replay, and keeps streaming to it', () => {
    const bus = new DashboardBus();
    bus.publish(started('CA1'));
    const seen: DashboardEventType[] = [];
    let thrown = 0;
    const brittle = (e: PublishedEvent) => {
      seen.push(e.type);
      if (e.type === 'call_started') { thrown += 1; throw new Error('the page blew up on the history'); }
    };
    // The throw must neither escape `subscribe` nor cost the subscriber its place in the set.
    expect(() => bus.subscribe(brittle)).not.toThrow();
    expect(bus.size()).toBe(1);
    bus.publish(dtmf('CA1', '1'));
    expect(thrown).toBe(1);
    expect(seen).toEqual(['call_started', 'dtmf']);
  });

  it('unsubscribes', () => {
    const bus = new DashboardBus();
    const a = vi.fn();
    const off = bus.subscribe(a);
    off();
    bus.publish(started('CA1'));
    expect(a).not.toHaveBeenCalled();
  });
});

describe('maskNumber', () => {
  it('keeps the last four digits', () => {
    expect(maskNumber('+18595222926')).toBe('…2926');
    expect(maskNumber(undefined)).toBe('unknown');
    expect(maskNumber('123')).toBe('…123');
  });
});
