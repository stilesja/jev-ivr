import { readFileSync } from 'node:fs';
import { FORM_INTENTS, INTENTS, type FormId, type Intent } from '../domain/intents';
import { FORMS, type SlotId } from '../domain/forms';

export interface DateLabel {
  mode?: string;
  month?: string;
  day?: string;
  weekday?: string;
  weekdayQualifier?: string;
  relativeDay?: string;
  window?: string;
}

export interface CorpusSlots {
  memberId?: { span: string; value: string };
  provider?: string;
  date?: DateLabel;
}

export interface AnswerOverride {
  noul?: number;
  probabilities?: Record<string, number>;
}

export interface CorpusEntry {
  id: string;
  text: string;
  intent: Intent;
  /** the form active when this utterance is spoken; no_form for a first utterance */
  context: 'no_form' | FormId;
  /** the slot the last prompt asked for; only inside a form, defaults to the form's first missing slot */
  prompted?: SlotId;
  slots?: CorpusSlots;
  /** the caller hedges the request (spec 2026-09-19 §2.1) */
  tentative?: boolean;
  /** in-form only: the utterance adds a task or replaces the current one (§2.2); absent means answering */
  change?: 'adding' | 'replacing';
  /** the caller hedges or names more than one provider (§2.5) */
  providerUnsure?: boolean;
  /** explicit distributions that replace the generated ones */
  answers?: Record<string, AnswerOverride>;
  tags?: string[];
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const ENTRY_KEYS = new Set(['id', 'text', 'intent', 'context', 'prompted', 'slots', 'tentative', 'change', 'providerUnsure', 'answers', 'tags']);

export function parseCorpus(jsonl: string): CorpusEntry[] {
  const seen = new Set<string>();
  const seenText = new Map<string, string>();
  const out: CorpusEntry[] = [];
  for (const [i, line] of jsonl.split('\n').entries()) {
    if (!line.trim()) continue;
    let entry: CorpusEntry;
    try {
      entry = JSON.parse(line) as CorpusEntry;
    } catch (e) {
      throw new Error(`corpus line ${i + 1}: invalid JSON`, { cause: e });
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) throw new Error(`corpus ${entry.id}: unknown field ${key}`);
    }
    if (!entry.id || !entry.text) throw new Error(`corpus line ${i + 1}: id and text are required`);
    if (!(INTENTS as readonly string[]).includes(entry.intent)) throw new Error(`corpus ${entry.id}: unknown intent ${entry.intent}`);
    if (entry.context !== 'no_form' && !(FORM_INTENTS as readonly string[]).includes(entry.context)) {
      throw new Error(`corpus ${entry.id}: unknown context ${entry.context}`);
    }
    if (entry.prompted !== undefined
      && (entry.context === 'no_form' || !FORMS[entry.context].slots.includes(entry.prompted))) {
      throw new Error(`corpus ${entry.id}: prompted slot ${entry.prompted} is not on form ${entry.context}`);
    }
    if (entry.tentative !== undefined && typeof entry.tentative !== 'boolean') {
      throw new Error(`corpus ${entry.id}: tentative must be a boolean`);
    }
    if (entry.providerUnsure !== undefined && typeof entry.providerUnsure !== 'boolean') {
      throw new Error(`corpus ${entry.id}: providerUnsure must be a boolean`);
    }
    if (entry.change !== undefined) {
      if (entry.change !== 'adding' && entry.change !== 'replacing') throw new Error(`corpus ${entry.id}: change must be adding or replacing`);
      if (entry.context === 'no_form') throw new Error(`corpus ${entry.id}: change needs a form context`);
      if (entry.intent === 'none') throw new Error(`corpus ${entry.id}: change needs an intent to add or switch to`);
    }
    if (entry.context !== 'no_form') {
      const formSlots = FORMS[entry.context].slots as readonly string[];
      for (const key of Object.keys(entry.slots ?? {})) {
        if (!formSlots.includes(key)) throw new Error(`corpus ${entry.id}: slot ${key} is not on form ${entry.context}`);
      }
      if (entry.providerUnsure && !formSlots.includes('provider')) {
        throw new Error(`corpus ${entry.id}: slot provider is not on form ${entry.context}`);
      }
    }
    if (seen.has(entry.id)) throw new Error(`corpus ${entry.id}: duplicate id`);
    seen.add(entry.id);
    const normalized = normalizeText(entry.text);
    const otherId = seenText.get(normalized);
    if (otherId) throw new Error(`corpus ${entry.id}: text duplicates ${otherId} after normalization`);
    seenText.set(normalized, entry.id);
    out.push(entry);
  }
  return out;
}

export function loadCorpus(path: string): CorpusEntry[] {
  return parseCorpus(readFileSync(path, 'utf8'));
}
