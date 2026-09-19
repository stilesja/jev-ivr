import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadCorpus } from '../jev/corpus';
import { parseOverride, withOverrides } from '../core/thresholds';
import { buildClient, cassettePath, CLIENT_KINDS, DEFAULT_CORPUS_FILE, isClientKind } from '../run/client';
import { diff } from './regressDiff';
import { formatRegressSummary } from './regressSummary';
import type { TraceRecord } from '../trace/types';
import { loadScenarios, runCorpusEntry, runScenario, type Outcome, type RunOptions } from './runner';

/** Fixed so recorded outcomes never depend on the wall clock. */
export const REGRESS_TODAY = '2026-09-18';
const EXPECTED_DIR = 'fixtures/expected';
/** Corpus entries between progress lines on a run that talks to a model. */
const PROGRESS_EVERY = 25;

const { values: args } = parseArgs({
  options: {
    update: { type: 'boolean', default: false },
    threshold: { type: 'string', multiple: true, default: [] },
    client: { type: 'string', default: 'stub' },
  },
});

type ScenarioOutcome = Outcome & { pass: boolean; mismatches: string[] };
interface Recorded {
  corpus: Record<string, Outcome>;
  scenarios: Record<string, ScenarioOutcome>;
}

function readExpected<T>(file: string): Record<string, T> {
  const path = `${EXPECTED_DIR}/${file}`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, T>) : {};
}

async function main(): Promise<void> {
  const kind = args.client ?? 'stub';
  if (!isClientKind(kind)) throw new Error(`--client must be one of ${CLIENT_KINDS.join(', ')}`);
  if (args.update && kind !== 'stub') {
    console.error('--update is stub-only: fixtures/expected is the label-derived baseline and is re-recorded from the stub');
    process.exitCode = 1;
    return;
  }
  const thresholds = withOverrides(Object.assign({}, ...(args.threshold ?? []).map(parseOverride)));
  const corpus = loadCorpus(DEFAULT_CORPUS_FILE);
  const scenarioDefs = loadScenarios('fixtures/scenarios');
  if (kind === 'record' || kind === 'recorded') {
    const path = cassettePath();
    console.log(`cassette ${path}${existsSync(path) ? '' : ' (not found; every turn will miss until recorded)'}`);
  }
  const opts: RunOptions = {
    client: buildClient(kind, DEFAULT_CORPUS_FILE, thresholds),
    thresholds,
    todayIso: REGRESS_TODAY,
    now: () => 0,
  };
  // A run that reaches a model is slow and can abort part way; it reports progress on stderr
  // (stdout is the diff artifact) and still gets a summary of what it paid for, from the finally.
  const live = kind !== 'stub' && kind !== 'heuristic';

  const actual: Recorded = { corpus: {}, scenarios: {} };
  const records: TraceRecord[] = [];
  try {
    let done = 0;
    for (const entry of corpus) {
      const r = await runCorpusEntry(entry, opts);
      actual.corpus[entry.id] = r.outcome;
      records.push(r.run.record);
      done += 1;
      if (live && done % PROGRESS_EVERY === 0) console.error(`  corpus ${done}/${corpus.length}`);
    }
    done = 0;
    for (const scenario of scenarioDefs) {
      const r = await runScenario(scenario, opts);
      actual.scenarios[scenario.id] = { ...r.outcome, pass: r.pass, mismatches: r.mismatches };
      records.push(...r.runs.map((run) => run.record));
      done += 1;
      if (live) console.error(`  scenario ${done}/${scenarioDefs.length} ${scenario.id}`);
    }

    if (args.update) {
      mkdirSync(EXPECTED_DIR, { recursive: true });
      writeFileSync(`${EXPECTED_DIR}/corpus.json`, JSON.stringify(actual.corpus, null, 2) + '\n');
      writeFileSync(`${EXPECTED_DIR}/scenarios.json`, JSON.stringify(actual.scenarios, null, 2) + '\n');
      console.log(`recorded ${Object.keys(actual.corpus).length} corpus outcomes and ${Object.keys(actual.scenarios).length} scenario outcomes`);
      return;
    }

    const lines = [
      ...diff('corpus', readExpected<Outcome>('corpus.json'), actual.corpus).lines,
      ...diff('scenario', readExpected<ScenarioOutcome>('scenarios.json'), actual.scenarios).lines,
    ];
    const failing = Object.values(actual.scenarios).filter((s) => !s.pass);
    for (const s of failing) console.log(`FAIL scenario ${s.id}: ${s.mismatches.join('; ')}`);
    for (const l of lines) console.log(l);
    if (lines.length === 0 && failing.length === 0) console.log('no changes');
    else process.exitCode = 1;
  } finally {
    // Diffed here rather than reused from above so an aborted run still reports what it ran:
    // ids it never reached simply read as removed.
    if (!args.update && records.length > 0) {
      const ran = Object.values(actual.scenarios);
      console.log('');
      console.log(formatRegressSummary({
        corpusTotal: corpus.length,
        corpusMatching: diff('corpus', readExpected<Outcome>('corpus.json'), actual.corpus).matching,
        scenarioTotal: scenarioDefs.length,
        scenarioPassing: ran.filter((s) => s.pass).length,
        scenarioMatching: diff('scenario', readExpected<ScenarioOutcome>('scenarios.json'), actual.scenarios).matching,
        records,
      }));
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
