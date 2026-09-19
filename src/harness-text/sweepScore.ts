import { CASSETTE_MISS } from '../jev/cassette';
import type { TraceRecord } from '../trace/types';
import type { Outcome } from './runner';
import type { ScenarioOutcome } from './baseline';

/** What the caller experiences; a mismatch here is a wrong decision. */
export const DECISION_FIELDS = ['decision', 'promptId', 'reason', 'form', 'slots'] as const;
/** How the decision was reached or dressed; a mismatch here is a tiebreak. */
export const COSMETIC_FIELDS = ['acks', 'decidedGate', 'verdict', 'queued'] as const;

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
  /** ids counted in `primary`: corpus entries whose decision fields match, scenarios that pass */
  matched: Set<string>;
  misses: Array<{ id: string; text: string }>;
}

function same(a: object | undefined, b: object | undefined, fields: readonly string[]): boolean {
  if (!a || !b) return false;
  return fields.every((f) => JSON.stringify((a as Record<string, unknown>)[f]) === JSON.stringify((b as Record<string, unknown>)[f]));
}

/** The utterance of the first turn that missed the cassette, or null. */
export function missedUtterance(records: Row[]): string | null {
  for (const r of records) {
    if (r.error && r.error.message.startsWith(CASSETTE_MISS)) return r.event.type === 'prompt' ? r.event.voicePrompt : '';
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
      matched.add(id);
      if (same(i.expectedScenarios[id], a, COSMETIC_FIELDS)) cosmeticMatch += 1;
    }
  }
  return { primary: corpusMatch + scenarioPass, secondary: cosmeticMatch, corpusMatch, scenarioPass, cosmeticMatch, matched, misses };
}

export function better(a: Score, b: Score): boolean {
  return a.primary > b.primary || (a.primary === b.primary && a.secondary > b.secondary);
}

export function equal(a: Score, b: Score): boolean {
  return a.primary === b.primary && a.secondary === b.secondary;
}

export function flips(before: Score, after: Score): { gained: string[]; lost: string[] } {
  return {
    gained: [...after.matched].filter((id) => !before.matched.has(id)).sort(),
    lost: [...before.matched].filter((id) => !after.matched.has(id)).sort(),
  };
}
