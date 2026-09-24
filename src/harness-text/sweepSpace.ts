import type { ThresholdName, Thresholds } from '../core/thresholds';

/** The thresholds an automated sweep may move; the rest (retry count, stub sharpness, timeout, price) are fixed. */
export const SWEEPABLE: readonly ThresholdName[] = [
  'GATE_ADDRESSED', 'GATE_INTELLIGIBLE', 'GATE_COMPLETE', 'GATE_WANTS_HUMAN',
  'INTENT_ROUTE', 'INTENT_IMPLICIT', 'INTENT_EXPLICIT', 'INTENT_SWITCH', 'GATE_INTENT_MARGIN', 'GATE_FRUSTRATION_HIGH',
  'INTENT_TENTATIVE', 'INTENT_CHANGE', 'PROVIDER_UNSURE', 'SLOT_CHANGE', 'INTENT_SECOND',
  'SLOT_DETECT', 'SLOT_CHOICE_FILL', 'SLOT_CHOICE_CONFIRM', 'SLOT_CHOICE_MARGIN', 'SLOT_HELP', 'TIME_OF_DAY', 'TIME_PREFERENCE',
  'CONFIRM_YES', 'CONFIRM_NO', 'MENU_NUMBER',
];

/**
 * Thresholds the sweep will not touch on its own, each with the judgment that took it out. They
 * stay in `SWEEPABLE` so `--only` can still sweep one deliberately, and every report lists them
 * with their reason, so an exclusion is visible rather than a silent gap in the table.
 */
export const EXCLUDED: Partial<Record<ThresholdName, string>> = {
  GATE_WANTS_HUMAN: 'handoff gate; the recording has no wants-human evidence between 0.10 and 0.70 except the word "Agent", so a recommended drop is a safety change, not tuning',
};

const MARGINS: ReadonlySet<ThresholdName> = new Set(['GATE_INTENT_MARGIN', 'SLOT_CHOICE_MARGIN']);

function range(lo: number, hi: number, step: number): number[] {
  const n = Math.round((hi - lo) / step) + 1;
  return Array.from({ length: n }, (_, i) => Math.round((lo + i * step) * 100) / 100);
}

const PROBABILITY_GRID: readonly number[] = range(0.05, 0.95, 0.05);
const MARGIN_GRID: readonly number[] = range(0.05, 0.4, 0.05);

export function gridFor(name: ThresholdName): readonly number[] {
  return MARGINS.has(name) ? MARGIN_GRID : PROBABILITY_GRID;
}

/**
 * lower <= upper, in the order the bands are read. `INTENT_ROUTE <= INTENT_SWITCH` because
 * abandoning a form already in progress must need at least the confidence of starting one;
 * `INTENT_IMPLICIT <= INTENT_SWITCH` then follows transitively from the route bound.
 */
export const CONSTRAINTS: ReadonlyArray<{ lower: ThresholdName; upper: ThresholdName }> = [
  { lower: 'INTENT_EXPLICIT', upper: 'INTENT_IMPLICIT' },
  { lower: 'INTENT_IMPLICIT', upper: 'INTENT_ROUTE' },
  { lower: 'INTENT_ROUTE', upper: 'INTENT_SWITCH' },
  { lower: 'SLOT_CHOICE_CONFIRM', upper: 'SLOT_CHOICE_FILL' },
];

/** The first violated constraint as "A <= B", or null when the set is allowed. */
export function violated(t: Thresholds): string | null {
  for (const c of CONSTRAINTS) if (t[c.lower] > t[c.upper]) return `${c.lower} <= ${c.upper}`;
  return null;
}

function isSweepable(name: string): name is ThresholdName {
  return (SWEEPABLE as readonly string[]).includes(name);
}

/** The --only list, or every sweepable threshold that is not `EXCLUDED` when absent. An explicit
 * --only may still name an excluded threshold: the exclusion is a default, not a ban. Repeats are
 * dropped (sweeping one threshold twice in a pass only re-runs cached evaluations); the first
 * occurrence sets the order. */
export function parseOnly(spec: string | undefined): ThresholdName[] {
  if (spec === undefined || spec.trim() === '') return SWEEPABLE.filter((n) => !(n in EXCLUDED));
  const out: ThresholdName[] = [];
  for (const raw of spec.split(',')) {
    const name = raw.trim();
    if (name === '') continue;
    if (!isSweepable(name)) throw new Error(`${name} is not sweepable; choose from ${SWEEPABLE.join(', ')}`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
