import { describe, expect, it } from 'vitest';
import { diff } from './regressDiff';

describe('diff', () => {
  it('reports an id only in expected as removed', () => {
    expect(diff('corpus', { a: { v: 1 } }, {})).toEqual({ lines: ['- corpus a: removed'], matching: 0 });
  });

  it('reports an id only in actual as new', () => {
    expect(diff('corpus', {}, { a: { v: 1 } })).toEqual({ lines: ['+ corpus a: new'], matching: 0 });
  });

  it('reports one line per changed key', () => {
    expect(diff('corpus', { a: { v: 'a' } }, { a: { v: 'b' } })).toEqual({
      lines: ['~ corpus a.v: "a" -> "b"'],
      matching: 0,
    });
  });

  it('counts an identical entry as matching and emits no line', () => {
    expect(diff('corpus', { a: { v: 1 } }, { a: { v: 1 } })).toEqual({ lines: [], matching: 1 });
  });
});
