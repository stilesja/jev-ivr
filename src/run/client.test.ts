import { describe, expect, it } from 'vitest';
import { buildClient, buildThresholds, cassettePath, DEFAULT_CORPUS_FILE, isClientKind } from './client';
import { loadCorpus } from '../jev/corpus';
import type { QuestionMap } from '../jev/types';

const questions: QuestionMap = {
  intent: { type: 'choice', instructions: 'What does the caller want?', criteria: { cancel: null, none: null } },
};

const state = { asr: { text: 'zzz qqq wwww', isFinal: true }, activeForm: null };

describe('isClientKind', () => {
  it('accepts a listed kind and rejects anything else', () => {
    expect(isClientKind('recorded')).toBe(true);
    expect(isClientKind('nope')).toBe(false);
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

  it('builds a replay-only cassette client for recorded', async () => {
    const r = buildClient('recorded', DEFAULT_CORPUS_FILE, t).ask({ state, questions });
    await expect(r).rejects.toThrow(/cassette miss/);
  });

  // Deterministic across machines only because every test that constructs jev or record
  // deletes the key first; a bare buildClient('jev') here would issue a live request from a
  // shell that has the key exported.
  it('fails fast for jev and record when no API key is set, and never needs one for recorded', () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(() => buildClient('jev', DEFAULT_CORPUS_FILE, t)).toThrow(/No API key/);
      expect(() => buildClient('record', DEFAULT_CORPUS_FILE, t)).toThrow(/No API key/);
      expect(() => buildClient('recorded', DEFAULT_CORPUS_FILE, t)).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it('throws on an unknown kind, listing the valid ones', () => {
    expect(() => buildClient('nope', DEFAULT_CORPUS_FILE, t)).toThrow(/stub, heuristic, jev, record, recorded/);
  });
});

describe('cassettePath', () => {
  it('is one file per pinned model under fixtures/recorded', () => {
    expect(cassettePath()).toBe('fixtures/recorded/jev-1.13.0.jsonl');
    expect(cassettePath('jev-2.0.0')).toBe('fixtures/recorded/jev-2.0.0.jsonl');
  });
});
