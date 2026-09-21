import type { SlotSpec, SlotOutcome } from './types';
import { isChoice, type AnswerMap, type QuestionMap } from '../../jev/types';
import {
  DATE_MODES, MONTHS, WEEKDAYS, QUALIFIERS, RELATIVE_DAYS, WINDOWS,
  resolveDate, describeDay, snapWeekdayOnOrAfter,
  type DateComponents, type ComponentPick, type DateWindow,
} from '../../core/extract/date';

const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));

/**
 * A bare weekday answered while a window is pending narrows that window: "Wednesday"
 * after "sometime in December" means the first Wednesday in December, not the one this
 * week. Absolute and relative days are taken as spoken, since they name a day outright.
 * The search starts at today when the window already began, so it never yields a past
 * day. Returns null when the weekday has no occurrence left inside the window.
 */
export function constrainToWindow(iso: string, mode: string, window: DateWindow | null, todayIso: string): string | null {
  if (!window || mode !== 'weekday') return iso;
  if (iso >= window.start && iso <= window.end) return iso;
  const snapped = snapWeekdayOnOrAfter(iso, window.start > todayIso ? window.start : todayIso);
  return snapped <= window.end ? snapped : null;
}

function criteriaOf(labels: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(labels.map((l) => [l, null]));
}

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
  spokenConfirm: 'by-confidence',

  questions(): QuestionMap {
    return {
      dateMode: {
        type: 'choice',
        instructions: 'Read asr.text. How does the caller refer to a day for the appointment? "absolute" names a month or a month and day. "relative_day" is today, tomorrow, or the day after tomorrow. "weekday" names a day of the week. "window" is a span like this week or next month. "none" if no day is mentioned. The caller\'s date of birth or birthday, or a date answering a question about it, is not an appointment date. One utterance can carry both: a birthday and, separately, the day they want to come in. The appointment day is the one not introduced by born or birthday, so a weekday or a relative day said alongside a birthday is still the appointment day and still names the mode.',
        criteria: {
          ...criteriaOf(DATE_MODES),
          none: "No day for the appointment. The caller's date of birth or birthday, or a date answering a question about it, is not one",
        },
      },
      dateMonth: {
        type: 'choice',
        instructions: 'Read asr.text. Which month does the caller name, if any? The caller\'s date of birth or birthday, or a date answering a question about it, is not an appointment date. If the only month and day in asr.text belong to the caller\'s birthday, answer none. When they correct a month, the word not marks the month they are rejecting; choose the other one, as in "not March, April" or "October, not September". A hedge such as "I\'m not sure" or "either" is not a correction; name the month they mention.',
        criteria: criteriaOf([...MONTHS, 'none']),
      },
      dateDay: {
        type: 'choice',
        instructions: 'Read asr.text. Which day of the month does the caller name, if any? The caller\'s date of birth or birthday, or a date answering a question about it, is not an appointment date. If the only month and day in asr.text belong to the caller\'s birthday, answer none. When they correct a day of the month, the word not marks the one they are rejecting; choose the other one, as in "not the 5th, the 6th" or "the 20th, not the 12th". A hedge such as "I\'m not sure" or "either" is not a correction; name the day of the month they mention.',
        criteria: criteriaOf([...DAYS, 'none']),
      },
      dateWeekday: {
        type: 'choice',
        instructions: 'Read asr.text. Which day of the week does the caller name, if any? When they correct a day, the word not marks the day they are rejecting; choose the other one, as in "not Monday, Friday" or "Saturday, not Sunday". A hedge such as "I\'m not sure" or "either" is not a correction; name the day they mention.',
        criteria: criteriaOf([...WEEKDAYS, 'none']),
      },
      dateWeekdayQualifier: {
        type: 'choice',
        instructions: 'Read asr.text. If the caller names a day of the week, do they say "this" or "next" before it? When they correct this qualifier, the word not marks the one they are rejecting; choose the other one, as in "not this Thursday, next Thursday". A hedge such as "I\'m not sure" or "either" is not a correction; name the qualifier they mention.',
        criteria: criteriaOf(QUALIFIERS),
      },
      dateRelativeDay: {
        type: 'choice',
        instructions: 'Read asr.text. Does the caller say today, tomorrow, or the day after tomorrow? When they correct a relative day, the word not marks the one they are rejecting; choose the other one, as in "not today, the day after tomorrow". A hedge such as "I\'m not sure" or "either" is not a correction; name the relative day they mention.',
        criteria: criteriaOf(RELATIVE_DAYS),
      },
      dateWindow: {
        type: 'choice',
        instructions: 'Read asr.text. Does the caller name a span of days such as this week, next week, this month, or next month? When they correct the span, the word not marks the one they are rejecting; choose the other one, as in "not next week, this week". A hedge such as "I\'m not sure" or "either" is not a correction; name the span they mention.',
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
        // ctx.window is a per-slot partial now; the date slot only ever narrows against its own
        // DateWindow (never a dob partial, which slotContext never routes here).
        const dateWindow = ctx.window && !('kind' in ctx.window) ? ctx.window : null;
        const iso = constrainToWindow(resolved.iso, components.mode.choice, dateWindow, ctx.todayIso);
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
