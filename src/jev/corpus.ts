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

export type CorpusContext = 'no_form' | FormId | `confirm_${FormId}`;

export interface CorpusEntry {
  id: string;
  text: string;
  intent: Intent;
  /** the form active when this utterance is spoken; no_form for a first utterance; confirm_<form> for the summary turn */
  context: CorpusContext;
  /** the slot the last prompt asked for; only inside a form, defaults to the form's first missing slot */
  prompted?: SlotId;
  slots?: CorpusSlots;
  /** the caller hedges the request (spec 2026-09-19 §2.1) */
  tentative?: boolean;
  /** in-form only: the utterance adds a task or replaces the current one (§2.2); absent means answering */
  change?: 'adding' | 'replacing';
  /** the caller hedges or names more than one provider (§2.5) */
  providerUnsure?: boolean;
  /** confirm_ contexts only: how the utterance answers the summary question (final-confirm §7) */
  confirm?: 'yes' | 'no' | 'unanswered';
  /** confirm_ contexts only: the detail the caller names when asked what to change (final-confirm §6) */
  changeSlot?: SlotId;
  /** no_form only: a second task named alongside the main one (final-confirm §4) */
  secondIntent?: FormId;
  /** explicit distributions that replace the generated ones */
  answers?: Record<string, AnswerOverride>;
  tags?: string[];
}

// Not a prefix test: confirm_appointment is itself a form (FORM_INTENTS), not the confirm_ context for a
// form named "appointment". A confirm_ context is exact membership: confirm_<FormId> for every form whose
// completion is a prompt (billing hands off, so it has none). This makes confirm_confirm_appointment the
// (unusual but valid) summary context for the confirm_appointment form.
const CONFIRM_CONTEXTS: ReadonlyMap<string, FormId> = new Map(
  FORM_INTENTS.filter((f) => FORMS[f].completion.kind === 'prompt').map((f) => [`confirm_${f}`, f] as const),
);

/** confirm_ contexts only: the form behind the confirm, else null */
export function confirmForm(context: CorpusContext): FormId | null {
  return CONFIRM_CONTEXTS.get(context) ?? null;
}

/** the form a context runs in: the form itself, or the form behind a confirm_ context */
export function contextForm(context: CorpusContext): FormId | null {
  return context === 'no_form' ? null : (confirmForm(context) ?? (context as FormId));
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const ENTRY_KEYS = new Set([
  'id', 'text', 'intent', 'context', 'prompted', 'slots', 'tentative', 'change', 'providerUnsure',
  'confirm', 'changeSlot', 'secondIntent', 'answers', 'tags',
]);

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
    const cf = entry.context === 'no_form' ? null : confirmForm(entry.context);
    if (entry.context !== 'no_form' && !(FORM_INTENTS as readonly string[]).includes(cf ?? entry.context)) {
      throw new Error(`corpus ${entry.id}: unknown context ${entry.context}`);
    }
    if (cf !== null && FORMS[cf].completion.kind !== 'prompt') {
      throw new Error(`corpus ${entry.id}: unknown context ${entry.context}`);
    }
    // prompted names a slot in a form already in progress; the confirm_ context has no "prompted slot" of its own.
    if (entry.prompted !== undefined) {
      if (cf !== null) throw new Error(`corpus ${entry.id}: prompted needs a form context, not ${entry.context}`);
      const promptedForm = entry.context === 'no_form' ? null : contextForm(entry.context);
      if (promptedForm === null || !FORMS[promptedForm].slots.includes(entry.prompted)) {
        throw new Error(`corpus ${entry.id}: prompted slot ${entry.prompted} is not on form ${entry.context}`);
      }
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
    if (entry.confirm !== undefined) {
      if (cf === null) throw new Error(`corpus ${entry.id}: confirm needs a confirm_ context`);
      if (!['yes', 'no', 'unanswered'].includes(entry.confirm)) throw new Error(`corpus ${entry.id}: confirm must be yes, no, or unanswered`);
    }
    if (entry.changeSlot !== undefined) {
      if (cf === null) throw new Error(`corpus ${entry.id}: changeSlot needs a confirm_ context`);
      if (!FORMS[cf].slots.includes(entry.changeSlot)) throw new Error(`corpus ${entry.id}: changeSlot ${entry.changeSlot} is not on form ${cf}`);
    }
    if (entry.secondIntent !== undefined) {
      if (entry.context !== 'no_form') throw new Error(`corpus ${entry.id}: secondIntent needs no_form`);
      if (!(FORM_INTENTS as readonly string[]).includes(entry.secondIntent)) throw new Error(`corpus ${entry.id}: unknown secondIntent ${entry.secondIntent}`);
    }
    if (entry.context !== 'no_form') {
      const form = contextForm(entry.context)!;
      const formSlots = FORMS[form].slots as readonly string[];
      for (const key of Object.keys(entry.slots ?? {})) {
        if (!formSlots.includes(key)) throw new Error(`corpus ${entry.id}: slot ${key} is not on form ${form}`);
      }
      if (entry.providerUnsure && !formSlots.includes('provider')) {
        throw new Error(`corpus ${entry.id}: slot provider is not on form ${form}`);
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
