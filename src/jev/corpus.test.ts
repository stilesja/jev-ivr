import { describe, expect, it } from 'vitest';
import { confirmForm, contextForm, loadCorpus, normalizeText, parseCorpus, type CorpusEntry } from './corpus';
import { candidateSpans, candidateWordSpans } from '../core/spans';
import { spokenToDigits } from '../core/extract/spokenNumber';
import { DATE_MODES, MONTHS, WEEKDAYS, QUALIFIERS, RELATIVE_DAYS, WINDOWS } from '../core/extract/date';
import { PROVIDERS } from '../domain/slots/provider';
import { FORM_INTENTS } from '../domain/intents';
import { ALWAYS_ON_IDS } from '../core/questions';
import { allSlots, EXCLUDED_NAME_TOKENS, type SlotContext } from '../domain/slots';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

const corpus = loadCorpus('fixtures/corpus.jsonl');

describe('fixtures/corpus.jsonl', () => {
  it('has at least 100 entries', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(100);
  });

  it('uses valid contexts', () => {
    for (const e of corpus) {
      // no_form, a form, or the confirm_ context of a form that asks a summary -- what the validator takes.
      expect(e.context === 'no_form' || contextForm(e.context) !== null, `${e.id}: ${e.context}`).toBe(true);
      if (e.prompted) expect(FORM_INTENTS, e.id).toContain(e.context);
    }
  });

  it('overrides name only questions the schema can ask', () => {
    const ctx: SlotContext = { text: '', candidateSpans: [], candidateWordSpans: [], todayIso: '2026-09-18', thresholds: DEFAULT_THRESHOLDS, window: null, excludedNameTokens: EXCLUDED_NAME_TOKENS };
    const askable = new Set<string>([...ALWAYS_ON_IDS, 'confirmsYes', 'confirmsNo', 'menuNumberSaid', 'intentChange']);
    for (const spec of allSlots()) for (const id of Object.keys(spec.questions(ctx))) askable.add(id);
    for (const e of corpus) {
      for (const id of Object.keys(e.answers ?? {})) expect([...askable], `${e.id}: ${id}`).toContain(id);
    }
  });

  it('labels member id spans that exist as candidate spans and normalize to the value', () => {
    for (const e of corpus) {
      const m = e.slots?.memberId;
      if (!m) continue;
      expect(candidateSpans(e.text), e.id).toContain(normalizeText(m.span));
      expect(spokenToDigits(m.span), e.id).toBe(m.value);
    }
  });

  it('labels name spans that exist as candidate word spans', () => {
    for (const e of corpus) {
      if (e.slots?.name === undefined) continue;
      expect(candidateWordSpans(e.text), e.id).toContain(normalizeText(e.slots.name));
    }
  });

  it('labels birthdays with month and day vocabulary and a year that is a candidate span', () => {
    const days = Array.from({ length: 31 }, (_, i) => String(i + 1));
    for (const e of corpus) {
      const d = e.slots?.dob;
      if (!d) continue;
      if (d.month !== undefined) expect(MONTHS, e.id).toContain(d.month);
      if (d.day !== undefined) expect(days, e.id).toContain(d.day);
      if (d.year !== undefined) expect(candidateSpans(e.text), e.id).toContain(normalizeText(d.year));
    }
  });

  it('labels providers from the roster', () => {
    const keys = PROVIDERS.map((p) => p.key);
    for (const e of corpus) if (e.slots?.provider) expect(keys, e.id).toContain(e.slots.provider);
  });

  it('labels dates with criteria vocabulary', () => {
    const days = Array.from({ length: 31 }, (_, i) => String(i + 1));
    for (const e of corpus) {
      const d = e.slots?.date;
      if (!d) continue;
      if (d.mode) expect(DATE_MODES, e.id).toContain(d.mode);
      if (d.month) expect(MONTHS, e.id).toContain(d.month);
      if (d.day) expect(days, e.id).toContain(d.day);
      if (d.weekday) expect(WEEKDAYS, e.id).toContain(d.weekday);
      if (d.weekdayQualifier) expect(QUALIFIERS, e.id).toContain(d.weekdayQualifier);
      if (d.relativeDay) expect(RELATIVE_DAYS, e.id).toContain(d.relativeDay);
      if (d.window) expect(WINDOWS, e.id).toContain(d.window);
    }
  });

  it('covers every intent and every slot kind', () => {
    const intents = new Set(corpus.map((e) => e.intent));
    for (const i of ['schedule_new', 'reschedule', 'cancel', 'confirm_appointment', 'billing', 'agent', 'repeat_prompt', 'other', 'none']) expect(intents).toContain(i);
    expect(corpus.some((e) => e.slots?.memberId)).toBe(true);
    expect(corpus.some((e) => e.slots?.name)).toBe(true);
    expect(corpus.some((e) => e.slots?.dob?.year)).toBe(true);
    expect(corpus.some((e) => e.slots?.dob && e.slots.dob.year === undefined)).toBe(true);
    expect(corpus.some((e) => e.slots?.dob && e.slots.dob.month === undefined && e.slots.dob.year !== undefined)).toBe(true);
    expect(corpus.some((e) => e.slots?.provider)).toBe(true);
    expect(corpus.some((e) => e.slots?.date?.mode === 'absolute')).toBe(true);
    expect(corpus.some((e) => e.slots?.date?.mode === 'window')).toBe(true);
    expect(corpus.filter((e) => e.answers).length).toBeGreaterThanOrEqual(20);
  });
});

