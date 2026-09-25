import { writeFileSync } from 'node:fs';
import { loadCorpus } from '../jev/corpus';
import { CassetteClient, isCassetteMiss, loadCassette, requestKey, trimCassette } from '../jev/cassette';
import { JEV_MODEL } from '../jev/sdkClient';
import type { JevClient } from '../jev/types';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { cassettePath, DEFAULT_CORPUS_FILE } from '../run/client';
import { REGRESS_TODAY } from './baseline';
import { loadScenarios } from './runner';
import { runAll } from './runAll';

/**
 * `pnpm cassette:trim`: replay the whole regression run from the cassette, note every request it
 * makes, and rewrite the file with only those answers. Nothing is written unless the replay was
 * complete: a miss means the cassette is behind the questions, and trimming it then would throw
 * away answers a re-record is about to need. Spends nothing; the model is never called.
 */
async function main(): Promise<void> {
  const path = cassettePath();
  const replay = new CassetteClient({ path, mode: 'replay', expectModel: JEV_MODEL });
  replay.preload();
  const used = new Set<string>();
  const client: JevClient = {
    ask: (req) => {
      used.add(requestKey(req));
      return replay.ask(req);
    },
  };
  let misses = 0;
  const count = (record: Parameters<typeof isCassetteMiss>[0]): void => {
    if (isCassetteMiss(record)) misses += 1;
  };
  await runAll(loadCorpus(DEFAULT_CORPUS_FILE), loadScenarios('fixtures/scenarios'), {
    client,
    thresholds: { ...DEFAULT_THRESHOLDS },
    todayIso: REGRESS_TODAY,
    now: () => 0,
  }, {
    onCorpus: (_done, _total, _entry, record) => count(record),
    onScenario: (_done, _total, _scenario, records) => records.forEach(count),
  });
  if (misses > 0) {
    console.error(`${path}: ${misses} requests missed; re-record with pnpm regress --client record before trimming. Nothing written.`);
    process.exitCode = 1;
    return;
  }
  const lines = loadCassette(path);
  const kept = trimCassette(lines, used);
  writeFileSync(path, kept.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log(`${path}: ${lines.size} answers, kept the ${kept.length} a regression run asks for`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
