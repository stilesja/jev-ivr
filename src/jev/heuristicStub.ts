import { choiceAnswer, choiceLabels, noulAnswer, normalize, scoreAnswer, sharp } from './distributions';
import { quietAnswer } from './defaults';
import { estimateTokens, type Answer, type AnswerMap, type JevClient, type JevRequest, type JevResponse, type Question } from './types';
import { NUMBER_WORDS, spokenToDigits } from '../core/extract/spokenNumber';
import { MONTHS, WEEKDAYS } from '../core/extract/date';
import { INTENT_MENU } from '../domain/intents';
import { PROVIDERS } from '../domain/slots/provider';

const INTENT_KEYWORDS: Array<[string, RegExp]> = [
  ['reschedule', /\b(reschedule|move|change|push|different day|another day)\b/],
  ['schedule_new', /\b(schedule|book|make|set up|new appointment)\b/],
  ['cancel', /\bcancel/],
  ['confirm_appointment', /\b(confirm|check|verify|when is|do i have|still on)\b/],
  ['billing', /\b(bill|billing|charge|charged|payment|invoice|insurance|copay|owe)\b/],
  ['agent', /\b(agent|representative|person|human|operator|someone|somebody)\b/],
  ['repeat_prompt', /\b(repeat|say that again|what were the options|didn't hear)\b/],
];

const NUMBER_WORD_DIGIT: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5' };

function textOf(state: unknown): string {
  const s = state as { asr?: { text?: string } } | null;
  return (s?.asr?.text ?? '').toLowerCase();
}

function has(text: string, re: RegExp): boolean {
  return re.test(text);
}

function intentAnswer(text: string, labels: string[]): Answer {
  const hits = INTENT_KEYWORDS.filter(([, re]) => re.test(text)).map(([label]) => label);
  if (hits.length === 0) return choiceAnswer(sharp(labels, 'none', 0.8));
  const probs: Record<string, number> = {};
  for (const l of labels) probs[l] = 0.01;
  probs[hits[0]!] = 0.85;
  for (const h of hits.slice(1)) probs[h] = 0.3;
  return choiceAnswer(normalize(probs));
}

function providerAnswer(text: string, labels: string[]): Answer {
  const hits = PROVIDERS.filter((p) => new RegExp(`\\b${p.name.toLowerCase()}\\b`).test(text)).map((p) => p.key);
  if (hits.length === 0) return choiceAnswer(sharp(labels, 'none', 0.9));
  if (hits.length === 1) return choiceAnswer(sharp(labels, hits[0]!, 0.9));
  const probs: Record<string, number> = {};
  for (const l of labels) probs[l] = 0.01;
  for (const h of hits) probs[h] = 0.45;
  return choiceAnswer(normalize(probs));
}

function numberWordCount(span: string): number {
  return span.split(' ').filter((tok) => /\d/.test(tok) || NUMBER_WORDS.has(tok)).length;
}

function spanAnswer(labels: string[]): Answer {
  // Among spans whose digits satisfy the mask, prefer the most number-bearing
  // tokens, not the most tokens overall: a chunked group ("three hundred
  // fifty five") can mask to eight digits on a truncated prefix that drops
  // trailing number words, so "fewest tokens" picks that truncation over the
  // full phrase. But raw "most tokens" over-corrects the other way, letting
  // non-number filler ("my member id is ...") outweigh a shorter, complete
  // phrase. Break remaining ties toward fewer total tokens to shed that filler.
  const scored = labels
    .filter((l) => l !== 'none')
    .map((l) => ({ l, digits: spokenToDigits(l), numberWords: numberWordCount(l), tokens: l.split(' ').length }))
    .filter((x) => x.digits.length === 8)
    .sort((a, b) => b.numberWords - a.numberWords || a.tokens - b.tokens);
  return choiceAnswer(sharp(labels, scored[0]?.l ?? 'none', 0.9));
}

function bestDigits(text: string): string {
  return spokenToDigits(text);
}

function dateAnswers(id: string, text: string, labels: string[]): Answer {
  const month = MONTHS.find((m) => has(text, new RegExp(`\\b${m}\\b`)));
  const weekday = WEEKDAYS.find((w) => has(text, new RegExp(`\\b${w}\\b`)));
  const window = has(text, /\bnext week\b/) ? 'next_week' : has(text, /\bthis week\b/) ? 'this_week'
    : has(text, /\bnext month\b/) ? 'next_month' : has(text, /\bthis month\b/) ? 'this_month' : 'none';
  const relative = has(text, /\bday after tomorrow\b/) ? 'day_after_tomorrow' : has(text, /\btomorrow\b/) ? 'tomorrow' : has(text, /\btoday\b/) ? 'today' : 'none';
  const dayMatch = month ? new RegExp(`\\b${month}\\s+(?:the\\s+)?(\\d{1,2})`).exec(text) : null;
  const day = dayMatch ? dayMatch[1]! : 'none';
  // "Tuesday of next week" names a day: the week window only qualifies which Tuesday.
  const weekWindow = window === 'next_week' || window === 'this_week' ? window : null;
  const weekdayInWindow = weekday && weekWindow ? weekday : null;
  const qualifier = weekday && has(text, new RegExp(`\\bnext\\s+${weekday}\\b`)) ? 'next'
    : weekday && has(text, new RegExp(`\\bthis\\s+${weekday}\\b`)) ? 'this'
    : weekdayInWindow ? (weekWindow === 'next_week' ? 'next' : 'this') : 'none';
  const effectiveWindow = weekdayInWindow ? 'none' : window;
  const mode = weekdayInWindow ? 'weekday'
    : effectiveWindow !== 'none' ? 'window' : relative !== 'none' ? 'relative_day' : weekday ? 'weekday' : month ? 'absolute' : 'none';
  const pick = (v: string) => choiceAnswer(sharp(labels, labels.includes(v) ? v : 'none', 0.88));
  switch (id) {
    case 'dateMode': return pick(mode);
    case 'dateMonth': return pick(month ?? 'none');
    case 'dateDay': return pick(day);
    case 'dateWeekday': return pick(weekday ?? 'none');
    case 'dateWeekdayQualifier': return pick(qualifier);
    case 'dateRelativeDay': return pick(relative);
    case 'dateWindow': return pick(effectiveWindow);
    default: return pick('none');
  }
}

export function answerHeuristically(id: string, q: Question, text: string): Answer {
  if (q.type === 'choice') {
    const labels = choiceLabels(q);
    switch (id) {
      case 'intent': return intentAnswer(text, labels);
      case 'provider': return providerAnswer(text, labels);
      case 'memberIdSpan': return spanAnswer(labels);
      case 'menuNumberSaid': {
        const tok = text.trim().split(/\s+/)[0] ?? '';
        const digit = /^\d$/.test(tok) ? tok : NUMBER_WORD_DIGIT[tok];
        const ok = digit && INTENT_MENU.some((m) => m.digit === digit);
        return choiceAnswer(sharp(labels, ok ? digit! : 'none', 0.9));
      }
      case 'languageSwitch':
        return choiceAnswer(sharp(labels, has(text, /\b(spanish|espanol|español)\b/) ? 'es' : has(text, /\b(french|francais)\b/) ? 'fr' : 'none', 0.9));
      default:
        if (id.startsWith('date')) return dateAnswers(id, text, labels);
        return quietAnswer(id, q, 0.9);
    }
  }
  if (q.type === 'score') {
    const labels = q.levels.map((l) => l.label);
    if (id === 'frustration') {
      const high = has(text, /\b(ridiculous|stupid|damn|hell|third time|already told|frustrat\w*|ugh|useless)\b/);
      const mild = has(text, /\b(come on|seriously|again|hurry)\b/);
      return scoreAnswer(q, sharp(labels, high ? 'high' : mild ? 'mild' : 'none', 0.7));
    }
    if (id === 'urgency') {
      return scoreAnswer(q, sharp(labels, has(text, /\b(urgent|emergency|asap|right away|today)\b/) ? 'high' : 'normal', 0.6));
    }
    return quietAnswer(id, q, 0.9);
  }
  switch (id) {
    case 'intelligible': return noulAnswer(/[a-z]{2,}/.test(text) ? 0.9 : 0.3);
    case 'utteranceComplete': return noulAnswer(/\b(um|uh|and)\s*$/.test(text) ? 0.3 : 0.85);
    case 'wantsHuman': return noulAnswer(has(text, /\b(agent|representative|person|human|operator|someone|somebody)\b/) ? 0.9 : 0.05);
    case 'confusedByPrompt': return noulAnswer(has(text, /\b(what|huh|pardon|sorry)\b\??$/) ? 0.7 : 0.1);
    case 'spokeAMenuNumber': return noulAnswer(/^(press\s+)?(\d|one|two|three|four|five|zero)$/.test(text.trim()) ? 0.9 : 0.05);
    case 'triedSelfService': return noulAnswer(has(text, /\b(website|online|the app|portal)\b/) ? 0.8 : 0.1);
    case 'containsMemberId': return noulAnswer(bestDigits(text).length >= 4 ? 0.9 : 0.05);
    case 'memberIdComplete': return noulAnswer(bestDigits(text).length >= 8 ? 0.9 : 0.4);
    case 'confirmsYes': return noulAnswer(has(text, /\b(yes|yeah|yep|correct|right|sure|that's it)\b/) ? 0.9 : 0.1);
    case 'confirmsNo': return noulAnswer(has(text, /\b(no|nope|wrong|not|incorrect)\b/) ? 0.9 : 0.1);
    default: return quietAnswer(id, q, 0.9);
  }
}

/** Development aid for the REPL. Never used by the regression suite. */
export class HeuristicStubClient implements JevClient {
  async ask(req: JevRequest): Promise<JevResponse> {
    const text = textOf(req.state);
    const answers: AnswerMap = {};
    for (const [id, q] of Object.entries(req.questions)) answers[id] = answerHeuristically(id, q, text);
    return {
      answers,
      model: 'stub-heuristic',
      usage: { inputTokens: estimateTokens(req.state) + estimateTokens(req.questions), outputTokens: 0, estimated: true },
      latencyMs: 0,
      source: 'stub:heuristic',
    };
  }
}
