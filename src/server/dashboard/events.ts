import type { QuestionMap } from '../../jev/types';
import type { TurnState } from '../../core/state';
import type { TraceRecord } from '../../trace/types';
import type { Thresholds } from '../../core/thresholds';
import type { FrameLogLine } from '../frameLog';

interface Base { callSid: string; at: number }

export type DashboardEvent =
  | (Base & { type: 'call_started'; from: string; todayIso: string; thresholds: Partial<Thresholds> })
  /**
   * `turnIndex` is the index the record of the turn now starting will carry -- except on a turn
   * that resolves to ignore or hold, where `bookkeep` does not increment the session's counter and
   * this is therefore one ahead of the `turn` event that follows. Pair an `asked` with its `turn`
   * by arrival order (the bus preserves it), never by index.
   */
  | (Base & { type: 'asked'; turnIndex: number; questions: QuestionMap; turnState: TurnState })
  /**
   * `spoken` is the line the caller heard on this turn, as the observer renders it live. The
   * replay route (routes.ts) computes the same string from the trace record and calls it
   * `spokenText` there instead (see `ReplayRecord`), since a stored record has no `spoken` field
   * of its own.
   */
  | (Base & { type: 'turn'; record: TraceRecord; spoken: string })
  | (Base & { type: 'silence'; promptId: string | null })
  | (Base & { type: 'dtmf'; digit: string })
  | (Base & { type: 'interrupt'; utteranceUntilInterrupt: string | null })
  | (Base & { type: 'reconnect'; attempt: number })
  | (Base & { type: 'handoff'; reason: string; number: string })
  | (Base & { type: 'ended'; reason: 'completed' | 'hangup' | 'handoff' | 'error' });

export type DashboardEventType = DashboardEvent['type'];

/** The last four digits only; the page never shows a whole caller number. */
export function maskNumber(n: string | undefined | null): string {
  if (!n) return 'unknown';
  const digits = n.replace(/\D/g, '');
  return `…${digits.slice(-4)}`;
}

/**
 * Caller identity travels under a handful of names that Twilio spells differently per surface --
 * `from`/`to` on the setup frame, `From`/`To`/`Caller`/`Called` on the `/cr-action` form post --
 * and the dashboard route is unauthenticated, so redaction works by key name on any object rather
 * than by frame type. These are matched case-insensitively.
 */
const MASK_KEYS = new Set(['from', 'to', 'caller', 'called', 'forwardedfrom']);
/** Masked to a fixed string rather than to digits: a name has nothing worth keeping. */
const NAME_KEYS = new Set(['callername']);
/** Dropped outright; the account id identifies the Twilio account, not the call. */
const DROP_KEYS = new Set(['accountsid']);
/** `FromCity`, `CallerState`, `ToZip`, `CalledCountry`, ... -- the geo lookup Twilio attaches. */
const DROP_SUFFIXES = ['city', 'state', 'zip', 'country'];
/** Real frames and form posts are shallow; the bound is only there so a cycle cannot hang a request. */
const MAX_DEPTH = 6;

/**
 * Walks `value` and returns a structurally identical copy with the caller-identity keys masked or
 * dropped at every level. Every other key, and every non-object value, is passed through unchanged.
 */
function redactDeep(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const k = key.toLowerCase();
    if (DROP_KEYS.has(k) || DROP_SUFFIXES.some((s) => k.endsWith(s))) continue;
    if (typeof v === 'string' && NAME_KEYS.has(k)) out[key] = 'redacted';
    else if (typeof v === 'string' && MASK_KEYS.has(k)) out[key] = maskNumber(v);
    else out[key] = redactDeep(v, depth + 1);
  }
  return out;
}

/**
 * The dashboard route is unauthenticated, and a first turn's event is the raw setup frame with the
 * caller's whole number, city and account id. Only `event` is walked: it is the one inbound part of
 * the record, `frames` are outbound, and `turnState` both carries no numbers and would itself trip
 * the `State` suffix rule.
 */
export function redactRecord(record: TraceRecord): TraceRecord {
  return { ...record, event: redactDeep(record.event) as TraceRecord['event'] };
}

/**
 * The frame-log counterpart of {@link redactRecord}, for `/dashboard/traces/<sid>`'s raw frame
 * lines. Applied to every line whatever its `dir`: the `/cr-action` form post that `http.ts` logs
 * carries no `type` and spells the caller's number four different ways.
 */
export function redactFrameLine(line: FrameLogLine): FrameLogLine {
  return { ...line, msg: redactDeep(line.msg) };
}
