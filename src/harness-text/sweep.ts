import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadCorpus } from '../jev/corpus';
import { CassetteClient, isCassetteMiss, loadCassette } from '../jev/cassette';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { JEV_MODEL } from '../jev/sdkClient';
import { DEFAULT_THRESHOLDS, type ThresholdName, type Thresholds } from '../core/thresholds';
import { cassettePath, DEFAULT_CORPUS_FILE } from '../run/client';
import { loadScenarios, type RunOptions } from './runner';
import { EXPECTED_DIR, readBaseline, REGRESS_TODAY } from './baseline';
import { runAll } from './runAll';
import { diff } from './regressDiff';
import { parseOnly } from './sweepSpace';
import { scoreOutcomes, type Score } from './sweepScore';
import { coordinateDescent, type SweepResult } from './sweepSearch';
import { renderMoves, renderReport, renderTable, rewriteThresholds } from './sweepApply';

export interface SweepConfig {
  corpusFile: string;
  scenariosDir: string;
  expectedDir: string;
  cassette: string;
  only: ThresholdName[];
  passes: number;
  apply: boolean;
  thresholdsFile: string;
  reportDir: string;
  json: string | null;
  onProgress?: (line: string) => void;
}

export interface SweepRun {
  result: SweepResult;
  misses: Score['misses'];
  reportPath: string | null;
}

function emptyScore(): Score {
  return { primary: -1, secondary: -1, corpusMatch: 0, scenarioPass: 0, cosmeticMatch: 0, matched: new Set(), cosmeticMatched: new Set(), misses: [] };
}

