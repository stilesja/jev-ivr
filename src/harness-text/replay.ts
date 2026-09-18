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

/**
 * Feed every inbound message of a recorded call through runTurn, in order, exactly as the
 * adapter did: prompts are forced final, a repeated setup (reconnect) is skipped, and `#`/`*`
 * DTMF digits are skipped since the adapter logs them as `in` before dropping them.
 */
export async function replayFrameLog(path: string, opts: RunOptions, onRun?: (run: TurnRun) => void): Promise<ReplayResult> {
  const lines = readFrameLog(path);
  const runs: TurnRun[] = [];
  const skipped: string[] = [];
  let session: Session | null = null;
  for (const [i, line] of lines.entries()) {
    if (line.dir !== 'in') continue;
    const frame = parseInbound(JSON.stringify(line.msg));
    if (!frame) {
      skipped.push(`line ${i + 1}: unrecognized message`);
      continue;
    }
    if (frame.type === 'setup') {
      if (session) {
        skipped.push(`line ${i + 1}: setup for ${frame.callSid} after the session started`);
        continue;
      }
      session = newSession(frame.callSid, (opts.now ?? Date.now)());
    }
    if (!session) {
      skipped.push(`line ${i + 1}: ${frame.type} before setup`);
      continue;
    }
    // The adapter logs every inbound frame before deciding to ignore it; `#`/`*` digits are
    // dropped there without ever reaching runTurn, so replay must drop them too.
    if (frame.type === 'dtmf' && (frame.digit === '#' || frame.digit === '*')) continue;
    const event = frame.type === 'prompt' ? { ...frame, last: true } : frame;
    const run = await runTurn(session, event, opts);
    session = run.result.session;
    runs.push(run);
    onRun?.(run);
  }
  return { runs, records: runs.map((r) => r.record), skipped };
}
