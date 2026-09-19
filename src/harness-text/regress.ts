import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { loadCorpus } from '../jev/corpus';
import { parseOverride, withOverrides } from '../core/thresholds';
import { buildClient, cassettePath, CLIENT_KINDS, DEFAULT_CORPUS_FILE, isClientKind } from '../run/client';
import { isCassetteMiss } from '../jev/cassette';
import { diff } from './regressDiff';
import { formatRegressSummary } from './regressSummary';
import type { TraceRecord } from '../trace/types';
import { loadScenarios, type RunOptions } from './runner';
import { readBaseline, REGRESS_TODAY, writeExpected } from './baseline';
import { emptyRunAll, runAll } from './runAll';

/** Corpus entries between progress lines on a run that talks to a model. */
const PROGRESS_EVERY = 25;

const { values: args } = parseArgs({
  options: {
    update: { type: 'boolean', default: false },
    threshold: { type: 'string', multiple: true, default: [] },
    client: { type: 'string', default: 'stub' },
  },
});

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
  const live = kind === 'record' || kind === 'jev';

  // Aborts a live run after 3 consecutive client-level failures (timeouts, auth) rather than
  // burning through the whole corpus one turn at a time; a cassette miss doesn't count; a
  // non-live kind never talks to a model, so it never trips this.
  let consecutiveClientErrors = 0;
  let firstClientErrorMessage = '';
  function checkClientError(record: TraceRecord): void {
    if (!live) return;
    const isClientError = record.source === 'error' && record.error !== null && !isCassetteMiss(record);
    if (!isClientError) {
      consecutiveClientErrors = 0;
      return;
    }
    if (consecutiveClientErrors === 0) firstClientErrorMessage = record.error!.message;
    consecutiveClientErrors += 1;
    if (consecutiveClientErrors >= 3) {
      throw new Error(`aborting after 3 consecutive client errors; first: ${firstClientErrorMessage}`);
    }
  }

  // Hoisted above the try so a corrupt expected-outcomes file fails before any run state
  // exists, rather than inside the finally where it would mask a real run failure.
  const expected = readBaseline();

  const actual = emptyRunAll();
  try {
    await runAll(corpus, scenarioDefs, opts, {
      onCorpus: (done, total, _entry, record) => {
        checkClientError(record);
        if (live && done % PROGRESS_EVERY === 0) console.error(`  corpus ${done}/${total}`);
      },
      onScenario: (done, total, scenario, records) => {
        for (const record of records) checkClientError(record);
        if (live) console.error(`  scenario ${done}/${total} ${scenario.id}`);
      },
    }, actual);

    if (args.update) {
      writeExpected({ corpus: actual.corpus, scenarios: actual.scenarios });
      console.log(`recorded ${Object.keys(actual.corpus).length} corpus outcomes and ${Object.keys(actual.scenarios).length} scenario outcomes`);
      return;
    }

    const lines = [
      ...diff('corpus', expected.corpus, actual.corpus).lines,
      ...diff('scenario', expected.scenarios, actual.scenarios).lines,
    ];
    const failing = Object.values(actual.scenarios).filter((s) => !s.pass);
    for (const s of failing) console.log(`FAIL scenario ${s.id}: ${s.mismatches.join('; ')}`);
    for (const l of lines) console.log(l);
    if (lines.length === 0 && failing.length === 0) console.log('no changes');
    else process.exitCode = 1;
  } finally {
    // Diffed here rather than reused from above so an aborted run still reports what it ran:
    // ids it never reached simply read as removed. Wrapped so a failure in here (e.g. a
    // formatting bug) surfaces on stderr instead of replacing the real exception from the run.
    try {
      if (!args.update && actual.records.length > 0) {
        const ran = Object.values(actual.scenarios);
        console.log('');
        console.log(formatRegressSummary({
          corpusTotal: corpus.length,
          corpusMatching: diff('corpus', expected.corpus, actual.corpus).matching,
          scenarioTotal: scenarioDefs.length,
          scenarioPassing: ran.filter((s) => s.pass).length,
          scenarioMatching: diff('scenario', expected.scenarios, actual.scenarios).matching,
          records: actual.records,
        }));
      }
    } catch (e) {
      console.error(`summary unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
