import type { SlotSpec, SlotOutcome } from './types';
import { isChoice, noulValue, type AnswerMap } from '../../jev/types';
import { MONTHS, describeDob, normalizeYear } from '../../core/extract/date';

/** The day-of-month choice labels: "1" .. "31", exactly as dobDay offers them. */
export const DOB_DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const MIN_YEAR = 1900;

function isoOf(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function pickLabel(answers: AnswerMap, id: string): { label: string; p: number } {
  const a = answers[id];
  if (!isChoice(a)) return { label: 'none', p: 0 };
  return { label: a.choice, p: a.probabilities[a.choice] ?? a.confidence };
}

function criteriaOf(labels: readonly string[]): Record<string, string | null> {
  return Object.fromEntries([...labels, 'none'].map((l) => [l, null]));
}

export const dobSlot: SlotSpec = {
  id: 'dob',
  spokenConfirm: 'summary',
  questions(ctx) {
    const years: Record<string, string | null> = {};
    for (const span of ctx.candidateSpans) years[span] = null;
    years.none = "No span of asr.text is a year of the caller's birth";
    // A month/day partial pending means the caller was just asked for the year alone, but they
    // may restate the whole date instead -- all four questions stay asked either way; only the
    // year instruction changes to reflect what was actually asked.
    const pending = ctx.window && 'kind' in ctx.window && ctx.window.kind === 'dob' ? ctx.window : null;
    const dobYearInstructions = pending
      ? 'Read asr.text. The caller was asked for the year of their birth. Which of these spans is that year, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said.'
      : 'Read asr.text. Which of these spans is the year of the caller\'s birth, if they say one, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said.';
    return {
      dobGiven: {
        type: 'noul',
        instructions: "Read asr.text. Does the caller state their date of birth or birthday, in whole or in part (a month and day, or a year alone when asked for it)?",
        criteria: {
          true: "The caller gives their own birth date or part of it: a full date, a month and day, or a year on its own in answer to a question about their birth year",
          false: "No birth date. An appointment date, a date they want to be seen on, or someone else's birth date is not the caller's date of birth",
        },
      },
      dobMonth: {
        type: 'choice',
        instructions: "Read asr.text. Which month is the caller's date of birth in, if they say one? This is the birth date, not an appointment date.",
        criteria: criteriaOf(MONTHS),
      },
      dobDay: {
        type: 'choice',
        instructions: "Read asr.text. Which day of the month is the caller's date of birth, if they say one? This is the birth date, not an appointment date.",
        criteria: criteriaOf(DOB_DAYS),
      },
      dobYear: {
        type: 'choice',
        instructions: dobYearInstructions,
        criteria: years,
      },
    };
  },
  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    if (noulValue(answers, 'dobGiven') < t.SLOT_DETECT) return { kind: 'absent' };
    const month = pickLabel(answers, 'dobMonth');
    const day = pickLabel(answers, 'dobDay');
    const year = pickLabel(answers, 'dobYear');
    const pending = ctx.window && 'kind' in ctx.window && ctx.window.kind === 'dob' ? ctx.window : null;
    const m = month.label !== 'none' && month.p >= t.SLOT_CHOICE_CONFIRM
      ? MONTHS.indexOf(month.label as (typeof MONTHS)[number]) + 1
      : pending?.month ?? null;
    const d = day.label !== 'none' && day.p >= t.SLOT_CHOICE_CONFIRM ? Number(day.label) : pending?.day ?? null;
    const y = year.label !== 'none' && year.p >= t.SLOT_CHOICE_CONFIRM ? normalizeYear(year.label, ctx.todayIso) : null;
    // Only the components this turn actually read count. Without this, an answer the components
    // cannot read at all ("uh, let me think") rebuilds the pending partial as a fresh `window`
    // outcome rather than reporting that nothing was heard. fillSlots no longer takes that for
    // progress -- an unchanged window counts an attempt -- but the honest outcome still belongs
    // here, at the source: absent is what "nothing readable was said" means, and it keeps the
    // slot off the gate table entirely. It also kept Math.min of an empty list (Infinity) and
    // averaged in components below the choice threshold that were never used. dateSlot returns
    // absent the same way when its mode is none.
    const used = [month, day, year].filter((c) => c.label !== 'none' && c.p >= t.SLOT_CHOICE_CONFIRM);
    if (used.length === 0) return { kind: 'absent' };
    const confidence = Math.min(...used.map((c) => c.p));
    if (m === null || d === null) return { kind: 'invalid', reason: 'no_date', raw: '' };
    if (y === null) return { kind: 'window', window: { kind: 'dob', month: m, day: d }, confidence };
    if (y < MIN_YEAR) return { kind: 'invalid', reason: 'impossible', raw: `${y}` };
    const iso = isoOf(y, m, d);
    if (!iso) return { kind: 'invalid', reason: 'impossible', raw: `${y}-${m}-${d}` };
    if (iso >= ctx.todayIso) return { kind: 'invalid', reason: 'future', raw: iso };
    return { kind: 'filled', value: iso, display: describeDob(iso), confidence, confirm: 'none' };
  },
  dtmf: {
    length: 8,
    parse(digits, ctx) {
      const m = Number(digits.slice(0, 2));
      const d = Number(digits.slice(2, 4));
      const y = Number(digits.slice(4, 8));
      if (y < MIN_YEAR) return null;
      const iso = isoOf(y, m, d);
      if (!iso || iso >= ctx.todayIso) return null;
      return { value: iso, display: describeDob(iso) };
    },
  },
  display: describeDob,
};
