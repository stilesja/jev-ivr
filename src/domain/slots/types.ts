import type { AnswerMap, QuestionMap } from '../../jev/types';
import type { Thresholds } from '../../core/thresholds';
import type { DateWindow } from '../../core/extract/date';
import type { SlotId } from '../forms';

export interface SlotContext {
  text: string;
  candidateSpans: string[];
  todayIso: string;
  thresholds: Thresholds;
  /** the date window the caller already narrowed to, when one is pending */
  window?: DateWindow | null;
}

export interface SlotCandidate {
  value: string;
  display: string;
}

export type SlotOutcome =
  | { kind: 'absent' }
  | { kind: 'filled'; value: string; display: string; confidence: number; confirm: 'none' | 'implicit' }
  | { kind: 'disambiguate'; a: SlotCandidate; b: SlotCandidate }
  | { kind: 'window'; window: DateWindow; confidence: number }
  | { kind: 'invalid'; reason: string; raw: string };

export interface SlotSpec {
  id: SlotId;
  /** Questions this slot adds to the turn schema. */
  questions(ctx: SlotContext): QuestionMap;
  /** Interpret the answers to those questions. */
  fill(answers: AnswerMap, ctx: SlotContext): SlotOutcome;
  /** DTMF fallback: how many digits to collect and how to parse them. */
  dtmf: {
    length: number;
    parse(digits: string, ctx: SlotContext): SlotCandidate | null;
  };
  display(value: string): string;
}
