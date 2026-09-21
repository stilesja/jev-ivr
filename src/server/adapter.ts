import type { InboundFrame, OutboundFrame } from '../channel/frames';
import { endFrame, silenceFrame, textFrame } from '../channel/frames';
import { parseInbound, serializeOutbound } from '../channel/wire';
import { playbackEstimateMs } from '../prompts/playback';
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

/**
 * The armed no-input timer for a call, with the generation it was armed under.
 *
 * Both this and the generation counter live here rather than on `CallEntry`, the way
 * `endGraceTimers` does: the timer is the adapter's business, so `sessions.ts` stays a store.
 */
interface NoInput {
  timer: ReturnType<typeof setTimeout>;
  generation: number;
}
const noInputTimers = new Map<string, NoInput>();
/**
 * Bumped every time a call's no-input timer is cleared or re-armed. A fired timer's queued
 * closure carries the generation it was armed with, so a turn that got in first (the caller
 * answered at the last second) turns the queued silence turn into a no-op.
 *
 * It outlives a socket close on purpose, so a reconnect cannot hand an already-queued closure a
 * generation it would match again. Only `forgetNoInput` drops it, once the call itself is gone.
 */
const noInputGeneration = new Map<string, number>();

/** When a call's last frames went out and how long they were estimated to take to play. */
interface Playback {
  sentAtMs: number;
  estimateMs: number;
}
/**
 * So a re-arm that speaks nothing of its own still waits for the prompt already playing to
 * finish. A barge-in one second into an eleven second menu clip would otherwise restart a bare
 * `noInputMs` and fire a silence turn over the top of the menu.
 */
const lastPlayback = new Map<string, Playback>();

/** Consecutive turns that threw, per call, reset by any turn that produces a decision. */
const turnFailures = new Map<string, number>();

/**
 * Thrown turns in a row before the no-input wait stops re-arming. Each one speaks the apology and
 * the wait asks the question again, so a client that is down would otherwise loop for the life of
 * the call; three attempts is enough to ride out a blip.
 */
export const TURN_FAILURE_LIMIT = 3;

/** Cancel any armed no-input timer for a call and invalidate whatever it already queued. */
function clearNoInput(callSid: string): void {
  const armed = noInputTimers.get(callSid);
  if (armed) {
    clearTimeout(armed.timer);
    noInputTimers.delete(callSid);
  }
  noInputGeneration.set(callSid, (noInputGeneration.get(callSid) ?? 0) + 1);
}

/**
 * Drop a gone call's no-input bookkeeping entirely, so neither map outlives the call. Called from
 * the socket close of a call the store no longer has, and from the idle sweep for one whose socket
 * had already gone; both maps would otherwise grow by an entry per call for the process's life.
 */
export function forgetNoInput(callSid: string): void {
  const armed = noInputTimers.get(callSid);
  if (armed) clearTimeout(armed.timer);
  noInputTimers.delete(callSid);
  noInputGeneration.delete(callSid);
  lastPlayback.delete(callSid);
  turnFailures.delete(callSid);
}

/**
 * Arm the no-input timer: `noInputMs` after the frames have (approximately) finished playing.
 * When it fires the silence turn goes through the same per-call queue as a socket message, so it
 * can never interleave with a real turn.
 *
 * `frames` is what actually went out. An empty list means the caller was heard from but nothing
 * was said back (a barge-in, a keypad terminator, a partial), so the wait is measured from the
 * end of whatever is still playing rather than from now.
 */
