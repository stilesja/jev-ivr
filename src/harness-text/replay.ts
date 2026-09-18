import { readFrameLog } from '../server/frameLog';
import { parseInbound } from '../channel/wire';
import { newSession, type Session } from '../core/session';
import { runTurn, type RunOptions, type TurnRun } from '../run/turn';
import type { TraceRecord } from '../trace/types';

export interface ReplayResult {
  runs: TurnRun[];
  records: TraceRecord[];
  skipped: string[];
}

function rawType(msg: unknown): string {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string'
    ? (msg as { type: string }).type
    : 'message';
}

/**
 * Feed every inbound message of a recorded call through runTurn, in order, exactly as the
 * adapter did: non-final prompts are skipped, a repeated setup (reconnect) is skipped, `#`/`*` DTMF
 * digits are skipped since the adapter logs them as `in` before dropping them, and everything
 * after the call ends is skipped and reported rather than fed to a dead session. A line with a
 * missing or unparsable `ts` is skipped and reported rather than throwing or driving the clock
 * with `NaN`.
 *
 * Each turn runs with the clock and default date the recording actually happened under: `now`
 * returns the frame line's own timestamp, and `todayIso` is the setup line's date unless the
 * caller passed one in `options`.
 */
export async function replayFrameLog(
  path: string,
  opts: RunOptions,
  onRun?: (run: TurnRun) => void,
  options?: { todayIso?: string },
): Promise<ReplayResult> {
  const skipped: string[] = [];
  const lines = readFrameLog(path, (lineNumber) => skipped.push(`line ${lineNumber}: unparsable`));
  const runs: TurnRun[] = [];
  let session: Session | null = null;
  let setupDate: string | null = null;
  let ended = false;
  for (const line of lines) {
    if (line.dir !== 'in') continue;
    const lineNumber = line.line;
    const lineMs = typeof line.ts === 'string' ? Date.parse(line.ts) : NaN;
    if (Number.isNaN(lineMs)) {
      skipped.push(`line ${lineNumber}: missing or invalid ts`);
      continue;
    }
    if (ended) {
      skipped.push(`line ${lineNumber}: ${rawType(line.msg)} after the call ended`);
      continue;
    }
    const frame = parseInbound(JSON.stringify(line.msg));
    if (!frame) {
      skipped.push(`line ${lineNumber}: unrecognized message`);
      continue;
    }
    if (frame.type === 'setup') {
      if (session) {
        skipped.push(`line ${lineNumber}: setup for ${frame.callSid} after the session started`);
        continue;
      }
      setupDate = line.ts.slice(0, 10);
      session = newSession(frame.callSid, lineMs);
    }
    if (!session) {
      skipped.push(`line ${lineNumber}: ${frame.type} before setup`);
      continue;
    }
    // The adapter logs every inbound frame before deciding to ignore it; `#`/`*` digits are
    // dropped there without ever reaching runTurn, so replay must drop them too.
    if (frame.type === 'dtmf' && (frame.digit === '#' || frame.digit === '*')) continue;
    // The adapter logs a non-final prompt and waits for the final one rather than running a turn
    // on half an utterance; replaying it would invent a turn the call never had.
    if (frame.type === 'prompt' && !frame.last) {
      skipped.push(`line ${lineNumber}: non-final prompt`);
      continue;
    }
    const turnOpts: RunOptions = { ...opts, now: () => lineMs, todayIso: options?.todayIso ?? setupDate! };
    try {
      const run = await runTurn(session, frame, turnOpts);
      session = run.result.session;
      runs.push(run);
      onRun?.(run);
      if (session.ended) ended = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push(`line ${lineNumber}: turn failed: ${message}`);
    }
  }
  return { runs, records: runs.map((r) => r.record), skipped };
}
