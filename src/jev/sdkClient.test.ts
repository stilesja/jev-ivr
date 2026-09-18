import { describe, expect, it } from 'vitest';
import { SdkJevClient, toSdkQuestions, fromSdkAnswers, JEV_MODEL } from './sdkClient';
import type { QuestionMap } from './types';

const questions: QuestionMap = {
  intent: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: null } },
  frustration: { type: 'score', instructions: 'How?', levels: [{ label: 'none', description: 'calm' }, { label: 'high', description: 'angry' }] },
  ok: { type: 'noul', instructions: 'Is it?', criteria: { true: 'yes means yes' } },
};

describe('toSdkQuestions', () => {
  it('maps our types to the SDK wire shape', () => {
    expect(toSdkQuestions(questions)).toEqual({
      intent: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: null } },
      frustration: { type: 'score', instructions: 'How?', criteria: ['none: calm', 'high: angry'] },
      ok: { type: 'noul', instructions: 'Is it?', criteria: { true: 'yes means yes' } },
    });
  });
});

describe('fromSdkAnswers', () => {
  it('relabels score probabilities by level and passes choice and noul through', () => {
    const answers = fromSdkAnswers(questions, {
      intent: { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.7 },
      frustration: { type: 'score', score: 1.8, legend: { 0: 'none: calm', 1: 'high: angry' }, probabilities: { 0: 0.2, 1: 0.8 }, confidence: 0.8 },
      ok: { type: 'noul', noul: 0.42 },
    });
    expect(answers.intent).toEqual({ type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.7 });
    expect(answers.frustration).toEqual({ type: 'score', score: 1.8, probabilities: { none: 0.2, high: 0.8 }, confidence: 0.8 });
    expect(answers.ok).toEqual({ type: 'noul', noul: 0.42 });
  });

  it('throws when a score level probability is missing', () => {
    expect(() =>
      fromSdkAnswers(questions, {
        intent: { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.7 },
        frustration: { type: 'score', score: 1.8, legend: { 0: 'none: calm' }, probabilities: { 0: 1 }, confidence: 0.8 },
        ok: { type: 'noul', noul: 0.42 },
      }),
    ).toThrow(/missing score probability/);
  });
});

describe('SdkJevClient', () => {
  it('posts to systemone with the pinned model and measures latency', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({
        model: JEV_MODEL,
        answers: { ok: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 120, output_tokens: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new SdkJevClient({ apiKey: 'test-key', timeoutMs: 1000, fetch: fetchImpl as typeof fetch });
    const res = await client.ask({ state: { asr: { text: 'hi' } }, questions: { ok: questions.ok! } });
    expect(captured!.url).toMatch(/\/v1\/systemone$/);
    expect(captured!.body).toMatchObject({ model: JEV_MODEL, state: { asr: { text: 'hi' } } });
    expect(res.answers.ok).toEqual({ type: 'noul', noul: 0.9 });
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 0, estimated: false });
    expect(res.source).toBe('jev');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
