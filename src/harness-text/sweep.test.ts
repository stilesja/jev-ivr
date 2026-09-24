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

// Two of three entries name a provider, so their fill can be pushed into the implicit band; the
// third (no provider) never differs and is what keeps secondary above 0 rather than at 0.
const CORPUS = [
  '{"id":"t-1","text":"please cancel my visit with dr patel","intent":"cancel","context":"no_form","slots":{"provider":"patel"}}',
  '{"id":"t-2","text":"I want to move my visit with dr chen","intent":"reschedule","context":"no_form","slots":{"provider":"chen"}}',
  '{"id":"t-3","text":"book me a new visit","intent":"schedule_new","context":"no_form"}',
].join('\n') + '\n';

// Same ids and text as CORPUS -- the cassette key is state plus questions, not corpus content, so
// a recording made from this corpus still replays cleanly against CORPUS below -- but the
// provider answer is overridden so its top probability (0.5) lands between SLOT_CHOICE_CONFIRM
// (0.45) and the default SLOT_CHOICE_FILL (0.55): the same provider still fills either way, so
// only `confirm` ('none' vs 'implicit') and the ack_provider acknowledgment it brings differ --
// a cosmetic (acks-only) difference sweepScore.ts can use as a tiebreak.
const SOFT_CORPUS = [
  '{"id":"t-1","text":"please cancel my visit with dr patel","intent":"cancel","context":"no_form","slots":{"provider":"patel"},"answers":{"provider":{"probabilities":{"patel":0.5}}}}',
  '{"id":"t-2","text":"I want to move my visit with dr chen","intent":"reschedule","context":"no_form","slots":{"provider":"chen"},"answers":{"provider":{"probabilities":{"chen":0.5}}}}',
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
    writeFileSync(join(dir, 'corpus-soft.jsonl'), SOFT_CORPUS);
    const softCorpus = loadCorpus(join(dir, 'corpus-soft.jsonl'));
    const soft = new FixtureStubClient(softCorpus, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const recorder = new CassetteClient({ path: join(dir, 'cassette.jsonl'), mode: 'record', inner: soft });
    await runAll(softCorpus, [], { client: recorder, thresholds, todayIso: REGRESS_TODAY, now: () => 0 });
    writeFileSync(join(dir, 'thresholds.ts'), readFileSync('src/core/thresholds.ts', 'utf8'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const config = (over: object) => ({
    corpusFile: join(dir, 'corpus.jsonl'), scenariosDir: join(dir, 'scenarios'), expectedDir: join(dir, 'expected'),
    cassette: join(dir, 'cassette.jsonl'), only: ['SLOT_CHOICE_FILL' as const], passes: 3, apply: false,
    thresholdsFile: join(dir, 'thresholds.ts'), reportDir: join(dir, 'tuning'), json: null, ...over,
  });

  it('lowers SLOT_CHOICE_FILL to the plateau center and explains the move', async () => {
    const r = await runSweep(config({}));
    expect(r.result.before).toMatchObject({ primary: 3, secondary: 1 });
    expect(r.result.after).toMatchObject({ primary: 3, secondary: 3 });
    expect(r.result.moves).toHaveLength(1);
    expect(r.result.moves[0]).toMatchObject({ name: 'SLOT_CHOICE_FILL', from: DEFAULT_THRESHOLDS.SLOT_CHOICE_FILL, to: 0.45, reason: 'secondary', plateau: { from: 0.45, to: 0.5 } });
    expect(r.result.moves[0]!.flips.cosmeticGained).toEqual(['t-1', 't-2']);
    // Below SLOT_CHOICE_CONFIRM (0.45) the constraint SLOT_CHOICE_CONFIRM <= SLOT_CHOICE_FILL forbids the value.
    expect(r.result.table.SLOT_CHOICE_FILL?.points.find((p) => p.value === 0.4)?.status).toBe('skipped');
    // Above the stub's own provider probability (0.9 at STUB_SHARPNESS), the plain corpus's fresh
    // stub run flips to implicit too, and no longer matches the DEFAULT_THRESHOLDS baseline.
    expect(r.result.table.SLOT_CHOICE_FILL?.points.find((p) => p.value === 0.95)?.status).toBe('breaks_stub');
    expect(r.result.converged).toBe(true);
    expect(r.result.evaluations).toBe(new Set(r.result.table.SLOT_CHOICE_FILL?.points.filter((p) => p.status !== 'skipped')).size);
    expect(r.misses).toEqual([]);
  });

  it('applies the result to the thresholds file and writes the report', async () => {
    const r = await runSweep(config({ apply: true, json: join(dir, 'logs', 'out.json') }));
    expect(readFileSync(join(dir, 'thresholds.ts'), 'utf8')).toContain('  SLOT_CHOICE_FILL: 0.45,');
    const report = readFileSync(r.reportPath!, 'utf8');
    expect(report).toContain(`pass 1: SLOT_CHOICE_FILL ${DEFAULT_THRESHOLDS.SLOT_CHOICE_FILL.toFixed(2)} -> 0.45`);
    expect(report).toContain(`passes ${r.result.passes} (converged)`);
    expect(report).toContain(`evaluations ${r.result.evaluations}`);
    // --json created its parent directory rather than failing on a path that does not exist yet
    const json = JSON.parse(readFileSync(join(dir, 'logs', 'out.json'), 'utf8'));
    expect(json.moves).toHaveLength(1);
    expect(json).toMatchObject({ converged: true, evaluations: r.result.evaluations });
  });

  it('writes a second report beside the first rather than over it', async () => {
    const first = await runSweep(config({ apply: true }));
    const second = await runSweep(config({ apply: true }));
    expect(second.reportPath).toBe(first.reportPath!.replace(/\.md$/, '-2.md'));
    expect(existsSync(first.reportPath!)).toBe(true);
  });
});
