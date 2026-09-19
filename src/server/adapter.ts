import type { InboundFrame, OutboundFrame } from '../channel/frames';
import { endFrame, textFrame } from '../channel/frames';
import { parseInbound, serializeOutbound } from '../channel/wire';
import { runTurn } from '../run/turn';
import type { CallEntry, SessionStore, SocketLike } from './sessions';
import type { CallTokens } from './tokens';

/** Spoken when a turn throws, so a failure is a retry rather than dead air. */
export const TURN_ERROR_TEXT = 'Sorry, something went wrong on my end. Please say that again.';

/**
 * How long one outbound frame may sit in the socket's write queue before the send is abandoned.
 * `ws` only invokes the write callback when the frame is actually flushed, so a peer that stops
 * reading (a half-open TCP connection Twilio never closes) would otherwise park a turn forever
 * and, with it, everything queued behind it for that call.
 */
export const SEND_TIMEOUT_MS = 5_000;

/** Unparsable messages (cumulative, never reset) before the connection is treated as something other than ConversationRelay. */
export const MALFORMED_LIMIT = 10;

/**
 * After sending `end`, Twilio still has to play the queued frames before it closes the socket
 * itself. If it never does (a bug on either side, or a call that never really reached Twilio),
 * this is the backstop before we close it ourselves so the connection doesn't leak forever.
 */
export const END_CLOSE_GRACE_MS = 30_000;

/** Grace timers armed after `end`, keyed by call SID, so the socket's close event can cancel the backstop. */
const endGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Digit runs long enough that TTS would read them as a number ("4471" as "four thousand ..."). */
// Runs of four or more digits are spelled out for TTS. A four-digit year would be spelled out too; no prompt speaks one today.
const DIGIT_RUN = /\d{4,}(?: \d{4,})*/g;

/**
 * Rewrite long digit runs so Twilio's TTS reads them one digit at a time. "Member ID 4471 8293."
 * becomes "Member ID 4 4 7 1, 8 2 9 3." - the comma is a short pause between the groups the
 * caller sees on their card. Only what goes on the wire is rewritten; the session text, the
 * trace record and the prompt manifest keep the readable form.
 */
export function spokenDigits(text: string): string {
  return text.replace(DIGIT_RUN, (run) =>
    run
      .split(' ')
      .map((group) => [...group].join(' '))
      .join(', '),
  );
}

export interface ConnectionContext {
  token: string | null;
  /** The socket this connection owns, so a late close cannot detach a socket a reconnect installed. */
  socket: SocketLike | null;
  callSid: string | null;
  malformed: number;
  /** Partial prompts are dropped silently after the first; one log line per connection is the signal. */
  partialLogged: boolean;
}

export interface AdapterDeps {
  store: SessionStore;
  tokens: CallTokens;
  log: (line: string) => void;
  /** Overridable so a test can prove the timeout fires without waiting five seconds. */
  sendTimeoutMs?: number;
  /** Overridable so a test can prove the end-close backstop fires without waiting 30 seconds. */
  endCloseGraceMs?: number;
}

export function newConnectionContext(token: string | null, socket: SocketLike | null = null): ConnectionContext {
  return { token, socket, callSid: null, malformed: 0, partialLogged: false };
}

function describe(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  return { name: 'NonError', message: String(err) };
}

function sendOne(socket: SocketLike, frame: OutboundFrame, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('send timeout'));
    }, timeoutMs);
    timer.unref?.();
    socket.send(serializeOutbound(frame), (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Send a decision's frames in order. A frame is logged `out` only once it is actually on the
 * wire; a frame with no socket is logged as dropped. A send failure detaches the socket and the
 * remaining frames of the decision are dropped, but the caller still runs its end-of-call work.
 */
async function sendFrames(deps: AdapterDeps, entry: CallEntry, frames: OutboundFrame[]): Promise<void> {
  const log = deps.log;
  const timeoutMs = deps.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  for (const original of frames) {
    // The frame log records what actually went out, digit spacing and all.
    const frame: OutboundFrame = original.type === 'text' ? { ...original, token: spokenDigits(original.token) } : original;
    const socket = entry.socket;
    if (!socket) {
      log(`${entry.callSid}: no socket, dropped ${frame.type}`);
      entry.frames.write('log', { dropped: frame });
      continue;
    }
    try {
      await sendOne(socket, frame, timeoutMs);
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
    await sendFrames(deps, entry, run.result.frames);
  } catch (err) {
    const info = describe(err);
    deps.log(`${entry.callSid}: turn failed: ${info.name}: ${info.message}`);
    entry.frames.write('log', { turnFailed: info });
    await sendFrames(deps, entry, [textFrame(TURN_ERROR_TEXT, true)]);
  } finally {
    // Runs even when sending the decision failed: the call is over either way.
    if (ending) {
      deps.store.end(entry.callSid);
      deps.tokens.revoke(entry.callSid);
      // Twilio closes the socket after it has played the queued frames and processed `end`;
      // closing here drops the completion (live call, error 64105).
      const socket = entry.socket;
      if (socket) {
        const graceMs = deps.endCloseGraceMs ?? END_CLOSE_GRACE_MS;
        const timer = setTimeout(() => {
          endGraceTimers.delete(entry.callSid);
          if (entry.socket === socket) {
            deps.log(`${entry.callSid}: Twilio did not close after end within ${graceMs} ms, closing`);
            socket.close(1000, 'end grace elapsed');
          }
        }, graceMs);
        timer.unref?.();
        endGraceTimers.set(entry.callSid, timer);
      }
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
    // Whatever is on the other end is not ConversationRelay; stop paying for its messages.
    if (ctx.malformed >= MALFORMED_LIMIT) {
      if (ctx.malformed === MALFORMED_LIMIT) deps.log(`${ctx.callSid ?? 'unknown'}: closing after ${ctx.malformed} malformed messages`);
      entry?.frames.write('log', { malformedLimit: ctx.malformed });
      socket.close(1007, 'malformed messages');
    }
    return;
  }

  if (frame.type === 'setup') {
    if (!ctx.token || !deps.tokens.verify(ctx.token, frame.callSid)) {
      deps.log(`${frame.callSid}: setup refused, bad token`);
      await sendOne(socket, endFrame('unauthorized'), deps.sendTimeoutMs ?? SEND_TIMEOUT_MS).catch(() => undefined);
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
        if (e.session.lastPromptText) await sendFrames(deps, e, [textFrame(e.session.lastPromptText, true)]);
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
  // TwiML has partialPrompts off, so a non-final prompt is not something the core was built to
  // score: treating one as the complete utterance would run a turn on half a sentence and then
  // run another on the whole of it. Record it and wait for the final.
  if (frame.type === 'prompt' && !frame.last) {
    entry.frames.write('log', { droppedPartial: frame.voicePrompt.slice(0, 80) });
    if (!ctx.partialLogged) {
      ctx.partialLogged = true;
      deps.log(`${ctx.callSid}: dropped a non-final prompt; partial prompts are off in the TwiML`);
    }
    return;
  }
  await deps.store.enqueue(ctx.callSid, (e) => turn(deps, e, frame));
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
  const timer = endGraceTimers.get(ctx.callSid);
  if (timer) {
    clearTimeout(timer);
    endGraceTimers.delete(ctx.callSid);
  }
  entry.frames.write('log', { socketClosed: true, ended: entry.ended });
  deps.store.detach(ctx.callSid);
}
