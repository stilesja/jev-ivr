import { parseOverride, withOverrides, type Thresholds } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { CassetteClient } from '../jev/cassette';
import { JEV_MODEL, SdkJevClient } from '../jev/sdkClient';
import type { JevClient } from '../jev/types';

export const DEFAULT_CORPUS_FILE = 'fixtures/corpus.jsonl';

export function buildThresholds(overrides: string[]): Thresholds {
  return withOverrides(Object.assign({}, ...overrides.map(parseOverride)));
}

export const CLIENT_KINDS = ['stub', 'heuristic', 'jev', 'record', 'recorded'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export function isClientKind(kind: string): kind is ClientKind {
  return (CLIENT_KINDS as readonly string[]).includes(kind);
}

/** One cassette per pinned model version; a model bump gets a fresh file. */
export function cassettePath(model: string = JEV_MODEL): string {
  return `fixtures/recorded/${model}.jsonl`;
}

/**
 * `todayIso` is the run's date, for the clients that read one. Only the heuristic stub does: it
 * decides which spans read as a birth year, and a run that pins RunOptions.todayIso wants its
 * fallback answers pinned to the same day. Left out (the server) it is the wall clock.
 */
export function buildClient(kind: string, corpusFile: string, thresholds: Thresholds, todayIso?: string): JevClient {
  if (!isClientKind(kind)) throw new Error(`unknown client kind "${kind}"; expected one of ${CLIENT_KINDS.join(', ')}`);
  const heuristic = (): HeuristicStubClient => new HeuristicStubClient(todayIso === undefined ? {} : { todayIso });
  switch (kind) {
    case 'stub':
      return new FixtureStubClient(loadCorpus(corpusFile), { sharpness: thresholds.STUB_SHARPNESS, fallback: heuristic() });
    case 'heuristic':
      return heuristic();
    case 'jev':
      return new SdkJevClient({ timeoutMs: thresholds.JEV_TIMEOUT_MS });
    case 'record': {
      const client = new CassetteClient({
        path: cassettePath(),
        mode: 'record',
        inner: new SdkJevClient({ timeoutMs: thresholds.JEV_TIMEOUT_MS }),
        expectModel: JEV_MODEL,
      });
      client.preload();
      return client;
    }
    case 'recorded': {
      const client = new CassetteClient({ path: cassettePath(), mode: 'replay', expectModel: JEV_MODEL });
      client.preload();
      return client;
    }
  }
}
