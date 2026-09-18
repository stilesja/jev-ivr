import { describe, expect, it } from 'vitest';
import { buildClient, buildThresholds, corpusFileOf, DEFAULT_CORPUS_FILE } from './cli';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import type { QuestionMap } from '../jev/types';

const questions: QuestionMap = {
  intent: { type: 'choice', instructions: 'What does the caller want?', criteria: { cancel: null, none: null } },
};

const state = { asr: { text: 'zzz qqq wwww', isFinal: true }, activeForm: null };

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

describe('corpusFileOf', () => {
  it('prefers an explicit --corpus-file, then --corpus, then the default', () => {
    expect(corpusFileOf('a.jsonl', 'b.jsonl')).toBe('a.jsonl');
    expect(corpusFileOf(undefined, 'b.jsonl')).toBe('b.jsonl');
    expect(corpusFileOf(undefined, undefined)).toBe(DEFAULT_CORPUS_FILE);
  });
});

describe('buildClient', () => {
  const t = buildThresholds([]);

  it('builds a heuristic client that answers from keywords', async () => {
    const r = await buildClient('heuristic', DEFAULT_CORPUS_FILE, t).ask({ state, questions });
    expect(r.source).toBe('stub:heuristic');
    expect(r.answers.intent).toBeDefined();
  });

  it('builds a fixture-backed stub client keyed on the corpus file', async () => {
    const client = buildClient('stub', DEFAULT_CORPUS_FILE, t);
    const corpusText = loadCorpus(DEFAULT_CORPUS_FILE)[0]!.text;
    const keyed = await client.ask({ state: { ...state, asr: { text: corpusText, isFinal: true } }, questions });
    expect(keyed.source).toBe('stub:fixture');
    // an utterance the corpus does not label falls through to the heuristic
    const unlabelled = await client.ask({ state: { ...state, asr: { text: 'zzz qqq wwww', isFinal: true } }, questions });
    expect(unlabelled.source).toBe('stub:heuristic');
  });
});
