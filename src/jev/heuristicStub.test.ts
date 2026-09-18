import { describe, expect, it } from 'vitest';
import { HeuristicStubClient } from './heuristicStub';
import { sharp } from './distributions';
import { buildQuestions } from '../core/questions';
import { newSession } from '../core/session';
import { buildTurnState } from '../core/state';
import { candidateSpans } from '../core/spans';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { isChoice, isNoul, isScore, rankProbabilities } from './types';

async function ask(text: string) {
  const session = newSession('s', 0);
  const state = buildTurnState(session, { text, isFinal: true, dtmf: null }, 0);
  const questions = buildQuestions(session, { text, candidateSpans: candidateSpans(text), todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, window: null });
  const res = await new HeuristicStubClient().ask({ state: state as never, questions });
  expect(Object.keys(res.answers).sort()).toEqual(Object.keys(questions).sort());
  return res;
}

describe('sharp', () => {
  it('gives the winner the sharpness and spreads the rest', () => {
    expect(sharp(['a', 'b', 'c'], 'b', 0.9)).toEqual({ a: 0.05, b: 0.9, c: 0.05 });
  });
});

describe('HeuristicStubClient', () => {
  it('answers every question with the right type', async () => {
    const res = await ask('I need to reschedule with dr chen next week');
    expect(isChoice(res.answers.intent)).toBe(true);
    expect(isScore(res.answers.frustration)).toBe(true);
    expect(isNoul(res.answers.intelligible)).toBe(true);
    expect(res.source).toBe('stub:heuristic');
    expect(res.usage.estimated).toBe(true);
  });

  it('guesses intent, provider and date window from keywords', async () => {
    const res = await ask('I need to reschedule with dr chen next week');
    expect(rankProbabilities((res.answers.intent as never as { probabilities: Record<string, number> }).probabilities)[0]?.label).toBe('reschedule');
    expect((res.answers.provider as { choice: string }).choice).toBe('chen');
    expect((res.answers.dateMode as { choice: string }).choice).toBe('window');
    expect((res.answers.dateWindow as { choice: string }).choice).toBe('next_week');
  });

  it('detects a spoken member id and picks the eight-digit span', async () => {
    const res = await ask('my id is four four seven one eight two nine three');
    expect((res.answers.containsMemberId as { noul: number }).noul).toBeGreaterThan(0.8);
    expect((res.answers.memberIdSpan as { choice: string }).choice).toBe('four four seven one eight two nine three');
  });

  it('flags a request for a human', async () => {
    const res = await ask('just let me talk to a person');
    expect((res.answers.wantsHuman as { noul: number }).noul).toBeGreaterThan(0.8);
  });
});
