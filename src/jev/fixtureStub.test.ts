import { describe, expect, it } from 'vitest';
import { FixtureStubClient } from './fixtureStub';
import { parseCorpus, normalizeText, type CorpusEntry } from './corpus';
import { HeuristicStubClient } from './heuristicStub';
import { buildQuestions } from '../core/questions';
import { newSession } from '../core/session';
import { buildTurnState } from '../core/state';
import { candidateSpans, candidateWordSpans } from '../core/spans';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { JevClientError, noulValue, type QuestionMap } from './types';

const entries: CorpusEntry[] = [
  {
    id: 'r1', text: 'Reschedule with Dr. Chen next week', intent: 'reschedule', context: 'no_form',
    slots: { provider: 'chen', date: { mode: 'window', window: 'next_week' } },
  },
  {
    id: 'm1', text: 'four four seven one eight two nine three', intent: 'none', context: 'billing',
    slots: { memberId: { span: 'four four seven one eight two nine three', value: '44718293' } },
  },
  {
    id: 'lo', text: 'maybe cancel it', intent: 'cancel', context: 'no_form',
    answers: { intent: { probabilities: { cancel: 0.5, reschedule: 0.4 } }, utteranceComplete: { noul: 0.3 } },
  },
];

function request(text: string) {
  const session = newSession('s', 0);
  const state = buildTurnState(session, { text, isFinal: true, dtmf: null }, 0);
  const questions = buildQuestions(session, { text, candidateSpans: candidateSpans(text), candidateWordSpans: candidateWordSpans(text), todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, window: null });
  return { state: state as never, questions };
}

