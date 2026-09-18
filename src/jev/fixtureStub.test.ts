import { describe, expect, it } from 'vitest';
import { FixtureStubClient } from './fixtureStub';
import { parseCorpus, normalizeText, type CorpusEntry } from './corpus';
import { HeuristicStubClient } from './heuristicStub';
import { buildQuestions } from '../core/questions';
import { newSession } from '../core/session';
import { buildTurnState } from '../core/state';
import { candidateSpans } from '../core/spans';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { JevClientError } from './types';

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
  const questions = buildQuestions(session, { text, candidateSpans: candidateSpans(text), todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, window: null });
  return { state: state as never, questions };
}

describe('parseCorpus', () => {
  it('parses JSONL, skips blank lines and rejects duplicate ids', () => {
    const text = JSON.stringify(entries[0]) + '\n\n' + JSON.stringify(entries[1]) + '\n';
    expect(parseCorpus(text).map((e) => e.id)).toEqual(['r1', 'm1']);
    expect(() => parseCorpus(text + JSON.stringify(entries[0]))).toThrow(/duplicate/);
  });
  it('normalizes text for lookup', () => {
    expect(normalizeText('Reschedule, with Dr. Chen!')).toBe('reschedule with dr chen');
  });

  it('parseCorpus rejects an unknown context and duplicate normalized text', () => {
    const badContext = { ...entries[0], context: 'not_a_form' };
    expect(() => parseCorpus(JSON.stringify(badContext))).toThrow(/unknown context/);

    const dup = { ...entries[0], id: 'r1-dup', text: 'Reschedule, with Dr. Chen next week!' };
    const text = JSON.stringify(entries[0]) + '\n' + JSON.stringify(dup);
    expect(() => parseCorpus(text)).toThrow(/duplicates/);
  });
});

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
});
