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

function percentile(values: number[], p: number): number {
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
    let callerTurns = 0;
    let inDtmfRun = false;
    let form: string | null = null;
    for (const r of list) {
      costUsd += r.usage.costUsd;
      bySource[r.source] = (bySource[r.source] ?? 0) + 1;
      if (r.event.type === 'prompt') {
        promptTurns += 1;
        callerTurns += 1;
        inDtmfRun = false;
        const now = filledCount(r.slots);
        slotsFilled += Math.max(0, now - prevFilled);
        prevFilled = now;
        if (r.source !== 'error' && r.source !== 'none') latencies.push(r.timing.askMs);
        const gate = r.gates.find((g) => g.decided)?.gate ?? 'none';
        byDecidingGate[gate] = (byDecidingGate[gate] ?? 0) + 1;
      } else if (r.event.type === 'dtmf') {
        if (!inDtmfRun) callerTurns += 1;
        inDtmfRun = true;
        prevFilled = filledCount(r.slots);
      }
      if (r.decision.kind === 'complete') form = r.decision.form;
    }
    if (form) {
      completions.push({ sessionId, form, turns: callerTurns, baseline: (baseline as Record<string, number>)[form] ?? 0 });
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
