import { choiceAnswer, choiceLabels, noulAnswer, normalize, scoreAnswer, sharp } from './distributions';
import { quietAnswer } from './defaults';
import { estimateTokens, type Answer, type AnswerMap, type JevClient, type JevRequest, type JevResponse, type Question } from './types';
import { NUMBER_WORDS, spokenToDigits, tokenize } from '../core/extract/spokenNumber';
import { MONTHS, WEEKDAYS, normalizeYear } from '../core/extract/date';
import { candidateSpans, candidateWordSpans, FILLER_WORDS, MAX_WORD_NGRAM } from '../core/spans';
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
  ['capabilities', /\b(what (can|do) you do|what are you|what (are|is) my options|what can i (do|say|ask)|what is this|what does this do|what else can you do)\b/],
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

/**
 * A caller announcing themselves. The stub sees lowercased raw text; tokenize() splits a
 * contraction at the apostrophe, so the markers are matched against the token stream
 * ("it's" -> "it s") rather than the raw string.
 */
const NAME_MARKER = /\b(?:my name is|name is|this is|it s|i m)\s+(.+)$/;

/**
 * Names are short: "Anna", "Jason Stiles", "Mary Kate O Neil". The cap is the span generator's
 * own MAX_WORD_NGRAM, so the stub can accept every span candidateWordSpans offers it: a shorter
 * cap silently took the longest accepted prefix instead, filling "Mary-Kate O'Neil" (four tokens
 * once tokenize strips the hyphen and the apostrophe) with "mary kate o". NON_NAME_WORDS is what
 * keeps a four-word reason for calling out, not the length.
 */
const MAX_NAME_WORDS = MAX_WORD_NGRAM;

/**
 * Words a name span may not contain anywhere. FILLER_WORDS only keeps a candidate span from
 * starting or ending with one, which is not enough after a marker: "this is regarding a
 * scheduling issue" offers "regarding a scheduling" as a span, and without this the stub
 * answered with the caller's reason for calling as their name. The few words added here are
 * ones said around a name rather than in one -- a member ID's label, and the title that marks
 * a name as the doctor's ("this is dr chen calling"), which is never the caller's own.
 */
const NON_NAME_WORDS: ReadonlySet<string> = new Set([
  ...FILLER_WORDS, 'about', 'regarding', 'member', 'id', 'number', 'dr', 'doctor',
  'born', 'birthday', 'birth', ...MONTHS,
]);

function looksLikeName(span: string): boolean {
  const words = span.split(' ');
  return words.length <= MAX_NAME_WORDS && words.every((w) => !NON_NAME_WORDS.has(w));
}

/** The span the caller offers as their name, or null: the one right after a marker, else a two-word span. */
function nameSpanOf(text: string): string | null {
  const spans = candidateWordSpans(text);
  const tail = NAME_MARKER.exec(tokenize(text).join(' '))?.[1];
  // The longest name-shaped span the text continues with right after "my name is" / "this is" /
  // "it's". Digits in the rest of the utterance are no reason to refuse it: "my name is Jason
  // Stiles, member 4471 8293" gives both, and "jason stiles member" is not a name-shaped span.
  if (tail) {
    const after = [...spans].sort((a, b) => b.length - a.length)
      .find((span) => looksLikeName(span) && (tail === span || tail.startsWith(`${span} `)));
    if (after) return after;
  }
  // No marker: a bare "Jason Stiles", the whole answer and nothing else. A two-word span found
  // anywhere in a longer sentence is not enough -- "reschedule with Dr. Chen next week" offers
  // several, and the doctor's name is not the caller's. No digit test is needed to keep an ID
  // out: candidateWordSpans drops any token with a digit or number word in it, so a spoken or
  // dialled number is never a word span, let alone the whole utterance as one.
  const whole = tokenize(text).join(' ');
  return whole.split(' ').length === 2 && spans.includes(whole) ? whole : null;
}

/** A name is claimed when a marker introduces one, or the whole answer is a two-word name. */
function saysName(text: string): boolean {
  return nameSpanOf(text) !== null;
}

const ORDINAL_IRREGULAR: Record<string, string> = {
  first: 'one', second: 'two', third: 'three', fifth: 'five', eighth: 'eight', ninth: 'nine', twelfth: 'twelve',
};

