import { describe, expect, it } from 'vitest';
import manifest from './manifest.json';
import { joinSpoken, seamViolations, segmentTemplate, segmentsOf, SPOKEN_VARS, type Segment } from './segments';
import { renderTemplate } from './render';

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
  it('drops a whitespace-only run between adjacent variables', () => {
    expect(segmentTemplate('r', '{a} {b}')).toEqual(segmentTemplate('r', '{a}{b}'));
  });
  it('leaves non-placeholder braces as fixed text', () => {
    expect(segmentTemplate('t', 'A {} b { x } c {a}.')).toEqual([
      { kind: 'fixed', id: 't.0', text: 'A {} b { x } c' },
      { kind: 'var', name: 'a' },
      { kind: 'fixed', id: 't.1', text: '.' },
    ]);
  });
});

describe('joinSpoken', () => {
  it('joins pieces with a single space, no space before punctuation, and skips empty pieces', () => {
    expect(joinSpoken(['With', 'Dr. Chen', '.'])).toBe('With Dr. Chen.');
    expect(joinSpoken(['next week', '. Which day works for you?'])).toBe('next week. Which day works for you?');
    expect(joinSpoken(['a', '', 'b'])).toBe('a b');
  });
  it('reproduces renderTemplate for every manifest template, given the same vars', () => {
    const vars: Record<string, string> = {
      provider: 'Dr. Chen',
      intentLabel: 'check on a bill',
      window: 'next week',
      memberId: '4471 8293',
      date: 'Tuesday, September 22',
      a: 'Dr. Chen',
      b: 'Dr. Cheng',
    };
    const lookup = (name: string): string => {
      const v = vars[name];
      if (v === undefined) throw new Error(`test vars missing ${name}`);
      return v;
    };
    for (const [id, entry] of Object.entries(manifest)) {
      const segs = segmentTemplate(id, entry.text);
      const joined = joinSpoken(segs.map((s) => (s.kind === 'fixed' ? s.text : lookup(s.name))));
      expect(joined).toBe(renderTemplate(entry.text, vars));
    }
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

    // Every variable name in the manifest is either a spoken (TTS-only) var subject to the
    // seam rule, or a vocabulary var with a recorded clip. A typo like {memeberId} would
    // silently land in neither set and escape the seam rule, so pin the vocabulary too.
    const vocabVars = new Set(['provider', 'intentLabel', 'window', 'a', 'b']);
    const varNames = new Set<string>();
    for (const segs of Object.values(all)) {
      for (const s of segs as Segment[]) {
        if (s.kind === 'var') varNames.add(s.name);
      }
    }
    expect(varNames.size).toBeGreaterThan(0);
    for (const name of varNames) {
      expect(SPOKEN_VARS.has(name) || vocabVars.has(name)).toBe(true);
    }
  });
});
