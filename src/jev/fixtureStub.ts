import { choiceAnswer, choiceLabels, noulAnswer, normalize, scoreAnswer, sharp } from './distributions';
import { quietAnswer } from './defaults';
import { normalizeText, type CorpusEntry, type DateLabel } from './corpus';
import {
  JevClientError, estimateTokens,
  type Answer, type AnswerMap, type JevClient, type JevRequest, type JevResponse, type Question,
} from './types';

export interface FixtureStubOptions {
  sharpness: number;
  /** answers utterances not in the corpus */
  fallback: JevClient;
  /** return true to make the nth ask (1-based) reject with a timeout error */
  injectFailure?: (callIndex: number) => boolean;
}

const DATE_IDS: Record<string, keyof DateLabel> = {
  dateMode: 'mode',
  dateMonth: 'month',
  dateDay: 'day',
  dateWeekday: 'weekday',
  dateWeekdayQualifier: 'weekdayQualifier',
  dateRelativeDay: 'relativeDay',
  dateWindow: 'window',
};

function textOf(state: unknown): string {
  const s = state as { asr?: { text?: string } } | null;
  return s?.asr?.text ?? '';
}

function labeledAnswer(id: string, q: Question, entry: CorpusEntry, sharpness: number): Answer {
  const slots = entry.slots ?? {};
  if (q.type === 'choice') {
    const labels = choiceLabels(q);
    const pick = (v: string | undefined) => choiceAnswer(sharp(labels, v && labels.includes(v) ? v : 'none', sharpness));
    if (id === 'intent') return pick(entry.intent);
    if (id === 'provider') return pick(slots.provider);
    if (id === 'memberIdSpan') {
      const span = slots.memberId?.span;
      const exact = span && labels.includes(span) ? span : labels.find((l) => span && l.includes(span));
      return pick(exact);
    }
    if (id in DATE_IDS) return pick(slots.date?.[DATE_IDS[id]!]);
    return quietAnswer(id, q, sharpness);
  }
  if (q.type === 'noul') {
    if (id === 'containsMemberId') return noulAnswer(slots.memberId ? 0.92 : 0.05);
    if (id === 'memberIdComplete') return noulAnswer(slots.memberId ? 0.9 : 0.4);
    if (id === 'wantsHuman') return noulAnswer(entry.intent === 'agent' ? 0.9 : 0.04);
    return quietAnswer(id, q, sharpness);
  }
  return quietAnswer(id, q, sharpness);
}

function applyOverride(answer: Answer, q: Question, override: { noul?: number; probabilities?: Record<string, number> }): Answer {
  if (answer.type === 'noul') return override.noul === undefined ? answer : noulAnswer(override.noul);
  if (!override.probabilities) return answer;
  const labels = answer.type === 'choice' ? choiceLabels(q as Extract<Question, { type: 'choice' }>) : (q as Extract<Question, { type: 'score' }>).levels.map((l) => l.label);
  const given = override.probabilities;
  const givenMass = Object.values(given).reduce((a, b) => a + b, 0);
  const rest = labels.filter((l) => !(l in given));
  const probs: Record<string, number> = {};
  for (const l of labels) probs[l] = l in given ? given[l]! : rest.length ? Math.max(0, 1 - givenMass) / rest.length : 0;
  const normalized = normalize(probs);
  return answer.type === 'choice' ? choiceAnswer(normalized) : scoreAnswer(q as Extract<Question, { type: 'score' }>, normalized);
}

/** Deterministic answers from corpus labels. Unknown utterances go to the fallback. */
export class FixtureStubClient implements JevClient {
  private readonly index = new Map<string, CorpusEntry>();
  private calls = 0;

  constructor(entries: CorpusEntry[], private readonly opts: FixtureStubOptions) {
    for (const e of entries) this.index.set(normalizeText(e.text), e);
  }

  lookup(text: string): CorpusEntry | undefined {
    return this.index.get(normalizeText(text));
  }

  async ask(req: JevRequest): Promise<JevResponse> {
    this.calls += 1;
    if (this.opts.injectFailure?.(this.calls)) throw new JevClientError('injected timeout');
    const entry = this.lookup(textOf(req.state));
    if (!entry) return this.opts.fallback.ask(req);
    const answers: AnswerMap = {};
    for (const [id, q] of Object.entries(req.questions)) {
      let a = labeledAnswer(id, q, entry, this.opts.sharpness);
      const override = entry.answers?.[id];
      if (override) a = applyOverride(a, q, override);
      answers[id] = a;
    }
    return {
      answers,
      model: 'stub-fixture',
      usage: { inputTokens: estimateTokens(req.state) + estimateTokens(req.questions), outputTokens: 0, estimated: true },
      latencyMs: 0,
      source: 'stub:fixture',
    };
  }
}
