import { TypeSafeClient } from '@typesafe-ai/sdk';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  JevClientError,
  type AnswerMap, type JevClient, type JevRequest, type JevResponse, type Question, type QuestionMap,
} from './types';

/** Pinned: aliases move between releases and thresholds are calibrated per version. */
export const JEV_MODEL = 'jev-1.13.0';

/**
 * How long a connection to the model may sit idle before it is closed. Node's own fetch closes a
 * pooled connection after four seconds, and a phone caller's turns are further apart than that
 * (listen, think, speak, transcribe), so every ask paid 200 ms or more of TCP and TLS setup on top
 * of the model's own time. Thirty seconds outlasts any gap between turns and stays under the idle
 * cutoff of the usual load balancer, which would otherwise hand a request a socket it has closed.
 */
export const KEEP_ALIVE_MS = 30_000;

/**
 * A fetch whose pooled connections live for `ms` when idle. Undici's own fetch is paired with its
 * own Agent: handing Node's bundled fetch an Agent from the npm package mixes two copies of undici,
 * a known source of version mismatches.
 */
export function keepAliveFetch(ms: number = KEEP_ALIVE_MS): typeof fetch {
  const dispatcher = new Agent({ keepAliveTimeout: ms, keepAliveMaxTimeout: ms });
  return ((input: unknown, init?: object) => undiciFetch(input as never, { ...init, dispatcher } as never)) as unknown as typeof fetch;
}

export interface SdkJevClientOptions {
  apiKey?: string;
  timeoutMs: number;
  maxRetries?: number;
  /** Injected in tests; otherwise a keep-alive fetch (`keepAliveFetch`). */
  fetch?: typeof fetch;
  /** Idle lifetime of a pooled connection when `fetch` is not given; defaults to `KEEP_ALIVE_MS`. */
  keepAliveMs?: number;
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
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: SdkJevClientOptions) {
    this.fetchImpl = opts.fetch ?? keepAliveFetch(opts.keepAliveMs);
    this.client = new TypeSafeClient({
      apiKey: opts.apiKey,
      defaultModel: JEV_MODEL,
      timeout: opts.timeoutMs,
      retry: { maxRetries: opts.maxRetries ?? 1 },
      fetch: this.fetchImpl,
    });
  }

  /**
   * A HEAD to the API's base URL through the same pool the asks use, so the connection is open by
   * the time the caller answers the greeting. The base URL answers 404, which costs nothing and is
   * not an error here; any failure is swallowed, since the first ask simply opens its own.
   */
  async warm(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.client.baseURL, { method: 'HEAD', signal: AbortSignal.timeout(this.opts.timeoutMs) });
      await res.body?.cancel();
    } catch {
      // Best effort: the first ask opens the connection instead.
    }
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
