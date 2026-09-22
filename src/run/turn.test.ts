import { describe, expect, it, vi } from 'vitest';
import { runTurn, type RunOptions, type TurnObserver } from './turn';
import { newSession } from '../core/session';
import { promptFrame, setupFrame, silenceFrame } from '../channel/frames';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { JevClientError, type JevClient } from '../jev/types';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus } from '../jev/corpus';
import { DEFAULT_CORPUS_FILE } from './client';

const opts = {
  client: new FixtureStubClient([], { sharpness: 0.9, fallback: new HeuristicStubClient() }),
  thresholds: { ...DEFAULT_THRESHOLDS },
  todayIso: '2026-09-18',
  now: () => 1_000,
};

// Broader coverage of runTurn (model calls, client errors, tracing) lives in describe('runTurn')
// in src/harness-text/runner.test.ts; this file pins the render wiring and the observer hook.
describe('runTurn render context', () => {
  it('renders a play frame when render context has clips, and text otherwise', async () => {
    const render = { clips: new Map([['greeting.0', 'greeting.0.wav']]), audioBase: 'https://h/audio/' };
    const withRender = await runTurn(newSession('s', 0), setupFrame('s'), { ...opts, render });
    expect(withRender.result.frames[0]).toEqual({ type: 'play', source: 'https://h/audio/greeting.0.wav', loop: 1, preemptible: false, interruptible: true });

    const withoutRender = await runTurn(newSession('s', 0), setupFrame('s'), opts);
    expect(withoutRender.result.frames[0]).toMatchObject({ type: 'text' });

    const withNullRender = await runTurn(newSession('s', 0), setupFrame('s'), { ...opts, render: null });
    expect(withNullRender.result.frames[0]).toMatchObject({ type: 'text' });
  });
});

describe('runTurn trace source', () => {
  it('records source "silence" and no questions for a silence turn, with no model call', async () => {
    const greeted = await runTurn(newSession('s', 0), setupFrame('s'), opts);
    const run = await runTurn(greeted.result.session, silenceFrame(), opts);
    expect(run.response).toBeNull();
    expect(run.record.source).toBe('silence');
    expect(run.record.questions).toBeNull();
    expect(run.record.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_intent' });
  });
});

function observedOpts(client: JevClient, observe?: TurnObserver): RunOptions {
  return { ...opts, client, observe, now: () => 1_700_000_000_000 };
}

describe('runTurn observer', () => {
  const fixture = new FixtureStubClient(loadCorpus(DEFAULT_CORPUS_FILE), { sharpness: 0.9, fallback: new HeuristicStubClient() });

  it('fires asked before the client and turn after, with the record', async () => {
    const order: string[] = [];
    const seen: { questions: unknown; client: unknown } = { questions: null, client: null };
    // runTurn wraps observer calls in try/catch (they're best-effort), so an `expect` thrown
    // inside the `turn` callback below would be swallowed and the test would stay green even if
    // it failed. Capture what the callback saw and assert on it after the `await` instead.
    let turnRecord: { turnIndex: number } | undefined;
    let turnAt: number | undefined;
    const client: JevClient = {
      ask: async (req) => { order.push('client'); seen.client = req.questions; return fixture.ask(req); },
    } as JevClient;
    const observe: TurnObserver = {
      asked: (questions) => { order.push('asked'); seen.questions = questions; },
      // The first turn resolved on a session runs bookkeep(), which increments turnIndex from 0 to 1
      // before the trace record is built (see src/core/turn.ts).
      turn: (record, at) => { order.push('turn'); turnRecord = record; turnAt = at; },
    };
    const session = newSession('CA1', 1_700_000_000_000);
    await runTurn(session, promptFrame("I need to reschedule my appointment, it's with Dr. Chen sometime next week"), observedOpts(client, observe));
    expect(order).toEqual(['asked', 'client', 'turn']);
    expect(seen.questions).toBe(seen.client);
    expect(turnRecord?.turnIndex).toBe(1);
    expect(turnAt).toBe(1_700_000_000_000);
  });

  it('does not break the turn when both asked and turn throw', async () => {
    const throwingObserve: TurnObserver = {
      asked: () => { throw new Error('boom from asked'); },
      turn: () => { throw new Error('boom from turn'); },
    };
    const event = promptFrame("I need to reschedule my appointment, it's with Dr. Chen sometime next week");
    const withoutObserver = await runTurn(newSession('CA1', 1_700_000_000_000), event, observedOpts(fixture));
    const withThrowingObserver = await runTurn(newSession('CA1', 1_700_000_000_000), event, observedOpts(fixture, throwingObserve));
    expect(withThrowingObserver.record).toBeDefined();
    expect(withThrowingObserver.record.decision).toEqual(withoutObserver.record.decision);
  });

  it('fires turn but not asked when the model is not needed', async () => {
    const observe = { asked: vi.fn(), turn: vi.fn() };
    const session = newSession('CA1', 0);
    // A setup frame plans the greeting without asking the model.
    await runTurn(session, setupFrame('CA1'), observedOpts(fixture, observe));
    expect(observe.asked).not.toHaveBeenCalled();
    expect(observe.turn).toHaveBeenCalledTimes(1);
  });

  it('fires turn when the client throws a client error', async () => {
    const observe = { asked: vi.fn(), turn: vi.fn() };
    // JevClientError's constructor is (message, cause); the message is what turn.ts copies onto the record.
    const failing = { ask: async () => { throw new JevClientError('injected', 'timeout'); } } as unknown as JevClient;
    const session = newSession('CA1', 0);
    await runTurn(session, promptFrame('hello'), observedOpts(failing, observe));
    expect(observe.asked).toHaveBeenCalledTimes(1);
    expect(observe.turn).toHaveBeenCalledTimes(1);
    expect(observe.turn.mock.calls[0]![0].error?.message).toBe('injected');
  });

  it('records queued tasks, the pending confirmation and promptedFor on the trace record', async () => {
    const session = newSession('CA1', 0);
    const run = await runTurn(
      session,
      promptFrame('I need to reschedule my appointment with Dr. Alvarez for next Thursday, and also I have a question about my bill'),
      observedOpts(fixture),
    );
    expect(run.record.queued).toEqual(['billing']);
    expect(run.record.pendingConfirmation).toBeNull();
    expect(run.record.promptedFor).toBe('name');
  });
});
