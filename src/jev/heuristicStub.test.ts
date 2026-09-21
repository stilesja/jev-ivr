import { describe, expect, it } from 'vitest';
import { HeuristicStubClient } from './heuristicStub';
import { sharp } from './distributions';
import { buildQuestions } from '../core/questions';
import { newSession } from '../core/session';
import { buildTurnState } from '../core/state';
import { candidateSpans, candidateWordSpans } from '../core/spans';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { isChoice, isNoul, isScore, rankProbabilities } from './types';

async function ask(text: string) {
  const session = newSession('s', 0);
  const state = buildTurnState(session, { text, isFinal: true, dtmf: null }, 0);
  const questions = buildQuestions(session, { text, candidateSpans: candidateSpans(text), candidateWordSpans: candidateWordSpans(text), todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, window: null });
  const res = await new HeuristicStubClient().ask({ state: state as never, questions });
  expect(Object.keys(res.answers).sort()).toEqual(Object.keys(questions).sort());
  return res;
}

describe('date components', () => {
  it('reads "tuesday of next week" as a weekday, not a window', async () => {
    const res = await ask('can you move it to tuesday of next week');
    expect(res.answers.dateMode).toMatchObject({ choice: 'weekday' });
    expect(res.answers.dateWeekdayQualifier).toMatchObject({ choice: 'next' });
    expect(res.answers.dateWeekday).toMatchObject({ choice: 'tuesday' });
  });
});

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

  it('picks the full chunked span, not a truncated prefix that also masks to eight digits', async () => {
    const res = await ask('my member id is forty four one eighty seven three hundred fifty five');
    expect((res.answers.memberIdSpan as { choice: string }).choice).toBe('forty four one eighty seven three hundred fifty five');
  });

  it('flags a request for a human', async () => {
    const res = await ask('just let me talk to a person');
    expect((res.answers.wantsHuman as { noul: number }).noul).toBeGreaterThan(0.8);
  });

  it('names a detail for changeSlot from keywords', async () => {
    const q = { changeSlot: { type: 'choice', instructions: '', criteria: { provider: null, date: null, memberId: null, none: null } } } as const;
    const pick = async (text: string) => ((await new HeuristicStubClient().ask({ state: { asr: { text } }, questions: q as never })).answers.changeSlot as { choice: string }).choice;
    expect(await pick('the day')).toBe('date');
    expect(await pick('the doctor')).toBe('provider');
    expect(await pick('my member id')).toBe('memberId');
    expect(await pick('Thursday')).toBe('none');
  });

  it('does not name memberId for changeSlot when the utterance carries a full member id', async () => {
    const q = { changeSlot: { type: 'choice', instructions: '', criteria: { provider: null, date: null, memberId: null, none: null } } } as const;
    const pick = async (text: string) => ((await new HeuristicStubClient().ask({ state: { asr: { text } }, questions: q as never })).answers.changeSlot as { choice: string }).choice;
    expect(await pick('no, my ID is four four seven one eight two nine four')).toBe('none');
    expect(await pick('my member id')).toBe('memberId');
  });
});
