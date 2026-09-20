import { describe, expect, it } from 'vitest';
import { runTurn } from './turn';
import { newSession } from '../core/session';
import { setupFrame, silenceFrame } from '../channel/frames';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';

const opts = {
  client: new FixtureStubClient([], { sharpness: 0.9, fallback: new HeuristicStubClient() }),
  thresholds: { ...DEFAULT_THRESHOLDS },
  todayIso: '2026-09-18',
  now: () => 1_000,
};

// The rest of runTurn (model calls, client errors, tracing) is covered by
// describe('runTurn') in src/harness-text/runner.test.ts; this file only pins the render wiring.
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
