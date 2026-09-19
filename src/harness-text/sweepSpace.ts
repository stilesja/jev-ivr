import type { ThresholdName, Thresholds } from '../core/thresholds';

/** The thresholds an automated sweep may move; the rest (retry count, stub sharpness, timeout, price) are fixed. */
export const SWEEPABLE: readonly ThresholdName[] = [
  'GATE_ADDRESSED', 'GATE_INTELLIGIBLE', 'GATE_COMPLETE', 'GATE_WANTS_HUMAN',
  'INTENT_ROUTE', 'INTENT_IMPLICIT', 'INTENT_EXPLICIT', 'INTENT_SWITCH', 'GATE_INTENT_MARGIN', 'GATE_FRUSTRATION_HIGH',
  'INTENT_TENTATIVE', 'INTENT_CHANGE', 'PROVIDER_UNSURE',
  'SLOT_DETECT', 'SLOT_CHOICE_FILL', 'SLOT_CHOICE_CONFIRM', 'SLOT_CHOICE_MARGIN',
  'CONFIRM_YES', 'CONFIRM_NO', 'MENU_NUMBER',
];

const MARGINS: ReadonlySet<ThresholdName> = new Set(['GATE_INTENT_MARGIN', 'SLOT_CHOICE_MARGIN']);

function range(lo: number, hi: number, step: number): number[] {
  const n = Math.round((hi - lo) / step) + 1;
  return Array.from({ length: n }, (_, i) => Math.round((lo + i * step) * 100) / 100);
}

export const PROBABILITY_GRID: readonly number[] = range(0.05, 0.95, 0.05);
export const MARGIN_GRID: readonly number[] = range(0.05, 0.4, 0.05);

export function gridFor(name: ThresholdName): readonly number[] {
  return MARGINS.has(name) ? MARGIN_GRID : PROBABILITY_GRID;
}

/** lower <= upper, in the order the bands are read. */
export const CONSTRAINTS: ReadonlyArray<{ lower: ThresholdName; upper: ThresholdName }> = [
  { lower: 'INTENT_EXPLICIT', upper: 'INTENT_IMPLICIT' },
  { lower: 'INTENT_IMPLICIT', upper: 'INTENT_ROUTE' },
  { lower: 'INTENT_IMPLICIT', upper: 'INTENT_SWITCH' },
  { lower: 'SLOT_CHOICE_CONFIRM', upper: 'SLOT_CHOICE_FILL' },
];

/** The first violated constraint as "A <= B", or null when the set is allowed. */
export function violated(t: Thresholds): string | null {
  for (const c of CONSTRAINTS) if (t[c.lower] > t[c.upper]) return `${c.lower} <= ${c.upper}`;
  return null;
}

export function isSweepable(name: string): name is ThresholdName {
  return (SWEEPABLE as readonly string[]).includes(name);
}

/** The --only list, or every sweepable threshold when absent. */
export function parseOnly(spec: string | undefined): ThresholdName[] {
  if (spec === undefined || spec.trim() === '') return [...SWEEPABLE];
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((name) => {
    if (!isSweepable(name)) throw new Error(`${name} is not sweepable; choose from ${SWEEPABLE.join(', ')}`);
    return name;
  });
}
