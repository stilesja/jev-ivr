import { describe, expect, it } from 'vitest';
import { buildThresholds, corpusFileOf, DEFAULT_CORPUS_FILE, resolveTodayIso } from './cli';
import { defaultTimeZone, localDateIso } from '../run/clock';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

describe('buildThresholds', () => {
  it('applies an override and leaves the rest at their defaults', () => {
    const t = buildThresholds(['INTENT_ROUTE=0.5']);
    expect(t.INTENT_ROUTE).toBe(0.5);
    expect(t.INTENT_IMPLICIT).toBe(DEFAULT_THRESHOLDS.INTENT_IMPLICIT);
  });

  it('returns the defaults when nothing is overridden', () => {
    expect(buildThresholds([])).toEqual({ ...DEFAULT_THRESHOLDS });
  });

  it('throws on an unknown threshold name', () => {
    expect(() => buildThresholds(['NOT_A_THRESHOLD=0.5'])).toThrow(/unknown threshold/);
  });
});

describe('resolveTodayIso', () => {
  it('uses the given date whether it came from --today VALUE or --today=VALUE', () => {
    expect(resolveTodayIso('2026-01-01')).toBe('2026-01-01');
  });

  it('falls back to the host wall-clock date, not the UTC one, when --today was never passed', () => {
    expect(resolveTodayIso(undefined)).toBe(localDateIso(Date.now(), defaultTimeZone()));
    expect(resolveTodayIso(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('corpusFileOf', () => {
  it('prefers an explicit --corpus-file, then --corpus, then the default', () => {
    expect(corpusFileOf('a.jsonl', 'b.jsonl')).toBe('a.jsonl');
    expect(corpusFileOf(undefined, 'b.jsonl')).toBe('b.jsonl');
    expect(corpusFileOf(undefined, undefined)).toBe(DEFAULT_CORPUS_FILE);
  });
});
