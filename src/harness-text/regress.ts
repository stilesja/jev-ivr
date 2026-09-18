import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { parseOverride, withOverrides } from '../core/thresholds';
import { loadScenarios, runCorpusEntry, runScenario, type Outcome, type RunOptions } from './runner';

/** Fixed so recorded outcomes never depend on the wall clock. */
export const REGRESS_TODAY = '2026-09-18';
const EXPECTED_DIR = 'fixtures/expected';

const { values: args } = parseArgs({
  options: {
    update: { type: 'boolean', default: false },
    threshold: { type: 'string', multiple: true, default: [] },
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

function diff<T extends object>(name: string, expected: Record<string, T>, actual: Record<string, T>): string[] {
  const out: string[] = [];
  for (const id of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const e = expected[id];
    const a = actual[id];
    if (!e) { out.push(`+ ${name} ${id}: new`); continue; }
    if (!a) { out.push(`- ${name} ${id}: removed`); continue; }
    for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) {
      const ev = JSON.stringify((e as Record<string, unknown>)[key]);
      const av = JSON.stringify((a as Record<string, unknown>)[key]);
      if (ev !== av) out.push(`~ ${name} ${id}.${key}: ${ev} -> ${av}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const thresholds = withOverrides(Object.assign({}, ...(args.threshold ?? []).map(parseOverride)));
  const corpus = loadCorpus('fixtures/corpus.jsonl');
  const opts: RunOptions = {
    client: new FixtureStubClient(corpus, { sharpness: thresholds.STUB_SHARPNESS, fallback: new HeuristicStubClient() }),
    thresholds,
    todayIso: REGRESS_TODAY,
    now: () => 0,
  };

  const actual: Recorded = { corpus: {}, scenarios: {} };
  for (const entry of corpus) actual.corpus[entry.id] = (await runCorpusEntry(entry, opts)).outcome;
  for (const scenario of loadScenarios('fixtures/scenarios')) {
    const r = await runScenario(scenario, opts);
    actual.scenarios[scenario.id] = { ...r.outcome, pass: r.pass, mismatches: r.mismatches };
  }

  if (args.update) {
    mkdirSync(EXPECTED_DIR, { recursive: true });
    writeFileSync(`${EXPECTED_DIR}/corpus.json`, JSON.stringify(actual.corpus, null, 2) + '\n');
    writeFileSync(`${EXPECTED_DIR}/scenarios.json`, JSON.stringify(actual.scenarios, null, 2) + '\n');
    console.log(`recorded ${Object.keys(actual.corpus).length} corpus outcomes and ${Object.keys(actual.scenarios).length} scenario outcomes`);
    return;
  }

  const lines = [
    ...diff('corpus', readExpected<Outcome>('corpus.json'), actual.corpus),
    ...diff('scenario', readExpected<ScenarioOutcome>('scenarios.json'), actual.scenarios),
  ];
  const failing = Object.values(actual.scenarios).filter((s) => !s.pass);
  for (const s of failing) console.log(`FAIL scenario ${s.id}: ${s.mismatches.join('; ')}`);
  for (const l of lines) console.log(l);
  if (lines.length === 0 && failing.length === 0) console.log('no changes');
  else process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