function armNoInput(deps: AdapterDeps, entry: CallEntry, frames: readonly OutboundFrame[]): void {
  const wait = deps.noInputMs ?? 0;
  if (wait <= 0) return;
  clearNoInput(entry.callSid);
  const generation = noInputGeneration.get(entry.callSid) ?? 0;
  const nowMs = Date.now();
  let remainingMs: number;
  if (frames.length > 0) {
    const estimateMs = playbackEstimateMs(frames, deps.clipDurations ?? new Map());
    lastPlayback.set(entry.callSid, { sentAtMs: nowMs, estimateMs });
    remainingMs = estimateMs;
  } else {
    const last = lastPlayback.get(entry.callSid);
    remainingMs = last ? Math.max(0, last.sentAtMs + last.estimateMs - nowMs) : 0;
  }
  const delay = wait + remainingMs;
  const timer = setTimeout(() => {
    noInputTimers.delete(entry.callSid);
    void deps.store
      .enqueue(entry.callSid, async (e) => {
        // A real turn ran between the arm and now (it bumped the generation), or the call is
        // over: either way the caller is not silent and this turn has nothing to say.
        if (e.ended || (noInputGeneration.get(e.callSid) ?? 0) !== generation) return;
        e.frames.write('in', silenceFrame());
        await turn(deps, e, silenceFrame());
      })
      .catch((err: unknown) => deps.log(`${entry.callSid}: silence turn failed: ${describe(err).message}`));
  }, delay);
  timer.unref?.();
  noInputTimers.set(entry.callSid, { timer, generation });
  // Only for a re-arm that had something to say. Partials arrive several times a second while the
  // caller speaks, and a line each would drown the frame log in bookkeeping.
  if (frames.length > 0) entry.frames.write('log', { noInputArmedMs: delay });
}

/** Digit runs long enough that TTS would read them as a number ("4471" as "four thousand ..."). */
// Five or more digits, or several groups of four: an identifier, spelled out. A lone four-digit
// run is left alone -- the summary reads a date of birth back ("born March 5th, 1980"), and a
// year is exactly what TTS reads correctly on its own.
const DIGIT_RUN = /\d{4,}(?: \d{4,})+|\d{5,}/g;

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
  /** Silence after a prompt's estimated playback before a silence turn runs; 0 (the default) disables. */
  noInputMs?: number;
  /** wav filename -> ms, from clipDurations(audioDir); how long a `play` frame is assumed to take. */
  clipDurations?: ReadonlyMap<string, number>;
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
 * Send a decision's frames in order, and return the ones that actually reached the wire, rewritten
 * exactly as they were sent. A frame is logged `out` only once it is actually on the wire; a frame
 * with no socket is logged as dropped. A send failure detaches the socket and the remaining frames
 * of the decision are dropped, but the caller still runs its end-of-call work.
 *
 * The return value is what the no-input estimate is measured on: only frames Twilio received are
 * frames Twilio will spend time playing, and the digit spacing changes how long a member ID takes
 * to read out loud.
 */
async function sendFrames(deps: AdapterDeps, entry: CallEntry, frames: OutboundFrame[]): Promise<OutboundFrame[]> {
  const log = deps.log;
  const timeoutMs = deps.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  const sent: OutboundFrame[] = [];
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
      sent.push(frame);
    } catch (err) {
      const info = describe(err);
      log(`${entry.callSid}: send failed for ${frame.type}: ${info.name}: ${info.message}`);
      entry.frames.write('log', { sendFailed: frame.type, error: info });
      // The socket is unusable; drop it so the rest of this decision and later turns are logged
      // as dropped rather than failing one by one.
      if (entry.socket === socket) entry.socket = null;
    }
  }
  return sent;
}

