import type { InboundFrame, OutboundFrame } from '../channel/frames';
import { endFrame, textFrame } from '../channel/frames';
import { parseInbound, serializeOutbound } from '../channel/wire';
import { runTurn } from '../run/turn';
import type { CallEntry, SessionStore, SocketLike } from './sessions';
import type { CallTokens } from './tokens';

/** Spoken when a turn throws, so a failure is a retry rather than dead air. */
export const TURN_ERROR_TEXT = 'Sorry, something went wrong on my end. Please say that again.';

export interface ConnectionContext {
  token: string | null;
  /** The socket this connection owns, so a late close cannot detach a socket a reconnect installed. */
  socket: SocketLike | null;
  callSid: string | null;
  malformed: number;
}

export interface AdapterDeps {
  store: SessionStore;
  tokens: CallTokens;
  log: (line: string) => void;
}

export function newConnectionContext(token: string | null, socket: SocketLike | null = null): ConnectionContext {
  return { token, socket, callSid: null, malformed: 0 };
}

function describe(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  return { name: 'NonError', message: String(err) };
}

function sendOne(socket: SocketLike, frame: OutboundFrame): Promise<void> {
  return new Promise((resolve, reject) => socket.send(serializeOutbound(frame), (err) => (err ? reject(err) : resolve())));
}

/**
 * Send a decision's frames in order. A frame is logged `out` only once it is actually on the
 * wire; a frame with no socket is logged as dropped. A send failure detaches the socket and the
 * remaining frames of the decision are dropped, but the caller still runs its end-of-call work.
 */
async function sendFrames(entry: CallEntry, frames: OutboundFrame[], log: AdapterDeps['log']): Promise<void> {
  for (const frame of frames) {
    const socket = entry.socket;
    if (!socket) {
      log(`${entry.callSid}: no socket, dropped ${frame.type}`);
      entry.frames.write('log', { dropped: frame });
      continue;
    }
    try {
      await sendOne(socket, frame);
      entry.frames.write('out', frame);
    } catch (err) {
      const info = describe(err);
      log(`${entry.callSid}: send failed for ${frame.type}: ${info.name}: ${info.message}`);
      entry.frames.write('log', { sendFailed: frame.type, error: info });
      // The socket is unusable; drop it so the rest of this decision and later turns are logged
      // as dropped rather than failing one by one.
      if (entry.socket === socket) entry.socket = null;
    }
  }
}

async function turn(deps: AdapterDeps, entry: CallEntry, event: InboundFrame): Promise<void> {
  let ending = false;
  try {
    const run = await runTurn(entry.session, event, entry.opts);
    entry.session = run.result.session;
    const kind = run.result.decision.kind;
    ending = kind === 'complete' || kind === 'handoff';
    await sendFrames(entry, run.result.frames, deps.log);
  } catch (err) {
    const info = describe(err);
    deps.log(`${entry.callSid}: turn failed: ${info.name}: ${info.message}`);
    entry.frames.write('log', { turnFailed: info });
    await sendFrames(entry, [textFrame(TURN_ERROR_TEXT, true)], deps.log);
  } finally {
    // Runs even when sending the decision failed: the call is over either way.
    if (ending) {
      deps.store.end(entry.callSid);
      deps.tokens.revoke(entry.callSid);
      entry.socket?.close(1000, 'call ended');
    }
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
    if (existing) {
      existing.frames.write('in', frame);
      if (existing.ended) {
        deps.log(`${frame.callSid}: setup for an ended call, closing`);
        socket.close(1000, 'call ended');
        return;
      }
      const previous = existing.socket;
      if (previous && previous !== socket) {
        // Twilio reconnected before the old socket's close reached us; retire it explicitly so
        // nothing is written to two sockets for one call.
        deps.log(`${frame.callSid}: reconnect replaced a live socket`);
        existing.frames.write('log', { replacedSocket: true });
        previous.close(1000, 'replaced by reconnect');
      }
      const entry = deps.store.attach(frame.callSid, socket) ?? existing;
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
  if (!entry) {
    deps.log(`${ctx.callSid}: ${frame.type} for an unknown call, ignored`);
    return;
  }
  // Logged before any decision to ignore it: the frame log is a record of the wire, not of the
  // frames the adapter chose to act on.
  entry.frames.write('in', frame);
  if (entry.ended) {
    deps.log(`${ctx.callSid}: ${frame.type} after end, ignored`);
    return;
  }
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
  if (ctx.socket && entry.socket !== ctx.socket) {
    // A close from a socket a reconnect already replaced; the live one must stay attached.
    entry.frames.write('log', { staleSocketClosed: true });
    return;
  }
  entry.frames.write('log', { socketClosed: true, ended: entry.ended });
  deps.store.detach(ctx.callSid);
}
