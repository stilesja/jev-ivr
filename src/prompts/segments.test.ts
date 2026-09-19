import { describe, expect, it } from 'vitest';
import manifest from './manifest.json';
import { seamViolations, segmentTemplate, segmentsOf, SPOKEN_VARS } from './segments';

describe('segmentTemplate', () => {
  it('splits fixed runs and variables in order, numbering fixed segments', () => {
    expect(segmentTemplate('p', 'With {provider}.')).toEqual([
      { kind: 'fixed', id: 'p.0', text: 'With' },
      { kind: 'var', name: 'provider' },
      { kind: 'fixed', id: 'p.1', text: '.' },
    ]);
  });
  it('handles leading, trailing, and adjacent variables and drops empty runs', () => {
    expect(segmentTemplate('q', '{window}. Which day works for you?')).toEqual([
      { kind: 'var', name: 'window' },
      { kind: 'fixed', id: 'q.0', text: '. Which day works for you?' },
    ]);
    expect(segmentTemplate('r', '{a}{b}')).toEqual([{ kind: 'var', name: 'a' }, { kind: 'var', name: 'b' }]);
    expect(segmentTemplate('s', 'Goodbye.')).toEqual([{ kind: 'fixed', id: 's.0', text: 'Goodbye.' }]);
  });
});

describe('seamViolations', () => {
  it('requires a spoken variable to be followed by punctuation or the end', () => {
    expect(seamViolations('x', segmentTemplate('x', 'On {date}.'))).toEqual([]);
    expect(seamViolations('x', segmentTemplate('x', 'Member ID {memberId}'))).toEqual([]);
    expect(seamViolations('x', segmentTemplate('x', 'Your date {date} is set.'))).toEqual(['x: {date} must be followed by punctuation or end the prompt']);
    expect(seamViolations('x', segmentTemplate('x', 'With {provider} on Monday.'))).toEqual([]);
  });
  it('holds across the whole manifest', () => {
    const all = segmentsOf(manifest);
    const violations = Object.entries(all).flatMap(([id, segs]) => seamViolations(id, segs));
    expect(violations).toEqual([]);
    expect(all.date_narrow_window).toEqual([{ kind: 'var', name: 'window' }, { kind: 'fixed', id: 'date_narrow_window.0', text: '. Which day works for you?' }]);
    expect(SPOKEN_VARS).toEqual(new Set(['memberId', 'date']));
  });
});
