import { describe, expect, it } from 'vitest';
import { emptyRunAll, runAll } from './runAll';
import { loadCorpus } from '../jev/corpus';
import { loadScenarios } from './runner';
import { buildClient, buildThresholds, DEFAULT_CORPUS_FILE } from '../run/client';
import { REGRESS_TODAY } from './baseline';

describe('runAll', () => {
  it('runs corpus entries then scenarios, collecting outcomes and every trace record', async () => {
    const thresholds = buildThresholds([]);
    const corpus = loadCorpus(DEFAULT_CORPUS_FILE).slice(0, 3);
    const scenarios = loadScenarios('fixtures/scenarios').slice(0, 2);
    const seen: string[] = [];
    const r = await runAll(corpus, scenarios, { client: buildClient('stub', DEFAULT_CORPUS_FILE, thresholds), thresholds, todayIso: REGRESS_TODAY, now: () => 0 }, {
      onCorpus: (done, total, entry) => seen.push(`c${done}/${total}:${entry.id}`),
      onScenario: (done, total, scenario) => seen.push(`s${done}/${total}:${scenario.id}`),
    });
    expect(Object.keys(r.corpus)).toEqual(corpus.map((e) => e.id));
    expect(Object.keys(r.scenarios)).toEqual(scenarios.map((s) => s.id));
    expect(seen).toEqual([...corpus.map((e, i) => `c${i + 1}/3:${e.id}`), ...scenarios.map((s, i) => `s${i + 1}/2:${s.id}`)]);
    expect(Object.keys(r.scenarioRecords)).toEqual(scenarios.map((s) => s.id));
    // A keypad step is one frame per digit, so records per scenario is at least steps plus the setup turn.
    for (const s of scenarios) expect(r.scenarioRecords[s.id]!.length).toBeGreaterThanOrEqual(s.steps.length + 1);
    // The first 3 records are the corpus ones (in order), the rest are every scenario record in order.
    const scenarioRecordsFlat = Object.values(r.scenarioRecords).flat();
    expect(r.records.slice(3)).toEqual(scenarioRecordsFlat);
    expect(r.records.length).toBe(3 + scenarioRecordsFlat.length);
    expect(typeof r.scenarios[scenarios[0]!.id]!.pass).toBe('boolean');
  });

  it('writes into a caller-provided accumulator so an aborted run keeps partial results', async () => {
    const thresholds = buildThresholds([]);
    const corpus = loadCorpus(DEFAULT_CORPUS_FILE).slice(0, 2);
    const into = emptyRunAll();
    await expect(runAll(corpus, [], { client: buildClient('stub', DEFAULT_CORPUS_FILE, thresholds), thresholds, todayIso: REGRESS_TODAY, now: () => 0 }, {
      onCorpus: (done) => { if (done === 1) throw new Error('stop'); },
    }, into)).rejects.toThrow('stop');
    expect(Object.keys(into.corpus)).toEqual([corpus[0]!.id]);
    expect(into.records.length).toBe(1);
  });

  it('keeps completed corpus results when a scenario hook aborts the run', async () => {
    const thresholds = buildThresholds([]);
    const corpus = loadCorpus(DEFAULT_CORPUS_FILE).slice(0, 2);
    const scenarios = loadScenarios('fixtures/scenarios').slice(0, 2);
    const into = emptyRunAll();
    await expect(runAll(corpus, scenarios, { client: buildClient('stub', DEFAULT_CORPUS_FILE, thresholds), thresholds, todayIso: REGRESS_TODAY, now: () => 0 }, {
      onScenario: (done) => { if (done === 1) throw new Error('stop'); },
    }, into)).rejects.toThrow('stop');
    expect(Object.keys(into.scenarios)).toEqual([scenarios[0]!.id]);
    expect(Object.keys(into.corpus)).toEqual(corpus.map((e) => e.id));
  });
});
