import { readFileSync } from 'node:fs';
import { FORM_INTENTS, INTENTS, isFormIntent, type FormId, type Intent } from '../domain/intents';
import { FORMS, SCHEDULING_FORMS, type SlotId } from '../domain/forms';
import { DAYPART_ORDER, type Daypart } from '../domain/directory';
import { candidateSpans, candidateWordSpans } from '../core/spans';
import { MONTHS } from '../core/extract/date';
import { DOB_DAYS } from '../domain/slots/dob';

export interface DateLabel {
  mode?: string;
  month?: string;
  day?: string;
  weekday?: string;
  weekdayQualifier?: string;
  relativeDay?: string;
  window?: string;
}

/**
 * The caller's birthday as they say it. Every part is optional because a caller gives the parts
 * they give: a whole date, a month and day with the year still to come, or -- answering the year
 * question -- a year on its own.
 */
export interface DobLabel {
  month?: string;
  day?: string;
  /** the year as spoken ("nineteen eighty", "1980") */
  year?: string;
}

export interface CorpusSlots {
  /** the caller's name as spoken, a span of the text */
  name?: string;
  dob?: DobLabel;
  memberId?: { span: string; value: string };
  provider?: string;
  date?: DateLabel;
}

export interface AnswerOverride {
  noul?: number;
  probabilities?: Record<string, number>;
}

/**
 * The state an utterance is spoken in: nothing started yet, a form in progress, the summary of a
 * form (`confirm_<form>`), or the transfer offered to a frustrated caller (spec 2026-09-22 §5).
 * The offer is not a `confirm_` context: it confirms no form and reads no summary back. It is
 * seeded inside a `reschedule` form so that a declined offer has a question to return to.
 */
export type CorpusContext = 'no_form' | FormId | `confirm_${FormId}` | 'offer_transfer';

export interface CorpusEntry {
  id: string;
  text: string;
  intent: Intent;
  /** the form active when this utterance is spoken; no_form for a first utterance; confirm_<form> for the summary turn; offer_transfer for the transfer offer */
  context: CorpusContext;
  /** the slot the last prompt asked for; inside a form or at the offer, defaults to the form's first missing slot */
  prompted?: SlotId;
  slots?: CorpusSlots;
  /** the caller hedges the request (spec 2026-09-19 §2.1) */
  tentative?: boolean;
  /** in-form only: the utterance adds a task or replaces the current one (§2.2); absent means answering */
  change?: 'adding' | 'replacing';
  /** the caller hedges or names more than one provider (§2.5) */
  providerUnsure?: boolean;
  /** the caller says whether they know the provider's name without saying it (spec 2026-09-24 §3.2) */
  providerNameStatus?: 'has_name' | 'no_name';
  /** confirm_ and offer_transfer contexts only: how the utterance answers the question (final-confirm §7) */
  confirm?: 'yes' | 'no' | 'unanswered';
  /** confirm_ contexts only: the detail the caller names when asked what to change (final-confirm §6) */
  changeSlot?: SlotId;
  /** no_form only: a second task named alongside the main one (final-confirm §4) */
  secondIntent?: FormId;
  /** a part of the day the caller volunteers (appointment-slots §5) */
  timeOfDay?: Daypart;
  /** at a scheduling summary: a move along the day's openings */
  timePreference?: 'earlier' | 'later' | 'different';
  /** explicit distributions that replace the generated ones */
  answers?: Record<string, AnswerOverride>;
  tags?: string[];
}

// Not a prefix test: confirm_appointment is itself a form (FORM_INTENTS), not the confirm_ context for a
// form named "appointment". A confirm_ context is exact membership: confirm_<FormId> for every form that
// asks a summary question (billing hands off instead, so it has none). This makes confirm_confirm_appointment
// the (unusual but valid) summary context for the confirm_appointment form.
const CONFIRM_CONTEXTS: ReadonlyMap<string, FormId> = new Map(
  FORM_INTENTS.filter((f) => FORMS[f].summaryPromptId !== null).map((f) => [`confirm_${f}`, f] as const),
);

/** confirm_ contexts only: the form behind the confirm, else null */
export function confirmForm(context: CorpusContext): FormId | null {
  return CONFIRM_CONTEXTS.get(context) ?? null;
}

/** true for the transfer offer's context, which is a pending confirmation but not a form's summary */
export function offerTransfer(context: CorpusContext): boolean {
  return context === 'offer_transfer';
}

/** the form the transfer offer is seeded inside, so a declined offer has a question to come back to */
export const OFFER_TRANSFER_FORM: FormId = 'reschedule';

