import { describe, expect, it } from 'vitest';
import { providerSlot } from './provider';
import type { SlotContext } from './types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { choice, noul } from '../../testing/answers';
import { EXCLUDED_NAME_TOKENS } from './index';

const ctx: SlotContext = { text: '', candidateSpans: [], candidateWordSpans: [], todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, window: null, excludedNameTokens: EXCLUDED_NAME_TOKENS };

describe('providerSlot', () => {
  it('asks the roster choice plus an unsure question', () => {
    const q = providerSlot.questions(ctx);
    expect(q.provider?.type).toBe('choice');
    if (q.provider?.type === 'choice') expect(Object.keys(q.provider.criteria)).toEqual(['chen', 'cheng', 'patel', 'okafor', 'nguyen', 'rossi', 'kim', 'alvarez', 'none']);
    expect(q.providerUnsure?.type).toBe('noul');
  });

  it('fills silently above the fill band', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.91, cheng: 0.05, none: 0.04 }) }, ctx))
      .toEqual({ kind: 'filled', value: 'chen', display: 'Dr. Chen', confidence: 0.91, confirm: 'none' });
  });

  it('fills with implicit confirm in the confirm band', () => {
    // 0.47 sits inside the implicit-confirm band [SLOT_CHOICE_CONFIRM, SLOT_CHOICE_FILL); mass is split three ways so `none` is not the argmax
    expect(providerSlot.fill({ provider: choice({ patel: 0.47, none: 0.44, okafor: 0.09 }) }, ctx))
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

  it('asks the name-status choice with neither first', () => {
    const q = providerSlot.questions(ctx);
    expect(q.providerNameStatus?.type).toBe('choice');
    if (q.providerNameStatus?.type === 'choice') expect(Object.keys(q.providerNameStatus.criteria)).toEqual(['neither', 'has_name', 'no_name']);
  });

  it('asks for help when no provider is named and the caller says whether they know the name', () => {
    const none = choice({ none: 0.9, chen: 0.1 });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ no_name: 0.8, neither: 0.15, has_name: 0.05 }) }, ctx)).toEqual({ kind: 'help', promptId: 'provider_list' });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ has_name: 0.7, neither: 0.2, no_name: 0.1 }) }, ctx)).toEqual({ kind: 'help', promptId: 'ask_provider_name' });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ no_name: 0.5, neither: 0.5 }) }, ctx)).toEqual({ kind: 'absent' });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ neither: 0.9, no_name: 0.1 }) }, ctx)).toEqual({ kind: 'absent' });
    expect(providerSlot.fill({ provider: none }, ctx)).toEqual({ kind: 'absent' });
  });

  it('lets a named provider win over the status', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.9, none: 0.1 }), providerNameStatus: choice({ has_name: 0.9, neither: 0.1 }) }, ctx))
      .toMatchObject({ kind: 'filled', value: 'chen' });
  });

  it('parses a dtmf menu digit', () => {
    expect(providerSlot.dtmf!.parse('3', ctx)).toEqual({ value: 'patel', display: 'Dr. Patel' });
    expect(providerSlot.dtmf!.parse('9', ctx)).toBeNull();
  });

  it('confirms implicitly when the caller is unsure, whatever the probability', () => {
    expect(providerSlot.fill({ provider: choice({ kim: 0.98, none: 0.02 }), providerUnsure: noul(0.9) }, ctx))
      .toMatchObject({ kind: 'filled', value: 'kim', confirm: 'implicit' });
  });

  it('disambiguates a narrow margin even when the caller is unsure', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.5, cheng: 0.46, none: 0.04 }), providerUnsure: noul(0.9) }, ctx))
      .toMatchObject({ kind: 'disambiguate', a: { value: 'chen' }, b: { value: 'cheng' } });
    expect(providerSlot.fill({ provider: choice({ chen: 0.8, cheng: 0.15, none: 0.05 }), providerUnsure: noul(0.9) }, ctx))
      .toMatchObject({ kind: 'filled', value: 'chen', confirm: 'implicit' });
  });

  it('reads the providerUnsure threshold, not mere presence', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.91, none: 0.09 }), providerUnsure: noul(0.3) }, ctx))
      .toMatchObject({ kind: 'filled', value: 'chen', confirm: 'none' });
  });

  it('treats providerUnsure at exactly the threshold as unsure', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.91, none: 0.09 }), providerUnsure: noul(0.5) }, ctx))
      .toMatchObject({ kind: 'filled', value: 'chen', confirm: 'implicit' });
  });

  it('stays absent when unsure but none wins', () => {
    expect(providerSlot.fill({ provider: choice({ none: 0.8, chen: 0.2 }), providerUnsure: noul(0.9) }, ctx))
      .toEqual({ kind: 'absent' });
  });

  it('stays absent when unsure but the top is below the confirm band', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.3, none: 0.6 }), providerUnsure: noul(0.9) }, ctx))
      .toEqual({ kind: 'absent' });
  });
});
