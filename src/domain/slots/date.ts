import type { SlotSpec, SlotOutcome } from './types';
import { isChoice, type AnswerMap, type QuestionMap } from '../../jev/types';
import {
  DATE_MODES, MONTHS, WEEKDAYS, QUALIFIERS, RELATIVE_DAYS, WINDOWS,
  resolveDate, describeDay, addDays, parseIso,
  type DateComponents, type ComponentPick, type DateWindow,
} from '../../core/extract/date';

const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const DAY_MS = 86_400_000;

/**
 * A bare weekday answered while a window is pending narrows that window: "Wednesday"
 * after "sometime in December" means the first Wednesday in December, not the one this
 * week. Absolute and relative days are taken as spoken, since they name a day outright.
 * Returns null when the weekday has no occurrence inside the window.
 */
export function constrainToWindow(iso: string, mode: string, window: DateWindow | null): string | null {
  if (!window || mode !== 'weekday') return iso;
  if (iso >= window.start && iso <= window.end) return iso;
  const offsetDays = Math.round((parseIso(iso) - parseIso(window.start)) / DAY_MS);
  const snapped = addDays(window.start, ((offsetDays % 7) + 7) % 7);
  return snapped <= window.end ? snapped : null;
}

function criteriaOf(labels: readonly string[]): Record<string, null> {
  return Object.fromEntries(labels.map((l) => [l, null]));
}

export const DATE_QUESTION_IDS = [
  'dateMode', 'dateMonth', 'dateDay', 'dateWeekday', 'dateWeekdayQualifier', 'dateRelativeDay', 'dateWindow',
] as const;

function pick(answers: AnswerMap, id: string): ComponentPick {
  const a = answers[id];
  if (!isChoice(a)) return { choice: 'none', p: 0 };
  return { choice: a.choice, p: a.probabilities[a.choice] ?? a.confidence };
}

export function dateComponentsFrom(answers: AnswerMap): DateComponents {
  return {
    mode: pick(answers, 'dateMode'),
    month: pick(answers, 'dateMonth'),
    day: pick(answers, 'dateDay'),
    weekday: pick(answers, 'dateWeekday'),
    weekdayQualifier: pick(answers, 'dateWeekdayQualifier'),
    relativeDay: pick(answers, 'dateRelativeDay'),
    window: pick(answers, 'dateWindow'),
  };
}

export const dateSlot: SlotSpec = {
  id: 'date',

  questions(): QuestionMap {
    return {
      dateMode: {
        type: 'choice',
        instructions: 'Read asr.text. How does the caller refer to a day for the appointment? "absolute" names a month or a month and day. "relative_day" is today, tomorrow, or the day after tomorrow. "weekday" names a day of the week. "window" is a span like this week or next month. "none" if no day is mentioned.',
        criteria: criteriaOf(DATE_MODES),
      },
      dateMonth: {
        type: 'choice',
        instructions: 'Read asr.text. Which month does the caller name, if any?',
        criteria: criteriaOf([...MONTHS, 'none']),
      },
      dateDay: {
        type: 'choice',
        instructions: 'Read asr.text. Which day of the month does the caller name, if any?',
        criteria: criteriaOf([...DAYS, 'none']),
      },
      dateWeekday: {
        type: 'choice',
        instructions: 'Read asr.text. Which day of the week does the caller name, if any?',
        criteria: criteriaOf([...WEEKDAYS, 'none']),
      },
      dateWeekdayQualifier: {
        type: 'choice',
        instructions: 'Read asr.text. If the caller names a day of the week, do they say "this" or "next" before it?',
        criteria: criteriaOf(QUALIFIERS),
      },
      dateRelativeDay: {
        type: 'choice',
        instructions: 'Read asr.text. Does the caller say today, tomorrow, or the day after tomorrow?',
        criteria: criteriaOf(RELATIVE_DAYS),
      },
      dateWindow: {
        type: 'choice',
        instructions: 'Read asr.text. Does the caller name a span of days such as this week, next week, this month, or next month?',
        criteria: criteriaOf(WINDOWS),
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    const components = dateComponentsFrom(answers);
    if (components.mode.choice === 'none' || components.mode.p < t.SLOT_CHOICE_CONFIRM) return { kind: 'absent' };
    const resolved = resolveDate(components, ctx.todayIso);
    switch (resolved.kind) {
      case 'none':
        return { kind: 'invalid', reason: 'unresolvable', raw: components.mode.choice };
      case 'window':
        return {
          kind: 'window',
          window: { start: resolved.start, end: resolved.end, label: resolved.label },
          confidence: resolved.confidence,
        };
      case 'day': {
        if (resolved.confidence < t.SLOT_CHOICE_CONFIRM) {
          return { kind: 'invalid', reason: 'low_confidence', raw: resolved.iso };
        }
        const iso = constrainToWindow(resolved.iso, components.mode.choice, ctx.window ?? null);
        if (iso === null) return { kind: 'invalid', reason: 'outside_window', raw: resolved.iso };
        return {
          kind: 'filled',
          value: iso,
          display: describeDay(iso),
          confidence: resolved.confidence,
          confirm: resolved.confidence >= t.SLOT_CHOICE_FILL ? 'none' : 'implicit',
        };
      }
    }
  },

  dtmf: {
    length: 4,
    parse(digits, ctx) {
      const month = Number(digits.slice(0, 2));
      const day = Number(digits.slice(2, 4));
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const one: ComponentPick = { choice: '', p: 1 };
      const resolved = resolveDate(
        {
          mode: { choice: 'absolute', p: 1 },
          month: { choice: MONTHS[month - 1]!, p: 1 },
          day: { choice: String(day), p: 1 },
          weekday: one, weekdayQualifier: one, relativeDay: one, window: one,
        },
        ctx.todayIso,
      );
      if (resolved.kind !== 'day') return null;
      return { value: resolved.iso, display: describeDay(resolved.iso) };
    },
  },

  display: describeDay,
};
