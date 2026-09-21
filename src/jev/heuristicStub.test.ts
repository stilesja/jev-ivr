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

  it('spots a spoken name and picks the span after the marker', async () => {
    const res = await ask("it's Jason Stiles");
    expect((res.answers.nameGiven as { noul: number }).noul).toBeGreaterThan(0.8);
    expect((res.answers.nameSpan as { choice: string }).choice).toBe('jason stiles');
    const plain = await ask('Jason Stiles');
    expect((plain.answers.nameGiven as { noul: number }).noul).toBeGreaterThan(0.8);
    expect((plain.answers.nameSpan as { choice: string }).choice).toBe('jason stiles');
    const digits = await ask('four four seven one eight two nine three');
    expect((digits.answers.nameGiven as { noul: number }).noul).toBeLessThan(0.2);
    expect((digits.answers.nameSpan as { choice: string }).choice).toBe('none');
  });

  it('reads a birthday, and a year alone as the answer to the year question', async () => {
    const res = await ask('March fifth nineteen eighty');
    expect((res.answers.dobGiven as { noul: number }).noul).toBeGreaterThan(0.8);
    expect((res.answers.dobMonth as { choice: string }).choice).toBe('march');
    expect((res.answers.dobDay as { choice: string }).choice).toBe('5');
    expect((res.answers.dobYear as { choice: string }).choice).toBe('nineteen eighty');
    const spelledOut = await ask('the fifth of March, 1980');
    expect((spelledOut.answers.dobDay as { choice: string }).choice).toBe('5');
    expect((spelledOut.answers.dobYear as { choice: string }).choice).toBe('1980');
    const yearAlone = await ask('nineteen eighty');
    expect((yearAlone.answers.dobGiven as { noul: number }).noul).toBeGreaterThan(0.8);
    expect((yearAlone.answers.dobYear as { choice: string }).choice).toBe('nineteen eighty');
    // A member ID is a long string of number words, not a birth year said on its own.
    const id = await ask('four four seven one eight two nine three');
    expect((id.answers.dobGiven as { noul: number }).noul).toBeLessThan(0.2);
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