/** "fifth" -> "five", "twentieth" -> "twenty", "5th" -> "5": an ordinal as the number word it counts. */
function cardinalWord(tok: string): string {
  const digits = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(tok);
  if (digits) return digits[1]!;
  if (ORDINAL_IRREGULAR[tok]) return ORDINAL_IRREGULAR[tok]!;
  if (tok.endsWith('ieth')) return `${tok.slice(0, -4)}y`;
  if (tok.endsWith('th')) return tok.slice(0, -2);
  return tok;
}

const DAY_FILLER = new Set(['of', 'the', 'on']);

/** The day of the month said next to `month`: after it ("March fifth") or before it ("the fifth of March"). */
function dayNearMonth(tokens: string[], at: number): string | null {
  for (const i of [at + 1, at + 2, at - 1, at - 2, at - 3]) {
    const tok = tokens[i];
    if (tok === undefined || DAY_FILLER.has(tok)) continue;
    const n = Number(spokenToDigits(cardinalWord(tok)));
    if (Number.isInteger(n) && n >= 1 && n <= 31) return String(n);
  }
  return null;
}

/**
 * The longest span that reads as a year a living caller could be born in, else null. Only spans
 * that are nothing but number words count: spokenToDigits reads straight through the words around
 * them, so "march fifth nineteen eighty" would otherwise normalize to 1980 and outrank the year
 * itself.
 */
function birthYearSpan(spans: string[], todayIso: string): string | null {
  const thisYear = Number(todayIso.slice(0, 4));
  const years = spans.filter((span) => {
    if (numberWordCount(span) !== span.split(' ').length) return false;
    const y = normalizeYear(span, todayIso);
    return y !== null && y >= 1900 && y <= thisYear;
  });
  return years.sort((a, b) => b.split(' ').length - a.split(' ').length)[0] ?? null;
}

interface DobParts { month: string | null; day: string | null; year: string | null }

function dobParts(text: string, todayIso: string): DobParts {
  const tokens = tokenize(text);
  const at = tokens.findIndex((t) => (MONTHS as readonly string[]).includes(t));
  const month = at >= 0 ? tokens[at]! : null;
  return { month, day: at >= 0 ? dayNearMonth(tokens, at) : null, year: birthYearSpan(candidateSpans(text), todayIso) };
}

/**
 * A birthday, or a year offered on its own in answer to the year question. Two-digit years mean
 * almost any number span reads as a year, so a bare year counts only when it is the whole
 * utterance -- otherwise an eight-digit member ID would look like a date of birth.
 */
function saysDob(text: string, parts: DobParts): boolean {
  if (parts.month !== null && parts.day !== null) return true;
  return parts.year !== null && parts.year === tokenize(text).join(' ');
}

/**
 * An explicit year: four digits, or a spoken year of two or more number words. A bare "12" in
 * "November 12" normalizes to a year too, so the length is what separates a year from a day.
 *
 * The test is "a year was said", not "a year a caller could have been born in": an appointment
 * date is spoken without a year at all, so any year at all means the dob questions own the
 * utterance. Gating on birthYearSpan read the two halves of that inconsistently -- "december
 * 25th 2026" was suppressed as a birthday while "december 25th 2030", one the caller could not
 * have been born in, was still read as a day to be seen on.
 */
function saysExplicitYear(text: string, todayIso: string): boolean {
  return candidateSpans(text).some((span) => {
    const words = span.split(' ');
    if (numberWordCount(span) !== words.length) return false;
    if (!/^\d{4}$/.test(span) && words.length < 2) return false;
    const y = normalizeYear(span, todayIso);
    return y !== null && y >= 1900;
  });
}