describe('parseCorpus', () => {
  const entries: CorpusEntry[] = [
    {
      id: 'r1', text: 'Reschedule with Dr. Chen next week', intent: 'reschedule', context: 'no_form',
      slots: { provider: 'chen', date: { mode: 'window', window: 'next_week' } },
    },
    {
      id: 'm1', text: 'four four seven one eight two nine three', intent: 'none', context: 'billing',
      slots: { memberId: { span: 'four four seven one eight two nine three', value: '44718293' } },
    },
  ];

  it('parses JSONL, skips blank lines and rejects duplicate ids', () => {
    const text = JSON.stringify(entries[0]) + '\n\n' + JSON.stringify(entries[1]) + '\n';
    expect(parseCorpus(text).map((e) => e.id)).toEqual(['r1', 'm1']);
    expect(() => parseCorpus(text + JSON.stringify(entries[0]))).toThrow(/duplicate/);
  });

  it('normalizes text for lookup', () => {
    expect(normalizeText('Reschedule, with Dr. Chen!')).toBe('reschedule with dr chen');
  });

  it('rejects an unknown context and duplicate normalized text', () => {
    const badContext = { ...entries[0], context: 'not_a_form' };
    expect(() => parseCorpus(JSON.stringify(badContext))).toThrow(/unknown context/);

    const dup = { ...entries[0], id: 'r1-dup', text: 'Reschedule, with Dr. Chen next week!' };
    const text = JSON.stringify(entries[0]) + '\n' + JSON.stringify(dup);
    expect(() => parseCorpus(text)).toThrow(/duplicates/);
  });

  it('accepts tentative, change and providerUnsure labels and rejects a bad change', () => {
    const ok = parseCorpus('{"id":"a","text":"maybe","intent":"cancel","context":"no_form","tentative":true}\n{"id":"b","text":"also bill","intent":"billing","context":"reschedule","change":"adding","providerUnsure":true}\n');
    expect(ok[0]?.tentative).toBe(true);
    expect(ok[1]?.change).toBe('adding');
    expect(() => parseCorpus('{"id":"c","text":"x","intent":"cancel","context":"reschedule","change":"swapping"}\n')).toThrow(/must be adding or replacing/);
    expect(() => parseCorpus('{"id":"d","text":"x","intent":"cancel","context":"no_form","change":"adding"}\n')).toThrow(/needs a form context/);
    expect(() => parseCorpus('{"id":"e","text":"x","intent":"cancel","context":"no_form","tentaive":true}\n')).toThrow(/unknown field tentaive/);
    expect(() => parseCorpus('{"id":"f","text":"x","intent":"cancel","context":"no_form","tentative":"true"}\n')).toThrow(/must be a boolean/);
    expect(() => parseCorpus('{"id":"g","text":"x","intent":"none","context":"reschedule","change":"adding"}\n')).toThrow(/needs an intent/);
    expect(() => parseCorpus('{"id":"h","text":"x","intent":"cancel","context":"billing","providerUnsure":true}\n')).toThrow(/not on form billing/);
  });

  it('accepts confirm contexts with confirm, changeSlot, and slot labels, and secondIntent outside a form', () => {
    const [a, b, c] = parseCorpus([
      '{"id":"fc-1","text":"yes","intent":"none","context":"confirm_reschedule","confirm":"yes"}',
      '{"id":"fc-2","text":"no the day","intent":"none","context":"confirm_reschedule","confirm":"no","changeSlot":"date"}',
      '{"id":"fc-3","text":"reschedule and also my bill","intent":"reschedule","context":"no_form","secondIntent":"billing"}',
    ].join('\n'));
    expect(a?.confirm).toBe('yes');
    expect(b?.changeSlot).toBe('date');
    expect(c?.secondIntent).toBe('billing');
  });

  it('rejects confirm labels off a confirm context, changeSlot for a slot not on the form, and secondIntent in a form', () => {
    expect(() => parseCorpus('{"id":"x","text":"yes","intent":"none","context":"reschedule","confirm":"yes"}')).toThrow(/confirm needs a confirm_ context/);
    expect(() => parseCorpus('{"id":"x","text":"the day","intent":"none","context":"confirm_cancel","changeSlot":"date"}')).toThrow(/not on form cancel/);
    expect(() => parseCorpus('{"id":"x","text":"x","intent":"reschedule","context":"reschedule","secondIntent":"billing"}')).toThrow(/secondIntent needs no_form/);
    expect(() => parseCorpus('{"id":"x","text":"x","intent":"none","context":"confirm_billing"}')).toThrow(/unknown context/);
  });

  it('rejects a changeSlot alongside confirm yes, and a secondIntent equal to intent', () => {
    expect(() => parseCorpus('{"id":"x","text":"yes the day","intent":"none","context":"confirm_reschedule","confirm":"yes","changeSlot":"date"}')).toThrow(/changeSlot needs confirm no or unanswered/);
    expect(() => parseCorpus('{"id":"x","text":"reschedule and reschedule","intent":"reschedule","context":"no_form","secondIntent":"reschedule"}')).toThrow(/secondIntent must differ from intent/);
  });

  it('rejects a name span and a birth year span that the text does not offer as candidates', () => {
    const named = (slots: string) => `{"id":"x","text":"my name is Jason Stiles","intent":"none","context":"no_form","slots":${slots}}`;
    expect(parseCorpus(named('{"name":"Jason Stiles"}'))[0]?.slots?.name).toBe('Jason Stiles');
    expect(() => parseCorpus(named('{"name":"my name"}'))).toThrow(/not a candidate word span/);
    const born = (slots: string) => `{"id":"y","text":"March fifth nineteen eighty","intent":"none","context":"no_form","slots":${slots}}`;
    expect(parseCorpus(born('{"dob":{"month":"march","day":"5","year":"nineteen eighty"}}'))[0]?.slots?.dob?.day).toBe('5');
    expect(() => parseCorpus(born('{"dob":{"month":"march","day":"5","year":"nineteen ninety"}}'))).toThrow(/not a candidate span/);
    expect(() => parseCorpus(born('{"dob":{"month":"march"}}'))).toThrow(/month and day together/);
    expect(parseCorpus(born('{"dob":{"year":"nineteen eighty"}}'))[0]?.slots?.dob?.year).toBe('nineteen eighty');
  });

  it('rejects a dob month or day the slot\'s own choice labels do not offer', () => {
    // "Mar" and "31st" would parse clean and then pick `none` at run time, so the labelled
    // birthday would silently never be read. The month and day are choice labels, not spans.
    const born = (slots: string) => `{"id":"z","text":"March thirty first nineteen eighty","intent":"none","context":"no_form","slots":${slots}}`;
    expect(parseCorpus(born('{"dob":{"month":"march","day":"31"}}'))[0]?.slots?.dob?.month).toBe('march');
    expect(() => parseCorpus(born('{"dob":{"month":"Mar","day":"31"}}'))).toThrow(/corpus z: dob month "Mar"/);
    expect(() => parseCorpus(born('{"dob":{"month":"march","day":"31st"}}'))).toThrow(/corpus z: dob day "31st"/);
    expect(() => parseCorpus(born('{"dob":{"month":"march","day":"32"}}'))).toThrow(/corpus z: dob day "32"/);
  });

  it('treats confirm_appointment as the confirm_appointment form itself, not a confirm_ context', () => {
    expect(contextForm('confirm_appointment')).toBe('confirm_appointment');
    expect(confirmForm('confirm_appointment')).toBeNull();
    expect(confirmForm('confirm_confirm_appointment')).toBe('confirm_appointment');
    expect(contextForm('confirm_confirm_appointment')).toBe('confirm_appointment');
  });

  it('resolves confirm_billing to null: billing hands off and has no summary prompt', () => {
    expect(contextForm('confirm_billing')).toBeNull();
  });
});