describe('FixtureStubClient', () => {
  const client = new FixtureStubClient(entries, { sharpness: 0.9, fallback: new HeuristicStubClient() });

  it('matches a labeled span regardless of case and punctuation', async () => {
    const caseEntries: CorpusEntry[] = [
      {
        id: 'm2', text: 'My ID is Four Four Seven One Eight Two Nine Three', intent: 'none', context: 'billing',
        slots: { memberId: { span: 'Four Four Seven One Eight Two Nine Three', value: '44718293' } },
      },
    ];
    const caseClient = new FixtureStubClient(caseEntries, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const res = await caseClient.ask(request('My ID is Four Four Seven One Eight Two Nine Three'));
    expect(res.answers.memberIdSpan).toMatchObject({ choice: normalizeText('Four Four Seven One Eight Two Nine Three') });
  });

  it('throws when a labeled span is not a candidate', async () => {
    const badEntries: CorpusEntry[] = [
      {
        id: 'm3', text: 'My ID is Four Four Seven One Eight Two Nine Three', intent: 'none', context: 'billing',
        slots: { memberId: { span: 'nine nine nine', value: '999' } },
      },
    ];
    const badClient = new FixtureStubClient(badEntries, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    await expect(badClient.ask(request('My ID is Four Four Seven One Eight Two Nine Three'))).rejects.toThrow(/not a candidate span/);
  });

  it('throws on an override naming an unknown label', async () => {
    const badEntries: CorpusEntry[] = [
      {
        id: 'bad-lo', text: 'maybe cancel it now', intent: 'cancel', context: 'no_form',
        answers: { intent: { probabilities: { reschedul: 0.8 } } },
      },
    ];
    const badClient = new FixtureStubClient(badEntries, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    await expect(badClient.ask(request('maybe cancel it now'))).rejects.toThrow(/unknown label/);
  });

  it('answers from labels with sharp distributions', async () => {
    const res = await client.ask(request('reschedule with dr chen next week'));
    expect(res.source).toBe('stub:fixture');
    expect(res.answers.intent).toMatchObject({ choice: 'reschedule', probabilities: expect.objectContaining({ reschedule: 0.9 }) });
    expect(res.answers.provider).toMatchObject({ choice: 'chen' });
    expect(res.answers.dateMode).toMatchObject({ choice: 'window' });
    expect(res.answers.dateWindow).toMatchObject({ choice: 'next_week' });
    expect(res.answers.dateMonth).toMatchObject({ choice: 'none' });
  });

  it('answers member id questions from the labeled span', async () => {
    const res = await client.ask(request('four four seven one eight two nine three'));
    expect(res.answers.containsMemberId).toMatchObject({ noul: 0.92 });
    expect(res.answers.memberIdSpan).toMatchObject({ choice: 'four four seven one eight two nine three' });
    expect(res.answers.memberIdComplete).toMatchObject({ noul: 0.9 });
  });

  it('answers the name questions from the labeled span', async () => {
    const named = parseCorpus('{"id":"nm","text":"my name is Jason Stiles","intent":"none","context":"no_form","slots":{"name":"Jason Stiles"}}\n');
    const nameClient = new FixtureStubClient(named, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const res = await nameClient.ask(request('my name is Jason Stiles'));
    expect(res.answers.nameGiven).toMatchObject({ noul: 0.92 });
    expect(res.answers.nameSpan).toMatchObject({ choice: 'jason stiles' });
    const none = await client.ask(request('four four seven one eight two nine three'));
    expect(none.answers.nameGiven).toMatchObject({ noul: 0.05 });
    expect(none.answers.nameSpan).toMatchObject({ choice: 'none' });
  });

  it('throws when a labeled name span is not a candidate', async () => {
    const badEntries: CorpusEntry[] = [
      { id: 'nm-bad', text: 'my name is Jason Stiles', intent: 'none', context: 'no_form', slots: { name: 'Mary Kate' } },
    ];
    const badClient = new FixtureStubClient(badEntries, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    await expect(badClient.ask(request('my name is Jason Stiles'))).rejects.toThrow(/not a candidate span/);
  });

  it('answers the birthday questions from the labels, with no year when none is said', async () => {
    const born = parseCorpus([
      '{"id":"db-y","text":"March fifth nineteen eighty","intent":"none","context":"no_form","slots":{"dob":{"month":"march","day":"5","year":"nineteen eighty"}}}',
      '{"id":"db-n","text":"March 5th","intent":"none","context":"no_form","slots":{"dob":{"month":"march","day":"5"}}}',
    ].join('\n'));
    const dobClient = new FixtureStubClient(born, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const full = await dobClient.ask(request('March fifth nineteen eighty'));
    expect(full.answers.dobGiven).toMatchObject({ noul: 0.92 });
    expect(full.answers.dobMonth).toMatchObject({ choice: 'march' });
    expect(full.answers.dobDay).toMatchObject({ choice: '5' });
    expect(full.answers.dobYear).toMatchObject({ choice: 'nineteen eighty' });
    const partial = await dobClient.ask(request('March 5th'));
    expect(partial.answers.dobYear).toMatchObject({ choice: 'none' });
    const none = await client.ask(request('reschedule with dr chen next week'));
    expect(none.answers.dobGiven).toMatchObject({ noul: 0.05 });
    expect(none.answers.dobMonth).toMatchObject({ choice: 'none' });
  });

  it('applies overrides and keeps distributions normalized', async () => {
    const res = await client.ask(request('maybe cancel it'));
    const intent = res.answers.intent as { probabilities: Record<string, number> };
    expect(intent.probabilities.cancel).toBeCloseTo(0.5, 2);
    expect(intent.probabilities.reschedule).toBeCloseTo(0.4, 2);
    expect(Object.values(intent.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    expect(res.answers.utteranceComplete).toEqual({ type: 'noul', noul: 0.3 });
  });

  it('falls back to the heuristic stub for unknown text', async () => {
    const res = await client.ask(request('something not in the corpus about billing'));
    expect(res.source).toBe('stub:heuristic');
  });

  it('injects failures on demand', async () => {
    const failing = new FixtureStubClient(entries, { sharpness: 0.9, fallback: new HeuristicStubClient(), injectFailure: (n) => n === 1 });
    await expect(failing.ask(request('maybe cancel it'))).rejects.toBeInstanceOf(JevClientError);
    await expect(failing.ask(request('maybe cancel it'))).resolves.toBeDefined();
  });

  it('answers the redesign questions from labels', async () => {
    const corpus = parseCorpus('{"id":"t","text":"maybe cancel it","intent":"cancel","context":"no_form","tentative":true}\n{"id":"a","text":"also my bill","intent":"billing","context":"reschedule","change":"adding"}\n{"id":"p","text":"might be kim","intent":"none","context":"cancel","prompted":"provider","slots":{"provider":"kim"},"providerUnsure":true}\n');
    const client = new FixtureStubClient(corpus, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const questions: QuestionMap = {
      intentTentative: { type: 'noul', instructions: '' },
      intentChange: { type: 'choice', instructions: '', criteria: { answering: null, adding: null, replacing: null } },
      providerUnsure: { type: 'noul', instructions: '' },
    };
    const ask = (text: string) => client.ask({ state: { asr: { text, isFinal: true } }, questions });
    expect((await ask('maybe cancel it')).answers.intentTentative).toMatchObject({ noul: 0.9 });
    expect((await ask('also my bill')).answers.intentChange).toMatchObject({ choice: 'adding' });
    expect((await ask('also my bill')).answers.intentTentative).toMatchObject({ noul: 0.05 });
    expect((await ask('maybe cancel it')).answers.intentChange).toMatchObject({ choice: 'answering' });
    expect((await ask('might be kim')).answers.providerUnsure).toMatchObject({ noul: 0.9 });
  });

  it('answers the confirm questions from confirm, changeSlot, and secondIntent labels', async () => {
    const corpus = parseCorpus([
      '{"id":"fc-1","text":"yes","intent":"none","context":"confirm_reschedule","confirm":"yes"}',
      '{"id":"fc-2","text":"no the day","intent":"none","context":"confirm_reschedule","confirm":"no","changeSlot":"date"}',
      '{"id":"fc-3","text":"reschedule and also my bill","intent":"reschedule","context":"no_form","secondIntent":"billing"}',
    ].join('\n'));
    const stubClient = new FixtureStubClient(corpus, { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const qs = {
      confirmsYes: { type: 'noul', instructions: '' },
      confirmsNo: { type: 'noul', instructions: '' },
      changeSlot: { type: 'choice', instructions: '', criteria: { provider: null, date: null, memberId: null, none: null } },
      secondIntent: {
        type: 'choice',
        instructions: '',
        criteria: { schedule_new: null, reschedule: null, cancel: null, confirm_appointment: null, billing: null, none: null },
      },
    } as const;
    const ask = async (text: string) => (await stubClient.ask({ state: { asr: { text } }, questions: qs as never })).answers;
    const a = await ask('yes');
    expect(noulValue(a, 'confirmsYes')).toBeGreaterThan(0.8);
    expect(noulValue(a, 'confirmsNo')).toBeLessThan(0.2);
    const b = await ask('no the day');
    expect(noulValue(b, 'confirmsNo')).toBeGreaterThan(0.8);
    expect((b.changeSlot as { choice: string }).choice).toBe('date');
    const c = await ask('reschedule and also my bill');
    expect((c.secondIntent as { choice: string }).choice).toBe('billing');
    expect((a.secondIntent as { choice: string }).choice).toBe('none');
  });
});
