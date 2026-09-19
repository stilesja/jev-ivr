import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSweep } from './sweep';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { CassetteClient } from '../jev/cassette';
import { loadCorpus } from '../jev/corpus';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { runAll } from './runAll';
import { writeExpected, REGRESS_TODAY } from './baseline';

const CORPUS = [
  '{"id":"t-1","text":"please cancel my visit","intent":"cancel","context":"no_form"}',
  '{"id":"t-2","text":"I want to move my visit","intent":"reschedule","context":"no_form"}',
  '{"id":"t-3","text":"book me a new visit","intent":"schedule_new","context":"no_form"}',
].join('\n') + '\n';

describe('runSweep', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    writeFileSync(join(dir, 'corpus.jsonl'), CORPUS);
    mkdirSync(join(dir, 'scenarios'));
    writeFileSync(join(dir, 'scenarios', 'core.json'), '[]\n');
    const corpus = loadCorpus(join(dir, 'corpus.jsonl'));
    const thresholds = { ...DEFAULT_THRESHOLDS };
    const stub = new FixtureStubClient(corpus, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const base = await runAll(corpus, [], { client: stub, thresholds, todayIso: REGRESS_TODAY, now: () => 0 });
    writeExpected({ corpus: base.corpus, scenarios: base.scenarios }, join(dir, 'expected'));
    const soft = new FixtureStubClient(corpus, { sharpness: 0.8, fallback: new HeuristicStubClient() });
    const recorder = new CassetteClient({ path: join(dir, 'cassette.jsonl'), mode: 'record', inner: soft });
    await runAll(corpus, [], { client: recorder, thresholds, todayIso: REGRESS_TODAY, now: () => 0 });
    writeFileSync(join(dir, 'thresholds.ts'), readFileSync('src/core/thresholds.ts', 'utf8'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const config = (over: object) => ({
    corpusFile: join(dir, 'corpus.jsonl'), scenariosDir: join(dir, 'scenarios'), expectedDir: join(dir, 'expected'),
    cassette: join(dir, 'cassette.jsonl'), only: ['INTENT_ROUTE' as const], passes: 3, apply: false,
    thresholdsFile: join(dir, 'thresholds.ts'), reportDir: join(dir, 'tuning'), json: null, ...over,
  });

  it('lowers INTENT_ROUTE to the plateau center and explains the move', async () => {
    const r = await runSweep(config({}));
    expect(r.result.before).toMatchObject({ primary: 3, secondary: 0 });
    expect(r.result.after).toMatchObject({ primary: 3, secondary: 3 });
    expect(r.result.moves).toHaveLength(1);
    expect(r.result.moves[0]).toMatchObject({ name: 'INTENT_ROUTE', from: 0.85, to: 0.7, reason: 'secondary', plateau: { from: 0.6, to: 0.8 } });
    expect(r.result.table.INTENT_ROUTE?.points.find((p) => p.value === 0.95)?.status).toBe('breaks_stub');
    expect(r.result.table.INTENT_ROUTE?.points.find((p) => p.value === 0.5)?.status).toBe('skipped');
    expect(r.misses).toEqual([]);
  });

  it('applies the result to the thresholds file and writes the report', async () => {
    const r = await runSweep(config({ apply: true, json: join(dir, 'out.json') }));
    expect(readFileSync(join(dir, 'thresholds.ts'), 'utf8')).toContain('  INTENT_ROUTE: 0.7,');
    expect(readFileSync(r.reportPath!, 'utf8')).toContain('INTENT_ROUTE 0.85 -> 0.70');
    expect(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')).moves).toHaveLength(1);
  });
});
