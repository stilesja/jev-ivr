import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // One grid step below DEFAULT_THRESHOLDS.INTENT_ROUTE, so the recorded intent lands in the
    // implicit band rather than routing confidently -- previously a cosmetic (ack-only)
    // difference from the expected corpus, until ack_intent started playing on every form entry
    // regardless of confidence (spec 2026-09-24 §4) and the two bands stopped differing at all.
    const soft = new FixtureStubClient(corpus, { sharpness: 0.65, fallback: new HeuristicStubClient() });
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

  it('finds no move to make: the plateau no longer has a cosmetic tiebreak to climb', async () => {
    // Both bands now play the same ack, so primary and secondary already agree at the current
    // threshold; the plateau this test used to climb (spec 2026-09-24 §4) is gone with it.
    const r = await runSweep(config({}));
    expect(r.result.before).toMatchObject({ primary: 3, secondary: 3 });
    expect(r.result.after).toMatchObject({ primary: 3, secondary: 3 });
    expect(r.result.moves).toHaveLength(0);
    // 0.95 would put INTENT_ROUTE above INTENT_SWITCH and 0.50 below INTENT_IMPLICIT: both skipped.
    expect(r.result.table.INTENT_ROUTE?.points.find((p) => p.value === 0.95)?.status).toBe('skipped');
    expect(r.result.table.INTENT_ROUTE?.points.find((p) => p.value === 0.5)?.status).toBe('skipped');
    expect(r.result.converged).toBe(true);
    expect(r.result.evaluations).toBe(new Set(r.result.table.INTENT_ROUTE?.points.filter((p) => p.status !== 'skipped')).size);
    expect(r.misses).toEqual([]);
  });

  it('leaves the thresholds file untouched and still writes a report when nothing moves', async () => {
    const r = await runSweep(config({ apply: true, json: join(dir, 'logs', 'out.json') }));
    expect(readFileSync(join(dir, 'thresholds.ts'), 'utf8')).toContain(`  INTENT_ROUTE: ${DEFAULT_THRESHOLDS.INTENT_ROUTE},`);
    const report = readFileSync(r.reportPath!, 'utf8');
    expect(report).toContain('no moves');
    expect(report).toContain(`passes ${r.result.passes} (converged)`);
    expect(report).toContain(`evaluations ${r.result.evaluations}`);
    // --json created its parent directory rather than failing on a path that does not exist yet
    const json = JSON.parse(readFileSync(join(dir, 'logs', 'out.json'), 'utf8'));
    expect(json.moves).toHaveLength(0);
    expect(json).toMatchObject({ converged: true, evaluations: r.result.evaluations });
  });

  it('writes a second report beside the first rather than over it', async () => {
    const first = await runSweep(config({ apply: true }));
    const second = await runSweep(config({ apply: true }));
    expect(second.reportPath).toBe(first.reportPath!.replace(/\.md$/, '-2.md'));
    expect(existsSync(first.reportPath!)).toBe(true);
  });
});
