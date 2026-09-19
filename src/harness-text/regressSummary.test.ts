import { describe, expect, it } from 'vitest';
import { formatRegressSummary, type RegressSummaryInput } from './regressSummary';
import type { TraceRecord } from '../trace/types';
import { CASSETTE_MISS } from '../jev/cassette';

type Row = Pick<TraceRecord, 'source' | 'timing' | 'usage' | 'error'>;

function row(source: TraceRecord['source'], askMs: number, inputTokens: number, error: TraceRecord['error'] = null, estimated = false): Row {
  return {
    source,
    error,
    timing: { planMs: 0, askMs, resolveMs: 0, totalMs: askMs },
    usage: { inputTokens, outputTokens: 0, estimated, costUsd: (inputTokens * 0.042) / 1_000_000 },
  };
}

const counts = { corpusTotal: 154, corpusMatching: 148, scenarioTotal: 35, scenarioPassing: 33, scenarioMatching: 31 };

function summary(input: Partial<RegressSummaryInput>): string {
  return formatRegressSummary({ ...counts, records: [], ...input });
}

describe('formatRegressSummary', () => {
  it('prints the two count lines for the stub and no cost line', () => {
    const text = summary({ records: [row('stub:fixture', 1, 500, null, true)] });
    expect(text).toContain('corpus     148/154 outcomes match expected');
    expect(text).toContain('scenarios   33/35 pass expectation,  31/35 match expected');
    expect(text).not.toContain('cost usd');
    expect(text).toContain('ask latency ms p50 1.0  p95 1.0');
  });

  it('prints cost with request and token counts for a live run', () => {
    const text = summary({
      records: [
        row('jev', 500, 1_000_000),
        row('jev', 700, 200_000),
        row('none', 0, 500_000),
        row('error', 0, 300_000, { name: 'JevClientError', message: 'injected timeout' }),
      ],
    });
    expect(text).toContain('cost usd   0.0504  (2 requests, 1,200,000 input tokens)');
    expect(text).not.toMatch(/\[(replayed|mixed)\]/);
    expect(text).toContain('ask latency ms p50 500.0  p95 700.0');
  });

  it('tags an all-recorded run as replayed and a mix as mixed', () => {
    const replayed = summary({ records: [row('recorded', 1, 10), row('recorded', 1, 10)] });
    expect(replayed).toMatch(/cost usd.*\[replayed\]$/m);
    expect(replayed).toMatch(/ask latency ms.*\[replayed\]$/m);
    const mixed = summary({ records: [row('recorded', 1, 10), row('jev', 1, 10)] });
    expect(mixed).toMatch(/cost usd.*\[mixed\]$/m);
    expect(mixed).toMatch(/ask latency ms.*\[mixed\]$/m);
  });

  it('counts cassette misses and omits the line at zero', () => {
    const miss = row('error', 0, 0, { name: 'JevClientError', message: `${CASSETTE_MISS} abc hello` });
    const other = row('error', 0, 0, { name: 'JevClientError', message: 'injected timeout' });
    expect(summary({ records: [miss, miss, other] })).toContain('cassette misses 2');
    expect(summary({ records: [other] })).not.toContain('cassette misses');
  });

  it('reports zero latency and no cost line when nothing was answered', () => {
    const text = summary({ records: [row('none', 0, 0)] });
    expect(text).not.toContain('cost usd');
    expect(text).not.toMatch(/\[(replayed|mixed)\]/);
    expect(text).toContain('ask latency ms p50 0.0  p95 0.0');
  });
});
