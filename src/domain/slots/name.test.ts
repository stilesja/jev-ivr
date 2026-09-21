import { describe, expect, it } from 'vitest';
import { nameSlot, titleCase } from './name';
import { choice, noul } from '../../testing/answers';
import { candidateSpans, candidateWordSpans } from '../../core/spans';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { EXCLUDED_NAME_TOKENS } from './index';

const ctx = (text: string) => ({ text, candidateSpans: candidateSpans(text), candidateWordSpans: candidateWordSpans(text), todayIso: '2026-09-18', thresholds: DEFAULT_THRESHOLDS, window: null, excludedNameTokens: EXCLUDED_NAME_TOKENS });

const spanKeys = (text: string) => Object.keys((nameSlot.questions(ctx(text)).nameSpan as { criteria: Record<string, string | null> }).criteria);

describe('nameSlot', () => {
  it('asks for a name check and a span choice over the word candidates', () => {
    const q = nameSlot.questions(ctx('my name is Jason Stiles'));
    expect(q.nameGiven?.type).toBe('noul');
    expect(Object.keys((q.nameSpan as { criteria: Record<string, unknown> }).criteria)).toEqual([...candidateWordSpans('my name is Jason Stiles'), 'none']);
  });
  it('fills the chosen span, title-cased for display, silently', () => {
    const r = nameSlot.fill({ nameGiven: noul(0.95), nameSpan: choice({ 'jason stiles': 0.9, none: 0.1 }) }, ctx('my name is Jason Stiles'));
    expect(r).toMatchObject({ kind: 'filled', value: 'jason stiles', display: 'Jason Stiles', confirm: 'none' });
  });
  it('accepts a single-word name', () => {
    const r = nameSlot.fill({ nameGiven: noul(0.9), nameSpan: choice({ cher: 0.9, none: 0.1 }) }, ctx('it\'s Cher'));
    expect(r).toMatchObject({ kind: 'filled', display: 'Cher' });
  });
  it('is absent below the detect threshold and invalid when no span is chosen', () => {
    expect(nameSlot.fill({ nameGiven: noul(0.2), nameSpan: choice({ none: 1 }) }, ctx('x')).kind).toBe('absent');
    expect(nameSlot.fill({ nameGiven: noul(0.9), nameSpan: choice({ none: 0.9, x: 0.1 }) }, ctx('x'))).toMatchObject({ kind: 'invalid', reason: 'no_span' });
  });
  it('does not let a literal "none" word span collide with the sentinel', () => {
    const q = nameSlot.questions(ctx('none of your business'));
    const criteria = (q.nameSpan as { criteria: Record<string, string | null> }).criteria;
    expect(candidateWordSpans('none of your business')).toContain('none');
    expect(criteria.none).toMatch(/caller/);
  });
  it('never offers a span that contains a provider name', () => {
    // The whole correction is candidate material -- "not chen cheng", "chen cheng", "cheng" --
    // and the doctor being corrected is not the caller. Only the leftover "not" survives.
    expect(candidateWordSpans('not Chen, Cheng')).toEqual(['not', 'not chen', 'not chen cheng', 'chen', 'chen cheng', 'cheng']);
    expect(spanKeys('not Chen, Cheng')).toEqual(['not', 'none']);
  });
  it('keeps the caller\'s own name in an utterance that also names the doctor', () => {
    const keys = spanKeys('this is Jason Stiles, seeing Dr. Chen');
    expect(keys).toContain('jason stiles');
    expect(keys).not.toContain('dr chen');
    expect(keys).not.toContain('chen');
    expect(keys.filter((k) => k.split(' ').some((w) => w === 'dr' || w === 'doctor'))).toEqual([]);
  });
  it('leaves a caller whose surname is no provider untouched', () => {
    const text = 'my name is Dana Whitfield';
    expect(spanKeys(text)).toEqual([...candidateWordSpans(text), 'none']);
  });
  it('refuses a chosen span that the criteria never offered', () => {
    // Defensive: a cassette recorded before the exclusion can still hand back an excluded span.
    const r = nameSlot.fill({ nameGiven: noul(0.9), nameSpan: choice({ 'chen cheng': 0.8, not: 0.2 }) }, ctx('not Chen, Cheng'));
    expect(r).toMatchObject({ kind: 'invalid', reason: 'no_span' });
  });
  it('has no keypad rung', () => { expect(nameSlot.dtmf).toBeUndefined(); expect(nameSlot.spokenConfirm).toBe('summary'); });
  it('title-cases each word', () => { expect(titleCase('mary kate o neil')).toBe('Mary Kate O Neil'); });
});
