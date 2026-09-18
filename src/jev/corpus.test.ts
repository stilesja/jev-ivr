import { describe, expect, it } from 'vitest';
import { loadCorpus, normalizeText } from './corpus';
import { candidateSpans } from '../core/spans';
import { spokenToDigits } from '../core/extract/spokenNumber';
import { DATE_MODES, MONTHS, WEEKDAYS, QUALIFIERS, RELATIVE_DAYS, WINDOWS } from '../core/extract/date';
import { PROVIDERS } from '../domain/slots/provider';
import { FORM_INTENTS } from '../domain/intents';
import { ALWAYS_ON_IDS } from '../core/questions';
import { allSlots, type SlotContext } from '../domain/slots';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';

const corpus = loadCorpus('fixtures/corpus.jsonl');

describe('fixtures/corpus.jsonl', () => {
  it('has at least 100 entries', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(100);
  });

  it('uses valid contexts', () => {
    for (const e of corpus) {
      expect(['no_form', ...FORM_INTENTS], e.id).toContain(e.context);
      if (e.prompted) expect(FORM_INTENTS, e.id).toContain(e.context);
    }
  });

  it('overrides name only questions the schema can ask', () => {
    const ctx: SlotContext = { text: '', candidateSpans: [], todayIso: '2026-09-18', thresholds: DEFAULT_THRESHOLDS, window: null };
    const askable = new Set<string>([...ALWAYS_ON_IDS, 'confirmsYes', 'confirmsNo', 'menuNumberSaid']);
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
    expect(corpus.some((e) => e.slots?.provider)).toBe(true);
    expect(corpus.some((e) => e.slots?.date?.mode === 'absolute')).toBe(true);
    expect(corpus.some((e) => e.slots?.date?.mode === 'window')).toBe(true);
    expect(corpus.filter((e) => e.answers).length).toBeGreaterThanOrEqual(20);
  });
});