export async function runSweep(cfg: SweepConfig): Promise<SweepRun> {
  if (!existsSync(cfg.cassette)) throw new Error(`no cassette at ${cfg.cassette}; run pnpm regress --client record first`);
  const corpus = loadCorpus(cfg.corpusFile);
  const scenarios = loadScenarios(cfg.scenariosDir);
  const expected = readBaseline(cfg.expectedDir);
  const lines = loadCassette(cfg.cassette);
  // The real cassette is pinned to JEV_MODEL by buildClient; a synthetic one (tests) carries the stub's model name.
  const first = [...lines.values()][0];
  const model = first?.model;
  const recorded = new CassetteClient({ path: cfg.cassette, mode: 'replay', ...(model === JEV_MODEL ? { expectModel: JEV_MODEL } : {}) });
  recorded.preload();
  const stubFor = (t: Thresholds) => new FixtureStubClient(corpus, { sharpness: t.STUB_SHARPNESS, fallback: new HeuristicStubClient() });
  const opts = (client: RunOptions['client'], thresholds: Thresholds): RunOptions => ({ client, thresholds, todayIso: REGRESS_TODAY, now: () => 0 });

  const evaluate = async (candidate: Thresholds) => {
    const stub = await runAll(corpus, scenarios, opts(stubFor(candidate), candidate));
    const breaksStub = diff('corpus', expected.corpus, stub.corpus).lines.length > 0 || diff('scenario', expected.scenarios, stub.scenarios).lines.length > 0;
    if (breaksStub) return { score: emptyScore(), breaksStub };
    const real = await runAll(corpus, scenarios, opts(recorded, candidate));
    // runAll records the corpus in file order first, so these are exactly the corpus turns. A
    // corpus request key never depends on the thresholds (it is the state and the questions), so
    // a corpus miss can only mean the recording is stale — never something this candidate did.
    // Left unchecked it would silently cost the candidate a point and skew the whole sweep.
    for (const [i, entry] of corpus.entries()) {
      const record = real.records[i];
      if (record && isCassetteMiss(record)) throw new Error(`stale cassette: corpus entry ${entry.id} has no recorded answer; run pnpm regress --client record`);
    }
    const score = scoreOutcomes({ expectedCorpus: expected.corpus, expectedScenarios: expected.scenarios, actualCorpus: real.corpus, actualScenarios: real.scenarios, scenarioRecords: real.scenarioRecords });
    return { score, breaksStub: false };
  };

  const result = await coordinateDescent(evaluate, cfg.only, { ...DEFAULT_THRESHOLDS }, cfg.passes, (name, pass, i) => {
    if (i === 1) cfg.onProgress?.(`pass ${pass} ${name}`);
  });
  const misses = (await evaluate(result.final)).score.misses;

  let reportPath: string | null = null;
  if (cfg.apply) {
    const changed: Partial<Record<ThresholdName, number>> = {};
    for (const m of result.moves) changed[m.name] = result.final[m.name];
    if (Object.keys(changed).length > 0) writeFileSync(cfg.thresholdsFile, rewriteThresholds(readFileSync(cfg.thresholdsFile, 'utf8'), changed));
    // The local calendar date, not UTC: a sweep run in the evening west of Greenwich would
    // otherwise be filed under tomorrow, next to nothing else from that day's work.
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    mkdirSync(cfg.reportDir, { recursive: true });
    // A second sweep on the same day is a second result, not a correction of the first: it gets
    // its own file rather than silently replacing the report the earlier values were argued from.
    reportPath = join(cfg.reportDir, `${date}-sweep.md`);
    for (let n = 2; existsSync(reportPath); n++) reportPath = join(cfg.reportDir, `${date}-sweep-${n}.md`);
    writeFileSync(reportPath, renderReport(result, { cassette: cfg.cassette, requests: lines.size, date, corpusCount: corpus.length, scenarioCount: scenarios.length, misses }));
  }
  if (cfg.json) {
    mkdirSync(dirname(cfg.json), { recursive: true });
    // The per-point id sets are dropped: a full log of them runs to six figures of lines, and the
    // sets that matter (a move's flips) are spelled out in `moves`.
    const omitSets = (k: string, v: unknown) => (k === 'matched' || k === 'cosmeticMatched' ? undefined : v instanceof Set ? [...v] : v);
    writeFileSync(cfg.json, JSON.stringify({ before: result.before, after: result.after, moves: result.moves, table: result.table, final: result.final, misses, converged: result.converged, evaluations: result.evaluations }, omitSets, 2) + '\n');
  }
  return { result, misses, reportPath };
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      json: { type: 'string' },
      only: { type: 'string' },
      passes: { type: 'string', default: '5' },
      'corpus-file': { type: 'string', default: DEFAULT_CORPUS_FILE },
      'scenarios-dir': { type: 'string', default: 'fixtures/scenarios' },
      'expected-dir': { type: 'string', default: EXPECTED_DIR },
      cassette: { type: 'string', default: cassettePath() },
      'thresholds-file': { type: 'string', default: 'src/core/thresholds.ts' },
      'report-dir': { type: 'string', default: 'docs/tuning' },
    },
  });
  const passes = Number(args.passes);
  if (!Number.isInteger(passes) || passes < 1) throw new Error('--passes must be a positive integer');
  const run = await runSweep({
    corpusFile: args['corpus-file']!, scenariosDir: args['scenarios-dir']!, expectedDir: args['expected-dir']!, cassette: args.cassette!,
    only: parseOnly(args.only), passes, apply: args.apply ?? false, thresholdsFile: args['thresholds-file']!, reportDir: args['report-dir']!, json: args.json ?? null,
    onProgress: (line) => console.error(`  ${line}`),
  });
  const r = run.result;
  console.log(`before ${r.before.primary}/${r.before.secondary}   after ${r.after.primary}/${r.after.secondary}   passes ${r.passes} (${r.converged ? 'converged' : 'not converged'})   evaluations ${r.evaluations}`);
  console.log('');
  console.log(renderTable(r));
  console.log('');
  console.log(renderMoves(r));
  console.log('');
  console.log(run.misses.length ? `cassette misses for the recommended set:\n${run.misses.map((m) => `  ${m.id}: "${m.text}"`).join('\n')}` : 'no cassette misses for the recommended set');
  if (run.reportPath) console.log(`\napplied to ${args['thresholds-file']}; report ${run.reportPath}`);
}

// regress.ts runs its main at module scope and cannot be imported; this module can, so it guards.
if (process.argv[1] && basename(process.argv[1]) === 'sweep.ts') {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