function dateAnswers(id: string, text: string, labels: string[], todayIso: string): Answer {
  // "March fifth nineteen eighty" is a birthday, not a day to be seen on: a month and day said
  // with a year of birth belong to the dob questions, which ask about the birth date by name.
  if (saysExplicitYear(text, todayIso)) return choiceAnswer(sharp(labels, 'none', 0.88));
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

/**
 * `todayIso` is the run's date, pinned the way RunOptions pins it for the turn rather than read
 * off the wall clock: it decides which spans read as a year a caller could be born in, and a
 * stub whose answers drift with the calendar is a stub whose failures cannot be reproduced.
 */
export function answerHeuristically(id: string, q: Question, text: string, todayIso: string): Answer {
  if (q.type === 'choice') {
    const labels = choiceLabels(q);
    switch (id) {
      case 'intent': return intentAnswer(text, labels);
      case 'provider': return providerAnswer(text, labels);
      case 'memberIdSpan': return spanAnswer(labels);
      case 'nameSpan': {
        const span = nameSpanOf(text);
        return choiceAnswer(sharp(labels, span !== null && labels.includes(span) ? span : 'none', 0.9));
      }
      case 'dobMonth': return choiceAnswer(sharp(labels, dobParts(text, todayIso).month ?? 'none', 0.9));
      case 'dobDay': return choiceAnswer(sharp(labels, dobParts(text, todayIso).day ?? 'none', 0.9));
      case 'dobYear': {
        const year = dobParts(text, todayIso).year;
        return choiceAnswer(sharp(labels, year !== null && labels.includes(year) ? year : 'none', 0.9));
      }
      case 'changeSlot': {
        // A full member ID spoken here is an answer, not a naming of "memberId" as the field to
        // change (that would just say "my member id" or "the number"), so it never wins changeSlot.
        const fullMemberId = spokenToDigits(text).length >= 8;
        const winner = fullMemberId ? 'none'
          : /\b(day|date|when)\b/.test(text) ? 'date' : /\b(doctor|dr|provider|who)\b/.test(text) ? 'provider'
          : /\b(member|id|number)\b/.test(text) ? 'memberId' : 'none';
        return choiceAnswer(sharp(labels, labels.includes(winner) ? winner : 'none', 0.9));
      }
      case 'providerNameStatus': {
        const named = PROVIDERS.some((p) => new RegExp(`\\b${p.name.toLowerCase()}\\b`).test(text));
        const winner = named ? 'neither'
          : has(text, /\b(no|nope|don'?t know|do not know|not sure|no idea|don'?t have|do not have|can'?t remember|who are the|which doctors)\b/) ? 'no_name'
          : has(text, /^(yes|yeah|yep|i do)\b/) ? 'has_name' : 'neither';
        return choiceAnswer(sharp(labels, winner, 0.9));
      }
      case 'menuNumberSaid': {
        const tok = text.trim().split(/\s+/)[0] ?? '';
        const digit = /^\d$/.test(tok) ? tok : NUMBER_WORD_DIGIT[tok];
        const ok = digit && INTENT_MENU.some((m) => m.digit === digit);
        return choiceAnswer(sharp(labels, ok ? digit! : 'none', 0.9));
      }
      case 'languageSwitch':
        return choiceAnswer(sharp(labels, has(text, /\b(spanish|espanol|español)\b/) ? 'es' : has(text, /\b(french|francais)\b/) ? 'fr' : 'none', 0.9));
      default:
        if (id.startsWith('date')) return dateAnswers(id, text, labels, todayIso);
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
    case 'nameGiven': return noulAnswer(saysName(text) ? 0.9 : 0.05);
    case 'dobGiven': return noulAnswer(saysDob(text, dobParts(text, todayIso)) ? 0.9 : 0.05);
    case 'containsMemberId': return noulAnswer(bestDigits(text).length >= 4 ? 0.9 : 0.05);
    case 'memberIdComplete': return noulAnswer(bestDigits(text).length >= 8 ? 0.9 : 0.4);
    case 'confirmsYes': return noulAnswer(has(text, /\b(yes|yeah|yep|correct|right|sure|that's it)\b/) ? 0.9 : 0.1);
    case 'confirmsNo': return noulAnswer(has(text, /\b(no|nope|wrong|not|incorrect)\b/) ? 0.9 : 0.1);
    default: return quietAnswer(id, q, 0.9);
  }
}

/**
 * Development aid for the REPL, and the fixture stub's fallback for an unlabelled utterance.
 * Never the source of the regression baseline.
 *
 * `todayIso` pins what counts as a birth year. A caller that leaves it out gets the wall clock,
 * which is what the server wants; the harness passes the run's own date (see buildClient), so a
 * replay a year later answers exactly as it did the first time.
 */
export class HeuristicStubClient implements JevClient {
  private readonly todayIso: string;

  constructor(opts: { todayIso?: string } = {}) {
    this.todayIso = opts.todayIso ?? new Date().toISOString().slice(0, 10);
  }

  async ask(req: JevRequest): Promise<JevResponse> {
    const text = textOf(req.state);
    const answers: AnswerMap = {};
    for (const [id, q] of Object.entries(req.questions)) answers[id] = answerHeuristically(id, q, text, this.todayIso);
    return {
      answers,
      model: 'stub-heuristic',
      usage: { inputTokens: estimateTokens(req.state) + estimateTokens(req.questions), outputTokens: 0, estimated: true },
      latencyMs: 0,
      source: 'stub:heuristic',
    };
  }
}
