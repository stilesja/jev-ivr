import type { InboundFrame, OutboundFrame } from '../channel/frames';
import { endFrame, textFrame } from '../channel/frames';
import { parseInbound, serializeOutbound } from '../channel/wire';
import { runTurn } from '../run/turn';
import type { CallEntry, SessionStore, SocketLike } from './sessions';
import type { CallTokens } from './tokens';

export interface ConnectionContext {
  token: string | null;
  callSid: string | null;
  malformed: number;
}

export interface AdapterDeps {
  store: SessionStore;
  tokens: CallTokens;
  log: (line: string) => void;
}

export function newConnectionContext(token: string | null): ConnectionContext {
  return { token, callSid: null, malformed: 0 };
}

function sendOne(socket: SocketLike, frame: OutboundFrame): Promise<void> {
  return new Promise((resolve, reject) => socket.send(serializeOutbound(frame), (err) => (err ? reject(err) : resolve())));
}

async function sendFrames(entry: CallEntry, frames: OutboundFrame[], log: AdapterDeps['log']): Promise<void> {
  for (const frame of frames) {
    entry.frames.write('out', frame);
    if (!entry.socket) {
      log(`${entry.callSid}: no socket, dropped ${frame.type}`);
      entry.frames.write('log', { dropped: frame.type });
      continue;
    }
    await sendOne(entry.socket, frame);
  }
}

async function turn(deps: AdapterDeps, entry: CallEntry, event: InboundFrame): Promise<void> {
  const run = await runTurn(entry.session, event, entry.opts);
  entry.session = run.result.session;
  await sendFrames(entry, run.result.frames, deps.log);
  const kind = run.result.decision.kind;
  if (kind === 'complete' || kind === 'handoff') {
    deps.store.end(entry.callSid);
    deps.tokens.revoke(entry.callSid);
    entry.socket?.close(1000, 'call ended');
  }
}

/** Handle one raw socket message for a connection. Safe to call concurrently; turns are serialized per call by the store. */
export async function handleSocketMessage(deps: AdapterDeps, socket: SocketLike, ctx: ConnectionContext, raw: string): Promise<void> {
  const frame = parseInbound(raw);
  if (!frame) {
    ctx.malformed += 1;
    deps.log(`${ctx.callSid ?? 'unknown'}: malformed inbound message (${ctx.malformed})`);
    const entry = ctx.callSid ? deps.store.get(ctx.callSid) : undefined;
    entry?.frames.write('log', { malformed: raw.slice(0, 200) });
    return;
  }

  if (frame.type === 'setup') {
    if (!ctx.token || !deps.tokens.verify(ctx.token, frame.callSid)) {
      deps.log(`${frame.callSid}: setup refused, bad token`);
      await sendOne(socket, endFrame('unauthorized')).catch(() => undefined);
      socket.close(1008, 'unauthorized');
      return;
    }
    ctx.callSid = frame.callSid;
    const existing = deps.store.get(frame.callSid);
    if (existing && existing.ended) {
      deps.log(`${frame.callSid}: setup for an ended call, closing`);
      socket.close(1000, 'call ended');
      return;
    }
    if (existing) {
      const entry = deps.store.attach(frame.callSid, socket)!;
      entry.frames.write('in', frame);
      entry.frames.write('log', { resumed: true, sessionId: frame.sessionId });
      await deps.store.enqueue(frame.callSid, async (e) => {
        if (e.session.lastPromptText) await sendFrames(e, [textFrame(e.session.lastPromptText, true)], deps.log);
      });
      return;
    }
    const entry = deps.store.create(frame.callSid, socket);
    entry.frames.write('in', frame);
    await deps.store.enqueue(frame.callSid, (e) => turn(deps, e, frame));
    return;
  }

  if (!ctx.callSid) {
    deps.log(`message of type ${frame.type} before setup, ignored`);
    return;
  }
  const entry = deps.store.get(ctx.callSid);
  if (!entry || entry.ended) {
    deps.log(`${ctx.callSid}: ${frame.type} after end, ignored`);
    return;
  }
  entry.frames.write('in', frame);
  // The slots have fixed digit lengths, so the keypad terminators carry no meaning yet.
  if (frame.type === 'dtmf' && (frame.digit === '#' || frame.digit === '*')) {
    entry.frames.write('log', { ignoredDigit: frame.digit });
    return;
  }
  // Finals only in this sub-project: every prompt is treated as the complete utterance.
  const event: InboundFrame = frame.type === 'prompt' ? { ...frame, last: true } : frame;
  await deps.store.enqueue(ctx.callSid, (e) => turn(deps, e, event));
}

export async function handleSocketClose(deps: AdapterDeps, ctx: ConnectionContext): Promise<void> {
  if (!ctx.callSid) return;
  const entry = deps.store.get(ctx.callSid);
  if (!entry) return;
  entry.frames.write('log', { socketClosed: true, ended: entry.ended });
  deps.store.detach(ctx.callSid);
}
