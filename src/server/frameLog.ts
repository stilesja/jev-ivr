import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type FrameDir = 'in' | 'out' | 'http' | 'log';

export interface FrameLogLine {
  ts: string;
  dir: FrameDir;
  msg: unknown;
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
  const raw = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  raw.forEach((l, i) => {
    try {
      lines.push(JSON.parse(l) as FrameLogLine);
    } catch {
      onSkip?.(i + 1);
    }
  });
  return lines;
}
