import type { TraceRecord, TraceSource } from '../trace/types';
import { CASSETTE_MISS } from '../jev/cassette';

export interface RegressSummaryInput {
  corpusTotal: number;
  corpusMatching: number;
  scenarioTotal: number;
  scenarioPassing: number;
  scenarioMatching: number;
  /** every turn the run made; only answered turns count toward cost and latency */
  records: Pick<TraceRecord, 'source' | 'timing' | 'usage' | 'error'>[];
}

// Turns that never produced an answer. Inverted (rather than an allow-list of answered
// sources) so a new AnswerSource is counted in by default instead of silently dropped.
const UNANSWERED = new Set<TraceSource>(['none', 'error', 'dtmf']);

// keep in sync with metrics.ts
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

/** The block printed after a regression diff: label agreement, then cost and latency of the requests the run made. */
export function formatRegressSummary(i: RegressSummaryInput): string {
  const answered = i.records.filter((r) => !UNANSWERED.has(r.source));
  const sources = new Set(answered.map((r) => r.source));
  const tag = sources.size === 1 && sources.has('recorded') ? '   [replayed]' : sources.size > 1 ? '   [mixed]' : '';
  const lines = [
    `corpus     ${String(i.corpusMatching).padStart(3)}/${i.corpusTotal} outcomes match expected`,
    `scenarios  ${String(i.scenarioPassing).padStart(3)}/${i.scenarioTotal} pass expectation,  ${i.scenarioMatching}/${i.scenarioTotal} match expected`,
  ];
  // Estimated usage (the heuristic stub) is priced by the trace writer but isn't a real
  // cost, so it's excluded here rather than gated on the client kind.
  const priced = answered.filter((r) => !r.usage.estimated);
  if (priced.length > 0) {
    const cost = priced.reduce((s, r) => s + r.usage.costUsd, 0);
    const tokens = priced.reduce((s, r) => s + r.usage.inputTokens, 0);
    lines.push(`cost usd   ${cost.toFixed(4)}  (${priced.length} requests, ${String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} input tokens)${tag}`);
  }
  const latencies = answered.map((r) => r.timing.askMs);
  lines.push(`ask latency ms p50 ${percentile(latencies, 50).toFixed(1)}  p95 ${percentile(latencies, 95).toFixed(1)}${tag}`);
  const misses = i.records.filter((r) => r.error?.message.startsWith(CASSETTE_MISS)).length;
  if (misses > 0) lines.push(`cassette misses ${misses}`);
  return lines.join('\n');
}
