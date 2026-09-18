import { describe, expect, it } from 'vitest';
import { loadScenarios, runScenario } from './runner';
import { loadCorpus, normalizeText } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

const corpus = loadCorpus('fixtures/corpus.jsonl');
const scenarios = loadScenarios('fixtures/scenarios');
const known = new Set(corpus.map((e) => normalizeText(e.text)));
const opts = {
  client: new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient() }),
  thresholds: { ...DEFAULT_THRESHOLDS },
  todayIso: '2026-09-18',
  now: () => 0,
};

describe('fixtures/scenarios', () => {
  it('has at least 30 scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(30);
  });

  it('only says things that are in the corpus', () => {
    for (const s of scenarios) for (const step of s.steps) if ('say' in step) expect(known, `${s.id}: ${step.say}`).toContain(normalizeText(step.say));
  });

  for (const s of scenarios) {
    it(`passes: ${s.id}`, async () => {
      const r = await runScenario(s, opts);
      expect(r.mismatches).toEqual([]);
    });
  }
});
