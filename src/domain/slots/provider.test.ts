import { describe, expect, it } from 'vitest';
import { providerSlot } from './provider';
import type { SlotContext } from './types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { choice } from '../../testing/answers';

const ctx: SlotContext = { text: '', candidateSpans: [], todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS } };

describe('providerSlot', () => {
  it('asks one choice question over the roster plus none', () => {
    const q = providerSlot.questions(ctx).provider!;
    expect(q.type).toBe('choice');
    if (q.type === 'choice') {
      expect(Object.keys(q.criteria)).toEqual(['chen', 'cheng', 'patel', 'okafor', 'nguyen', 'rossi', 'kim', 'alvarez', 'none']);
    }
  });

  it('fills silently above the fill band', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.91, cheng: 0.05, none: 0.04 }) }, ctx))
      .toEqual({ kind: 'filled', value: 'chen', display: 'Dr. Chen', confidence: 0.91, confirm: 'none' });
  });

  it('fills with implicit confirm in the confirm band', () => {
    expect(providerSlot.fill({ provider: choice({ patel: 0.55, none: 0.45 }) }, ctx))
      .toMatchObject({ kind: 'filled', value: 'patel', confirm: 'implicit' });
  });

  it('disambiguates a narrow margin between two providers', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.48, cheng: 0.42, none: 0.1 }) }, ctx))
      .toEqual({ kind: 'disambiguate', a: { value: 'chen', display: 'Dr. Chen' }, b: { value: 'cheng', display: 'Dr. Cheng' } });
  });

  it('is absent when none wins or the top is below the confirm band', () => {
    expect(providerSlot.fill({ provider: choice({ none: 0.8, chen: 0.2 }) }, ctx)).toEqual({ kind: 'absent' });
    expect(providerSlot.fill({ provider: choice({ chen: 0.3, kim: 0.1, none: 0.6 }) }, ctx)).toEqual({ kind: 'absent' });
  });

  it('parses a dtmf menu digit', () => {
    expect(providerSlot.dtmf.parse('3', ctx)).toEqual({ value: 'patel', display: 'Dr. Patel' });
    expect(providerSlot.dtmf.parse('9', ctx)).toBeNull();
  });
});
