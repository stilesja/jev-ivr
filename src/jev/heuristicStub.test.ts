import { describe, expect, it } from 'vitest';
import { HeuristicStubClient } from './heuristicStub';
import { sharp } from './distributions';
import { buildQuestions } from '../core/questions';
import { newSession } from '../core/session';
import { buildTurnState } from '../core/state';
import { candidateSpans, candidateWordSpans } from '../core/spans';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { isChoice, isNoul, isScore, rankProbabilities } from './types';

async function ask(text: string, todayIso = '2026-09-18') {
  const session = newSession('s', 0);
  const state = buildTurnState(session, { text, isFinal: true, dtmf: null }, 0);
  const questions = buildQuestions(session, { text, candidateSpans: candidateSpans(text), candidateWordSpans: candidateWordSpans(text), todayIso, thresholds: { ...DEFAULT_THRESHOLDS }, window: null });
  const res = await new HeuristicStubClient({ todayIso }).ask({ state: state as never, questions });
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

  it('does not read a marker phrase that introduces a reason as a name', async () => {
    // "this is" / "it's" introduces a name only when a name is what follows: up to four words
    // (MAX_WORD_NGRAM) with nothing in them that belongs around a name rather than in it.
    for (const text of ['this is regarding a scheduling issue', 'this is about my bill', 'this is dr chen calling']) {
      const res = await ask(text);
      expect([text, (res.answers.nameGiven as { noul: number }).noul]).toEqual([text, 0.05]);
      expect((res.answers.nameSpan as { choice: string }).choice).toBe('none');
    }
  });

  it('takes a four-token name whole, as the span generator offers it', async () => {
    // tokenize() strips the hyphen and the apostrophe, so "Mary-Kate O'Neil" is four tokens and
    // candidateWordSpans emits it as one span (MAX_WORD_NGRAM is 4). A shorter cap here would
    // take the longest accepted prefix instead and fill the name with "mary kate o".
    const res = await ask("this is Mary-Kate O'Neil");
    expect((res.answers.nameGiven as { noul: number }).noul).toBeGreaterThan(0.8);
    expect((res.answers.nameSpan as { choice: string }).choice).toBe('mary kate o neil');
  });

  it('excludes "born" and a month name from a name span', async () => {
    // Without those words in NON_NAME_WORDS, the four-token span right after "this is" --
    // "jason stiles born march" -- looked name-shaped and won over the correct two-token span.
    const res = await ask("I need to reschedule my appointment with Dr. Chen next week, this is Jason Stiles, born March 5th 1980");
    expect((res.answers.nameSpan as { choice: string }).choice).toBe('jason stiles');
  });

  it('reads a name said in the same breath as a member id', async () => {
    const res = await ask('my name is Jason Stiles, member 4471 8293');
    expect((res.answers.nameGiven as { noul: number }).noul).toBeGreaterThan(0.8);
    expect((res.answers.nameSpan as { choice: string }).choice).toBe('jason stiles');
    // Digits are still no name on their own: no marker, and a digit token is never a word span.
    const bare = await ask('4471 8293');
    expect((bare.answers.nameGiven as { noul: number }).noul).toBeLessThan(0.2);
  });

  it('treats an explicit year as a birthday whether or not the year is in the past', async () => {
    // The gate is "a year was said", not "a year a caller could be born in": an appointment date
    // is spoken without one, so a year means the dob questions own the utterance either way.
    const past = await ask('can i come in on december 25th 2026');
    expect((past.answers.dateMode as { choice: string }).choice).toBe('none');
    const future = await ask('december 25th 2030');
    expect((future.answers.dateMode as { choice: string }).choice).toBe('none');
    // No year, so the date is read as one.
    const noYear = await ask('can i come in on december 25th');
    expect((noYear.answers.dateMode as { choice: string }).choice).toBe('absolute');
  });

  it('reads a birth year against the run\'s pinned date, not the wall clock', async () => {
    // 2030 is not a year anyone has been born in yet, until it is: the run's date decides,
    // so the same utterance answers the same way however long after the run it is replayed.
    const before = await ask('2030', '2026-09-18');
    expect((before.answers.dobYear as { choice: string }).choice).toBe('none');
    const after = await ask('2030', '2031-01-01');
    expect((after.answers.dobYear as { choice: string }).choice).toBe('2030');
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
