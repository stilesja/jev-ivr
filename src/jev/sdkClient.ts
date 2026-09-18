import { TypeSafeClient } from '@typesafe-ai/sdk';
import {
  JevClientError,
  type AnswerMap, type JevClient, type JevRequest, type JevResponse, type Question, type QuestionMap,
} from './types';

/** Pinned: aliases move between releases and thresholds are calibrated per version. */
export const JEV_MODEL = 'jev-1.13.0';

export interface SdkJevClientOptions {
  apiKey?: string;
  timeoutMs: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

type SdkQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } };

export function toSdkQuestions(questions: QuestionMap): Record<string, SdkQuestion> {
  const out: Record<string, SdkQuestion> = {};
  for (const [id, q] of Object.entries(questions)) {
    switch (q.type) {
      case 'choice':
        out[id] = { type: 'choice', instructions: q.instructions, criteria: q.criteria };
        break;
      case 'score':
        out[id] = { type: 'score', instructions: q.instructions, criteria: q.levels.map((l) => `${l.label}: ${l.description}`) };
        break;
      case 'noul':
        out[id] = q.criteria ? { type: 'noul', instructions: q.instructions, criteria: q.criteria } : { type: 'noul', instructions: q.instructions };
        break;
    }
  }
  return out;
}

interface RawAnswer {
  type: string;
  choice?: string;
  score?: number;
  noul?: number;
  /** Present on real score answers (rubric text keyed by zero-based index string); unused here. */
  legend?: Record<string, unknown>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export function fromSdkAnswers(questions: QuestionMap, raw: Record<string, RawAnswer>): AnswerMap {
  const out: AnswerMap = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = raw[id];
    if (!a) throw new JevClientError(`missing answer for ${id}`);
    out[id] = convert(q, a, id);
  }
  return out;
}

function convert(q: Question, a: RawAnswer, id: string): AnswerMap[string] {
  switch (q.type) {
    case 'choice':
      if (a.type !== 'choice' || a.choice === undefined || !a.probabilities) throw new JevClientError(`bad choice answer for ${id}`);
      return { type: 'choice', choice: a.choice, probabilities: a.probabilities, confidence: a.confidence ?? 0 };
    case 'score': {
      if (a.type !== 'score' || a.score === undefined || !a.probabilities) throw new JevClientError(`bad score answer for ${id}`);
      const probabilities: Record<string, number> = {};
      q.levels.forEach((level, i) => {
        const p = a.probabilities![String(i)];
        if (p === undefined) throw new JevClientError(`missing score probability for ${id} level ${i}`);
        probabilities[level.label] = p;
      });
      return { type: 'score', score: a.score, probabilities, confidence: a.confidence ?? 0 };
    }
    case 'noul':
      if (a.type !== 'noul' || a.noul === undefined) throw new JevClientError(`bad noul answer for ${id}`);
      return { type: 'noul', noul: a.noul };
  }
}

export class SdkJevClient implements JevClient {
  private readonly client: TypeSafeClient;

  constructor(private readonly opts: SdkJevClientOptions) {
    this.client = new TypeSafeClient({
      apiKey: opts.apiKey,
      defaultModel: JEV_MODEL,
      timeout: opts.timeoutMs,
      retry: { maxRetries: opts.maxRetries ?? 1 },
      fetch: opts.fetch,
    });
  }

  async ask(req: JevRequest): Promise<JevResponse> {
    const started = performance.now();
    try {
      const result = await this.client.systemOne(
        { state: req.state as never, questions: toSdkQuestions(req.questions) as never, model: JEV_MODEL },
        { signal: req.signal, timeout: req.timeoutMs ?? this.opts.timeoutMs },
      );
      const raw = result as unknown as { model: string; answers: Record<string, RawAnswer>; usage: { input_tokens: number; output_tokens: number } };
      return {
        answers: fromSdkAnswers(req.questions, raw.answers),
        model: raw.model,
        usage: { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens, estimated: false },
        latencyMs: performance.now() - started,
        source: 'jev',
      };
    } catch (e) {
      if (e instanceof JevClientError) throw e;
      throw new JevClientError(e instanceof Error ? e.message : String(e), e);
    }
  }
}
