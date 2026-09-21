import { describe, expect, it } from 'vitest';
import { nameSlot, titleCase } from './name';
import { choice, noul } from '../../testing/answers';
import { candidateSpans, candidateWordSpans } from '../../core/spans';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';

const ctx = (text: string) => ({ text, candidateSpans: candidateSpans(text), candidateWordSpans: candidateWordSpans(text), todayIso: '2026-09-18', thresholds: DEFAULT_THRESHOLDS, window: null });

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
  it('has no keypad rung', () => { expect(nameSlot.dtmf).toBeUndefined(); expect(nameSlot.spokenConfirm).toBe('summary'); });
  it('title-cases each word', () => { expect(titleCase('mary kate o neil')).toBe('Mary Kate O Neil'); });
});