async function turn(deps: AdapterDeps, entry: CallEntry, event: InboundFrame): Promise<void> {
  let ending = false;
  try {
    const run = await runTurn(entry.session, event, entry.opts);
    turnFailures.delete(entry.callSid);
    entry.session = run.result.session;
    const kind = run.result.decision.kind;
    ending = kind === 'complete' || kind === 'handoff';
    // Defensive: nothing can be armed here today, because whatever drove this turn cleared the
    // timer on its way in. Kept so a future path that arms and then ends cannot strand a timer.
    if (ending) clearNoInput(entry.callSid);
    const sent = await sendFrames(deps, entry, run.result.frames);
    // A prompt restarts the wait - including the silence turn's own re-ask, which is how the
    // ladder walks itself. So does anything that left the caller still owing an answer: an
    // ignored digit mid-slot, a barge-in, a relay error frame. Those produce no frames of their
    // own, so the wait is the bare `noInputMs` from the moment the frame arrived.
    if (!ending && (kind === 'prompt' || entry.session.promptedFor !== null)) armNoInput(deps, entry, sent);
  } catch (err) {
    const info = describe(err);
    deps.log(`${entry.callSid}: turn failed: ${info.name}: ${info.message}`);
    entry.frames.write('log', { turnFailed: info });
    const failures = (turnFailures.get(entry.callSid) ?? 0) + 1;
    turnFailures.set(entry.callSid, failures);
    const sent = await sendFrames(deps, entry, [textFrame(TURN_ERROR_TEXT, true)]);
    // "Please say that again" is a question like any other: a caller who then says nothing must
    // not be left listening to an open line. But the wait asking it again is what turns a client
    // that is down into an apology every few seconds until the caller hangs up, so it stops after
    // a few tries and leaves the line open rather than talking over a caller who has given up.
    if (failures >= TURN_FAILURE_LIMIT) {
      if (failures === TURN_FAILURE_LIMIT) {
        deps.log(`${entry.callSid}: ${failures} consecutive turn failures, no-input wait stopped`);
        entry.frames.write('log', { noInputStopped: failures });
      }
      clearNoInput(entry.callSid);
    } else if (entry.session.promptedFor !== null) {
      armNoInput(deps, entry, sent);
    }
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
      // The wait the old connection was counting down no longer means anything. The replay below
      // starts a fresh one; this clear is what covers a reconnect with no prompt to replay yet.
      clearNoInput(frame.callSid);
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
        if (!e.session.lastPromptText) return;
        const sent = await sendFrames(deps, e, [textFrame(e.session.lastPromptText, true)]);
        // The replay is a question the caller has to answer, so it starts a wait of its own; the
        // reconnect is not a turn, so nothing else would.
        armNoInput(deps, e, sent);
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
  // The caller is audibly there, so the no-input wait is over - before any of the early returns
  // below, because a partial prompt or a bare `#` is still a caller who is not silent.
  if (frame.type === 'prompt' || frame.type === 'dtmf' || frame.type === 'interrupt') clearNoInput(ctx.callSid);
  // The slots have fixed digit lengths, so the keypad terminators carry no meaning yet.
  if (frame.type === 'dtmf' && (frame.digit === '#' || frame.digit === '*')) {
    entry.frames.write('log', { ignoredDigit: frame.digit });
    // No turn runs, so nothing downstream would restart the wait the digit just cancelled.
    armNoInput(deps, entry, []);
    return;
  }
  // Partial prompts are on in the TwiML so the no-input wait can be cancelled at the caller's
  // first syllable, but a non-final prompt is not something the core was built to score: treating
  // one as the complete utterance would run a turn on half a sentence and then run another on the
  // whole of it. Record it, restart the wait, and hold out for the final.
  if (frame.type === 'prompt' && !frame.last) {
    entry.frames.write('log', { droppedPartial: frame.voicePrompt.slice(0, 80) });
    if (!ctx.partialLogged) {
      ctx.partialLogged = true;
      deps.log(`${ctx.callSid}: dropped a non-final prompt; partials only cancel the no-input wait`);
    }
    armNoInput(deps, entry, []);
    return;
  }
  await deps.store.enqueue(ctx.callSid, (e) => turn(deps, e, frame));
}

export async function handleSocketClose(deps: AdapterDeps, ctx: ConnectionContext): Promise<void> {
  if (!ctx.callSid) return;
  const entry = deps.store.get(ctx.callSid);
  if (!entry) {
    // The call is gone from the store, so nothing will ever consult its no-input bookkeeping again.
    forgetNoInput(ctx.callSid);
    return;
  }
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
  // Nobody is listening on the other end; a re-ask would be played to a closed socket.
  clearNoInput(ctx.callSid);
  entry.frames.write('log', { socketClosed: true, ended: entry.ended });
  deps.store.detach(ctx.callSid);
}
