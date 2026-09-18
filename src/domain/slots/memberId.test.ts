import { describe, expect, it } from 'vitest';
import { memberIdSlot } from './memberId';
import type { SlotContext } from './types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { candidateSpans } from '../../core/spans';
import { choice, noul } from '../../testing/answers';

function ctx(text: string): SlotContext {
  return { text, candidateSpans: candidateSpans(text), todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, window: null };
}

describe('memberIdSlot', () => {
  it('asks three questions with the spans as choice criteria', () => {
    const q = memberIdSlot.questions(ctx('it is four four seven'));
    expect(Object.keys(q)).toEqual(['containsMemberId', 'memberIdSpan', 'memberIdComplete']);
    const span = q.memberIdSpan!;
    expect(span.type).toBe('choice');
    if (span.type === 'choice') {
      expect(Object.keys(span.criteria)).toContain('four four seven');
      expect(Object.keys(span.criteria)).toContain('none');
    }
  });

  it('fills when detected, complete, and the span normalizes to eight digits', () => {
    const c = ctx('my id is four four seven one eight two nine three');
    const out = memberIdSlot.fill(
      {
        containsMemberId: noul(0.95),
        memberIdSpan: choice({ 'four four seven one eight two nine three': 0.9, none: 0.1 }),
        memberIdComplete: noul(0.9),
      },
      c,
    );
    expect(out).toEqual({
      kind: 'filled', value: '44718293', display: '4471 8293', confidence: 0.9, confirm: 'implicit',
    });
  });

  it('is absent when not detected', () => {
    const out = memberIdSlot.fill(
      { containsMemberId: noul(0.1), memberIdSpan: choice({ none: 1 }), memberIdComplete: noul(0.5) },
      ctx('I want to cancel'),
    );
    expect(out).toEqual({ kind: 'absent' });
  });

  it('is invalid when detected but the digits do not match the mask', () => {
    const out = memberIdSlot.fill(
      { containsMemberId: noul(0.9), memberIdSpan: choice({ 'four four seven': 0.9, none: 0.1 }), memberIdComplete: noul(0.9) },
      ctx('it is four four seven'),
    );
    expect(out).toMatchObject({ kind: 'invalid', reason: 'mask', raw: '447' });
  });

  it('is invalid when detected but incomplete', () => {
    const out = memberIdSlot.fill(
      { containsMemberId: noul(0.9), memberIdSpan: choice({ 'four four': 0.9, none: 0.1 }), memberIdComplete: noul(0.2) },
      ctx('it is four four'),
    );
    expect(out).toMatchObject({ kind: 'invalid', reason: 'incomplete' });
  });

  it('parses eight dtmf digits', () => {
    expect(memberIdSlot.dtmf.parse('44718293', ctx(''))).toEqual({ value: '44718293', display: '4471 8293' });
    expect(memberIdSlot.dtmf.parse('4471829#', ctx(''))).toBeNull();
  });
});