/** the form a context runs in: the form itself, the form behind a confirm_ context, or the offer's */
export function contextForm(context: CorpusContext): FormId | null {
  if (context === 'no_form') return null;
  if (offerTransfer(context)) return OFFER_TRANSFER_FORM;
  const cf = confirmForm(context);
  if (cf !== null) return cf;
  return isFormIntent(context) ? context : null;
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const ENTRY_KEYS = new Set([
  'id', 'text', 'intent', 'context', 'prompted', 'slots', 'tentative', 'change', 'providerUnsure', 'providerNameStatus',
  'confirm', 'changeSlot', 'secondIntent', 'timeOfDay', 'timePreference', 'answers', 'tags',
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
    const offering = offerTransfer(entry.context);
    if (entry.context !== 'no_form' && !offering && !(FORM_INTENTS as readonly string[]).includes(cf ?? entry.context)) {
      throw new Error(`corpus ${entry.id}: unknown context ${entry.context}`);
    }
    // prompted names a slot in a form already in progress -- for the offer, the question the caller
    // was on when it was made; the confirm_ context has no "prompted slot" of its own.
    if (entry.prompted !== undefined) {
      if (cf !== null) throw new Error(`corpus ${entry.id}: prompted needs a form context, not ${entry.context}`);
      const promptedForm = contextForm(entry.context);
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
    if (entry.providerNameStatus !== undefined && entry.providerNameStatus !== 'has_name' && entry.providerNameStatus !== 'no_name') {
      throw new Error(`corpus ${entry.id}: providerNameStatus must be has_name or no_name`);
    }
    if (entry.change !== undefined) {
      if (entry.change !== 'adding' && entry.change !== 'replacing') throw new Error(`corpus ${entry.id}: change must be adding or replacing`);
      if (entry.context === 'no_form') throw new Error(`corpus ${entry.id}: change needs a form context`);
      if (entry.intent === 'none') throw new Error(`corpus ${entry.id}: change needs an intent to add or switch to`);
    }
    if (entry.confirm !== undefined) {
      if (!['yes', 'no', 'unanswered'].includes(entry.confirm)) throw new Error(`corpus ${entry.id}: confirm must be yes, no, or unanswered`);
      if (cf === null && !offering) throw new Error(`corpus ${entry.id}: confirm needs a confirm_ or offer_transfer context`);
    }
    if (entry.changeSlot !== undefined) {
      if (cf === null) throw new Error(`corpus ${entry.id}: changeSlot needs a confirm_ context`);
      if (entry.confirm === 'yes') throw new Error(`corpus ${entry.id}: changeSlot needs confirm no or unanswered`);
      if (!FORMS[cf].slots.includes(entry.changeSlot)) throw new Error(`corpus ${entry.id}: changeSlot ${entry.changeSlot} is not on form ${cf}`);
    }
    if (entry.secondIntent !== undefined) {
      if (entry.context !== 'no_form') throw new Error(`corpus ${entry.id}: secondIntent needs no_form`);
      if (!(FORM_INTENTS as readonly string[]).includes(entry.secondIntent)) throw new Error(`corpus ${entry.id}: unknown secondIntent ${entry.secondIntent}`);
      if (entry.secondIntent === entry.intent) throw new Error(`corpus ${entry.id}: secondIntent must differ from intent`);
    }
    // timeOfDay is asked outside a form and on a schedule or reschedule form, but only kept when
    // the form it lands on books an opening; timePreference is asked only at such a summary. A
    // label anywhere else is one no answer could ever act on.
    if (entry.timeOfDay !== undefined) {
      if (!(DAYPART_ORDER as readonly string[]).includes(entry.timeOfDay)) throw new Error(`corpus ${entry.id}: timeOfDay must be morning, midday, or afternoon`);
      const form = entry.context === 'no_form' ? (isFormIntent(entry.intent) ? entry.intent : null) : contextForm(entry.context);
      if (form === null || !SCHEDULING_FORMS.includes(form)) {
        throw new Error(`corpus ${entry.id}: timeOfDay needs a schedule_new or reschedule context, or a no_form opener with that intent`);
      }
    }
    if (entry.timePreference !== undefined) {
      if (!['earlier', 'later', 'different'].includes(entry.timePreference)) throw new Error(`corpus ${entry.id}: timePreference must be earlier, later, or different`);
      if (cf === null || !SCHEDULING_FORMS.includes(cf)) throw new Error(`corpus ${entry.id}: timePreference needs confirm_schedule_new or confirm_reschedule`);
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
      if (entry.providerNameStatus && !formSlots.includes('provider')) {
        throw new Error(`corpus ${entry.id}: slot provider is not on form ${form}`);
      }
    }
    // The name and the birth year are spans the Choice questions offer, so a label the generator
    // never produces is one no answer could pick: caught here, at the id, rather than as a quiet
    // `none` at run time.
    const name = entry.slots?.name;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) throw new Error(`corpus ${entry.id}: name must be a non-empty span`);
      if (!candidateWordSpans(entry.text).includes(normalizeText(name))) {
        throw new Error(`corpus ${entry.id}: name span "${name}" is not a candidate word span of the text`);
      }
    }
    const dob = entry.slots?.dob;
    if (dob !== undefined) {
      if (dob.month === undefined && dob.day === undefined && dob.year === undefined) {
        throw new Error(`corpus ${entry.id}: dob needs a month and day, a year, or both`);
      }
      if (dob.month !== undefined && dob.day === undefined) throw new Error(`corpus ${entry.id}: dob needs a month and day together`);
      if (dob.day !== undefined && dob.month === undefined) throw new Error(`corpus ${entry.id}: dob needs a month and day together`);
      if (dob.year !== undefined && !candidateSpans(entry.text).includes(normalizeText(dob.year))) {
        throw new Error(`corpus ${entry.id}: dob year span "${dob.year}" is not a candidate span of the text`);
      }
      // The month and the day are choice labels, not spans: the dobMonth and dobDay questions
      // offer exactly these, so anything else ("Mar", "31st") can only be picked as `none`, and
      // the labelled birthday would go quietly unread instead of failing here at the id.
      if (dob.month !== undefined && !(MONTHS as readonly string[]).includes(dob.month)) {
        throw new Error(`corpus ${entry.id}: dob month "${dob.month}" is not one of the month labels`);
      }
      if (dob.day !== undefined && !DOB_DAYS.includes(dob.day)) {
        throw new Error(`corpus ${entry.id}: dob day "${dob.day}" is not a day-of-month label "1".."31"`);
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
