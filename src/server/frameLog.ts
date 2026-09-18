import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type FrameDir = 'in' | 'out' | 'http' | 'log';

export interface FrameLogLine {
  ts: string;
  dir: FrameDir;
  msg: unknown;
  /** 1-based line number in the log file, so a skip report can point back at the source line. Not written by FrameLog.write; only readFrameLog populates it. */
  line?: number;
}

/** Every socket message and webhook for one call, in arrival order. This is what replay consumes. */
export class FrameLog {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(dir: FrameDir, msg: unknown): void {
    const line: FrameLogLine = { ts: new Date(this.now()).toISOString(), dir, msg };
    appendFileSync(this.path, JSON.stringify(line) + '\n');
  }
}

export function readFrameLog(path: string, onSkip?: (lineNumber: number) => void): FrameLogLine[] {
  const lines: FrameLogLine[] = [];
  const raw = readFileSync(path, 'utf8').split('\n');
  raw.forEach((l, i) => {
    if (!l.trim()) return;
    const lineNumber = i + 1;
    try {
      const parsed = JSON.parse(l) as FrameLogLine;
      lines.push({ ...parsed, line: lineNumber });
    } catch {
      onSkip?.(lineNumber);
    }
  });
  return lines;
}
