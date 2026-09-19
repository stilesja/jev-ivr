import { canonicalJson, isCassetteMiss } from '../jev/cassette';
import type { TraceRecord } from '../trace/types';
import type { Outcome } from './runner';
import type { ScenarioOutcome } from './baseline';

/**
 * What the caller experiences; a mismatch here is a wrong decision. `queued` counts as a
 * decision field (not a cosmetic one): a queued intent is a promise made to the caller and it
 * reaches the handoff data, so dropping or inventing one is a wrong answer, not a tidier one.
 */
export const DECISION_FIELDS: ReadonlyArray<keyof Outcome> = ['decision', 'promptId', 'reason', 'form', 'slots', 'queued'];
/** How the decision was reached or dressed; a mismatch here is a tiebreak. */
export const COSMETIC_FIELDS: ReadonlyArray<keyof Outcome> = ['acks', 'decidedGate', 'verdict'];

/** Scenario ids in `matched` carry this prefix so a scenario cannot collide with a corpus id. */
export const SCENARIO_PREFIX = 'scenario:';

type Row = Pick<TraceRecord, 'error' | 'event' | 'source'>;

export interface ScoreInput {
  expectedCorpus: Record<string, Outcome>;
  expectedScenarios: Record<string, ScenarioOutcome>;
  actualCorpus: Record<string, Outcome>;
  actualScenarios: Record<string, ScenarioOutcome>;
  scenarioRecords: Record<string, Row[]>;
}

export interface Score {
  primary: number;
  secondary: number;
  corpusMatch: number;
  scenarioPass: number;
  cosmeticMatch: number;
  /** ids counted in `primary`: corpus entries whose decision fields match (bare id), scenarios that pass (`scenario:<id>`) */
  matched: Set<string>;
  misses: Array<{ id: string; text: string }>;
}

/**
 * Field-by-field equality. The field lists are typed against `Outcome`, so a misspelled field
 * name is a compile error rather than a comparison of two undefineds that always passes, and
 * `canonicalJson` sorts object keys so `slots` cannot differ by key order alone.
 */
function same(a: Outcome | undefined, b: Outcome | undefined, fields: ReadonlyArray<keyof Outcome>): boolean {
  if (!a || !b) return false;
  return fields.every((f) => canonicalJson(a[f]) === canonicalJson(b[f]));
}

/** The utterance of the first turn that missed the cassette, or null. */
export function missedUtterance(records: Row[]): string | null {
  for (const r of records) {
    if (isCassetteMiss(r)) return r.event.type === 'prompt' ? r.event.voicePrompt : '';
  }
  return null;
}

export function scoreOutcomes(i: ScoreInput): Score {
  const matched = new Set<string>();
  let corpusMatch = 0;
  let cosmeticMatch = 0;
  for (const id of Object.keys(i.expectedCorpus)) {
    const e = i.expectedCorpus[id];
    const a = i.actualCorpus[id];
    if (same(e, a, DECISION_FIELDS)) {
      corpusMatch += 1;
      matched.add(id);
      if (same(e, a, COSMETIC_FIELDS)) cosmeticMatch += 1;
    }
  }
  let scenarioPass = 0;
  const misses: Score['misses'] = [];
  for (const id of Object.keys(i.expectedScenarios)) {
    const a = i.actualScenarios[id];
    const missed = missedUtterance(i.scenarioRecords[id] ?? []);
    if (missed !== null) { misses.push({ id, text: missed }); continue; }
    if (a?.pass) {
      scenarioPass += 1;
      matched.add(`${SCENARIO_PREFIX}${id}`);
      if (same(i.expectedScenarios[id], a, COSMETIC_FIELDS)) cosmeticMatch += 1;
    }
  }
  return { primary: corpusMatch + scenarioPass, secondary: cosmeticMatch, corpusMatch, scenarioPass, cosmeticMatch, matched, misses };
}

/**
 * Primary, then secondary, then fewer cassette misses. The third key matters because a missed
 * scenario is excluded from both counts: a candidate that scores the same while answering more
 * of the recording is better evidenced, and without the tiebreak the search would happily sit
 * on a set whose extra misses hide the scenarios it breaks.
 */
export function better(a: Score, b: Score): boolean {
  if (a.primary !== b.primary) return a.primary > b.primary;
  if (a.secondary !== b.secondary) return a.secondary > b.secondary;
  return a.misses.length < b.misses.length;
}

export function equal(a: Score, b: Score): boolean {
  return a.primary === b.primary && a.secondary === b.secondary && a.misses.length === b.misses.length;
}

export function flips(before: Score, after: Score): { gained: string[]; lost: string[] } {
  return {
    gained: [...after.matched].filter((id) => !before.matched.has(id)).sort(),
    lost: [...before.matched].filter((id) => !after.matched.has(id)).sort(),
  };
}
