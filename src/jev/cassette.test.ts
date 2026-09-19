import { describe, expect, it } from 'vitest';
import { canonicalJson, requestKey } from './cassette';
import type { JevRequest, QuestionMap } from './types';

const questions: QuestionMap = {
  intent: { type: 'choice', instructions: 'What does the caller want?', criteria: { cancel: null, none: null } },
  ok: { type: 'noul', instructions: 'Is it fine?' },
};

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('drops undefined-valued keys', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
  });

  it('escapes strings like JSON.stringify', () => {
    expect(canonicalJson({ t: 'a "quoted" line\n' })).toBe('{"t":"a \\"quoted\\" line\\n"}');
  });

  it('emits null for array elements JSON.stringify cannot represent, like JSON.stringify', () => {
    expect(canonicalJson([1, undefined, () => 1, 3])).toBe('[1,null,null,3]');
    expect(canonicalJson({ a: [undefined] })).toBe('{"a":[null]}');
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalJson([1, , 3])).toBe('[1,null,3]');
  });
});

describe('requestKey', () => {
  const state = { asr: { text: 'cancel my appointment', isFinal: true }, activeForm: null };

  it('is a 64-char hex sha256 that is stable under key order', () => {
    const a = requestKey({ state, questions });
    const b = requestKey({ state: { activeForm: null, asr: { isFinal: true, text: 'cancel my appointment' } }, questions });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('ignores timeoutMs and signal', () => {
    const base: JevRequest = { state, questions };
    expect(requestKey({ ...base, timeoutMs: 5, signal: new AbortController().signal })).toBe(requestKey(base));
  });

  it('changes when state or questions change', () => {
    const a = requestKey({ state, questions });
    expect(requestKey({ state: { ...state, activeForm: 'cancel' }, questions })).not.toBe(a);
    expect(requestKey({ state, questions: { ok: questions.ok! } })).not.toBe(a);
  });

  it('has a frozen digest so a canonical-form change is caught here, not as cassette misses', () => {
    expect(requestKey({ state, questions })).toBe('866aec084970efac11e63920bf5541b114742c6017a91cfe87136978a2a3b35a');
  });
});
