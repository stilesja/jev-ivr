import type { AnswerMap, QuestionMap } from '../../jev/types';
import type { Thresholds } from '../../core/thresholds';
import type { DateWindow } from '../../core/extract/date';
import type { SlotId } from '../forms';

/** A partial dob: month and day heard, year still owed. */
export interface DobPartial {
  kind: 'dob';
  month: number;
  day: number;
}

/** A slot's own pending narrowing: a date window for `date`, a month/day partial for `dob`. */
export type SlotPartial = DateWindow | DobPartial;

export interface SlotContext {
  text: string;
  candidateSpans: string[];
  candidateWordSpans: string[];
  todayIso: string;
  thresholds: Thresholds;
  /** the slot's own pending partial, null when none is pending */
  window: SlotPartial | null;
}

export interface SlotCandidate {
  value: string;
  display: string;
}

export type SlotOutcome =
  | { kind: 'absent' }
  | { kind: 'filled'; value: string; display: string; confidence: number; confirm: 'none' | 'implicit' }
  | { kind: 'disambiguate'; a: SlotCandidate; b: SlotCandidate }
  | { kind: 'window'; window: SlotPartial; confidence: number }
  | { kind: 'invalid'; reason: string; raw: string };

export interface SlotSpec {
  id: SlotId;
  /** always: a spoken fill is read back and must be confirmed before it counts, which needs a `confirm_<slot>`
   * entry in the prompt manifest (no slot uses this today, so none is there); by-confidence: the fill outcome
   * decides; summary: a spoken fill is neither acked nor read back; the final confirm covers it */
  spokenConfirm: 'always' | 'by-confidence' | 'summary';
  /** Questions this slot adds to the turn schema. */
  questions(ctx: SlotContext): QuestionMap;
  /** Interpret the answers to those questions. */
  fill(answers: AnswerMap, ctx: SlotContext): SlotOutcome;
  /** DTMF fallback: how many digits to collect and how to parse them. Absent: the slot has no
   * keypad rung; its retry ladder is retry, retry, agent. */
  dtmf?: {
    length: number;
    parse(digits: string, ctx: SlotContext): SlotCandidate | null;
  };
  display(value: string): string;
}
