import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardBus } from './bus';
import { handleDashboardRequest } from './routes';

function serve(bus: DashboardBus, traceDir: string) {
  const server = createServer((req, res) => {
    const handled = handleDashboardRequest(req, res, { bus, traceDir, enabled: true });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  return new Promise<{ base: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

describe('dashboard routes', () => {
  it('serves the page and the view module with no-store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const s = await serve(new DashboardBus(), dir);
    const page = await fetch(`${s.base}/dashboard`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const js = await fetch(`${s.base}/dashboard/view.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(js.headers.get('cache-control')).toBe('no-store');
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams history then live events over SSE', async () => {
    const bus = new DashboardBus();
    bus.publish({ type: 'call_started', callSid: 'CA1', at: 1, from: '…2926', todayIso: '2026-09-21', thresholds: {} });
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const s = await serve(bus, dir);
    const res = await fetch(`${s.base}/dashboard/events`);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readUntil = async (n: number) => { while ((buf.match(/\ndata: /g) ?? []).length < n) buf += dec.decode((await reader.read()).value); };
    await readUntil(1);
    bus.publish({ type: 'dtmf', callSid: 'CA1', at: 2, digit: '1' });
    await readUntil(2);
    const events = buf.split('\n\n').filter((b) => b.includes('data: ')).map((b) => JSON.parse(b.split('data: ')[1]!) as { type: string });
    expect(events.map((e) => e.type)).toEqual(['call_started', 'dtmf']);
    expect(buf).toMatch(/^id: 1\n/m);
    await reader.cancel();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists traces and returns one with its frames; refuses a bad sid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const rec = { v: 1, sessionId: 'CA9', turnIndex: 0, ts: '2026-09-21T00:00:00.000Z', event: { type: 'setup', from: '+15550002926', to: '+15550000002' }, decision: { kind: 'prompt', promptId: 'greeting', vars: {}, acks: [] }, slots: {}, form: null, gates: [], frames: [], timing: {}, usage: {} };
    writeFileSync(join(dir, 'CA9.jsonl'), JSON.stringify(rec) + '\n');
    writeFileSync(join(dir, 'CA9.frames.jsonl'), JSON.stringify({ ts: '2026-09-21T00:00:00.000Z', dir: 'in', msg: { type: 'setup', callSid: 'CA9', from: '+15550002926', to: '+15550000002' } }) + '\n');
    const s = await serve(new DashboardBus(), dir);
    const list = await (await fetch(`${s.base}/dashboard/traces`)).json();
    expect(list).toEqual([{ callSid: 'CA9', startedAt: '2026-09-21T00:00:00.000Z', turns: 1, sizeBytes: expect.any(Number) }]);
    const one = await (await fetch(`${s.base}/dashboard/traces/CA9`)).json() as {
      records: { event: { from?: string; to?: string }; spokenText: string }[];
      frames: { msg: { from?: string } }[];
    };
    expect(one.records).toHaveLength(1);
    expect(one.frames).toHaveLength(1);
    // The route is unauthenticated, so neither the setup record nor the raw setup frame may carry
    // the caller's whole number, and the page never has to render a decision itself.
    expect(one.records[0]!.event).toMatchObject({ from: '…2926', to: '…0002' });
    expect(one.frames[0]!.msg).toMatchObject({ from: '…2926' });
    expect(one.records[0]!.spokenText).toMatch(/\S/);
    expect((await fetch(`${s.base}/dashboard/traces/..%2Fetc`)).status).toBe(404);
    expect((await fetch(`${s.base}/dashboard/traces/CA404`)).status).toBe(404);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives a record whose decision cannot render an empty spokenText', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const rec = { v: 1, sessionId: 'CA8', turnIndex: 1, ts: '2026-09-21T00:00:00.000Z', event: { type: 'prompt' }, decision: { kind: 'prompt', promptId: 'no-such-prompt-id', vars: {}, acks: [] } };
    writeFileSync(join(dir, 'CA8.jsonl'), JSON.stringify(rec) + '\n');
    const s = await serve(new DashboardBus(), dir);
    const one = await (await fetch(`${s.base}/dashboard/traces/CA8`)).json() as { records: { spokenText: string }[] };
    expect(one.records[0]!.spokenText).toBe('');
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is not handled when disabled', async () => {
    const server = createServer((req, res) => {
      const handled = handleDashboardRequest(req, res, { bus: new DashboardBus(), traceDir: tmpdir(), enabled: false });
      res.writeHead(handled ? 200 : 404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    expect((await fetch(`http://127.0.0.1:${port}/dashboard`)).status).toBe(404);
    server.close();
  });
});
