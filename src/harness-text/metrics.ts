import type { TraceRecord } from '../trace/types';
import baseline from '../domain/dtmf-baseline.json';

export interface Completion {
  sessionId: string;
  form: string;
  turns: number;
  baseline: number;
}

export interface Metrics {
  sessions: number;
  turns: number;
  promptTurns: number;
  slotsFilledPerUtterance: number;
  completions: Completion[];
  latency: { p50: number; p95: number };
  costUsd: number;
  costPerSessionUsd: number;
  byDecidingGate: Record<string, number>;
  bySource: Record<string, number>;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function filledCount(slots: TraceRecord['slots']): number {
  return Object.values(slots).filter((s) => s.value !== null).length;
}

export function summarize(records: TraceRecord[]): Metrics {
  const bySession = new Map<string, TraceRecord[]>();
  for (const r of records) {
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }

  let promptTurns = 0;
  let slotsFilled = 0;
  const completions: Completion[] = [];
  const latencies: number[] = [];
  const byDecidingGate: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let costUsd = 0;

  for (const [sessionId, list] of bySession) {
    let prevFilled = 0;
    let form: string | null = null;
    let completionTurns: number | null = null;
    for (const r of list) {
      costUsd += r.usage.costUsd;
      bySource[r.source] = (bySource[r.source] ?? 0) + 1;
      // ignore/hold decisions neither advance the flow nor were meant to fill a slot;
      // their cost and source are still counted above, but they don't count as turns.
      const counted = r.decision.kind !== 'ignore' && r.decision.kind !== 'hold';
      if (r.event.type === 'prompt') {
        if (counted) {
          promptTurns += 1;
          const now = filledCount(r.slots);
          slotsFilled += Math.max(0, now - prevFilled);
          prevFilled = now;
          if (r.source !== 'error' && r.source !== 'none') latencies.push(r.timing.totalMs);
          const gate = r.gates.find((g) => g.decided)?.gate ?? 'none';
          byDecidingGate[gate] = (byDecidingGate[gate] ?? 0) + 1;
        }
      } else {
        // setup and dtmf turns are not caller utterances: they only re-baseline the
        // slot count, so a seeded session's placeholders are never credited to a turn.
        prevFilled = filledCount(r.slots);
      }
      if (r.decision.kind === 'complete') {
        form = r.decision.form;
        // bookkeep() already excludes ignore/hold from turnIndex, and the setup
        // greeting is turn 1, so turnIndex - 1 is the caller's turn count.
        completionTurns = r.turnIndex - 1;
      }
    }
    // A session whose very first record already has a form was seeded mid-call by the
    // corpus runner, so it is not a whole call to compare against the DTMF baseline.
    const preSeeded = list.length > 0 && list[0]!.form !== null;
    if (form && completionTurns !== null && !preSeeded) {
      completions.push({ sessionId, form, turns: completionTurns, baseline: (baseline as Record<string, number>)[form] ?? 0 });
    }
  }

  return {
    sessions: bySession.size,
    turns: records.length,
    promptTurns,
    slotsFilledPerUtterance: promptTurns ? slotsFilled / promptTurns : 0,
    completions,
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    costUsd,
    costPerSessionUsd: bySession.size ? costUsd / bySession.size : 0,
    byDecidingGate,
    bySource,
  };
}
