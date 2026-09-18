import { parseOverride, withOverrides, type Thresholds } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { SdkJevClient } from '../jev/sdkClient';
import type { JevClient } from '../jev/types';

export const DEFAULT_CORPUS_FILE = 'fixtures/corpus.jsonl';

export function buildThresholds(overrides: string[]): Thresholds {
  return withOverrides(Object.assign({}, ...overrides.map(parseOverride)));
}

export function buildClient(kind: string, corpusFile: string, thresholds: Thresholds): JevClient {
  if (kind === 'jev') return new SdkJevClient({ timeoutMs: thresholds.JEV_TIMEOUT_MS });
  if (kind === 'heuristic') return new HeuristicStubClient();
  return new FixtureStubClient(loadCorpus(corpusFile), { sharpness: thresholds.STUB_SHARPNESS, fallback: new HeuristicStubClient() });
}
