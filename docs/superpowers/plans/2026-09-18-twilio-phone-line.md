# Twilio Phone Line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the existing decision core on a real Twilio number over ConversationRelay: voice webhook, signed callbacks, WebSocket adapter with a per-call turn queue, DTMF, agent handoff via `<Dial>`, reconnect, raw frame logs, and replay through the text harness.

**Architecture:** A thin `src/server/` layer over the unchanged core. `runTurn` moves to `src/run/` so the CLI and the server share one path. The adapter maps socket messages to core events and decisions to socket messages; a session store keyed by call SID serializes turns per call. TwiML is four fixed documents; signature validation is a short HMAC.

**Tech Stack:** Node 20+, TypeScript strict ESM, `node:http`, `ws` 8, vitest. No framework, no `twilio` SDK.

**Spec:** `docs/superpowers/specs/2026-09-18-twilio-phone-line-design.md`. Read it first. The plan wins on small conflicts; each is marked "Deviation:".

**Conventions for every task:**

- Tests colocated as `*.test.ts`; run one with `pnpm vitest run <path>`, all with `pnpm test`.
- Extensionless imports; strict TS; `noUncheckedIndexedAccess` is on.
- Commit after every task with the message shown, one task per commit, exactly one writer at a time.
- `src/core`, `src/domain`, `src/jev`, `src/prompts`, `src/trace` are not modified in this plan except `src/channel/frames.ts` (Task 2).
- Today in tests is `2026-09-18` (a Friday); corpus utterances used in tests must exist in `fixtures/corpus.jsonl`.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/run/turn.ts` | `runTurn`, `RunOptions`, `TurnRun`, `nowOf` (moved from harness runner) |
| `src/run/client.ts` | `buildClient`, `buildThresholds` (moved from CLI) |
| `src/channel/frames.ts` | `SetupFrame` gains Twilio's optional fields |
| `src/channel/wire.ts` | `parseInbound(raw)` with validation, `serializeOutbound(frame)` |
| `src/server/config.ts` | env parsing, defaults, masked description |
| `src/server/signature.ts` | Twilio request signature compute and validate |
| `src/server/twiml.ts` | TwiML documents |
| `src/server/hints.ts` | ConversationRelay `hints` string from domain tables |
| `src/server/tokens.ts` | per-call socket tokens |
| `src/server/frameLog.ts` | raw frame JSONL writer and reader |
| `src/server/sessions.ts` | `SessionStore` with per-call queue |
| `src/server/adapter.ts` | socket message to core event, decision to socket messages |
| `src/server/http.ts` | `/voice`, `/cr-action`, `/health` |
| `src/server/ws.ts` | upgrade handling and connection context |
| `src/server/index.ts` | `startServer(config)`, entry point |
| `src/testing/fakeRelay.ts` | test client speaking the ConversationRelay protocol |
| `src/harness-text/replay.ts` | replay a frame log through `runTurn` |
| `src/harness-text/cli.ts` | gains `--replay` |
| `.env.example`, `README.md` | config and live-call checklist |

---

### Task 1: Move `runTurn` and client builders into `src/run/`

**Files:**
- Create: `src/run/turn.ts`, `src/run/client.ts`
- Modify: `src/harness-text/runner.ts`, `src/harness-text/cli.ts`, `src/harness-text/regress.ts`, `package.json`

Pure refactor; every existing test must pass unchanged.

- [ ] **Step 1: Add the `ws` dependency and the server script**

Run: `pnpm add ws@^8.18.0 && pnpm add -D @types/ws@^8.5.0`

Then add to `package.json` scripts:

```json
"server": "tsx src/server/index.ts"
```

- [ ] **Step 2: Create `src/run/turn.ts`**

Move the following from `src/harness-text/runner.ts` verbatim (imports adjusted to the new location): the `RunOptions` interface, `nowOf`, the `TurnRun` interface, and `runTurn`. Export all four (`nowOf` becomes exported).

```ts
import { performance } from 'node:perf_hooks';
import type { InboundFrame } from '../channel/frames';
import { plan, resolve, type TurnContext, type TurnError, type TurnResult } from '../core/turn';
import type { Session } from '../core/session';
import type { Thresholds } from '../core/thresholds';
import { JevClientError, type JevClient, type JevResponse, type JsonValue, type QuestionMap } from '../jev/types';
import { buildTraceRecord, type TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';

export interface RunOptions {
  client: JevClient;
  thresholds: Thresholds;
  todayIso: string;
  trace?: TraceWriter | null;
  now?: () => number;
}

export function nowOf(opts: RunOptions): () => number {
  return opts.now ?? (() => Date.now());
}

export interface TurnRun {
  result: TurnResult;
  questions: QuestionMap | null;
  response: JevResponse | null;
  error: TurnError | null;
  record: TraceRecord;
}

export async function runTurn(session: Session, event: InboundFrame, opts: RunOptions): Promise<TurnRun> {
  // body exactly as in src/harness-text/runner.ts today
}
```

Copy the existing `runTurn` body without change.

- [ ] **Step 3: Create `src/run/client.ts`**

Move `buildThresholds`, `buildClient`, and `DEFAULT_CORPUS_FILE` from `src/harness-text/cli.ts` verbatim:

```ts
import { parseOverride, withOverrides, type Thresholds } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { SdkJevClient } from '../jev/sdkClient';
import type { JevClient } from '../jev/types';

export const DEFAULT_CORPUS_FILE = 'fixtures/corpus.jsonl';

export function buildThresholds(overrides: string[]): Thresholds {
  return withOverrides(Object.assign({}, ...overrides.map(parseOverride)));
}

export function buildClient(kind: string, corpusFile: string, thresholds: Thresholds): JevClient {
  if (kind === 'jev') return new SdkJevClient({ timeoutMs: thresholds.JEV_TIMEOUT_MS });
  if (kind === 'heuristic') return new HeuristicStubClient();
  return new FixtureStubClient(loadCorpus(corpusFile), { sharpness: thresholds.STUB_SHARPNESS, fallback: new HeuristicStubClient() });
}
```

- [ ] **Step 4: Re-export from the old locations**

In `src/harness-text/runner.ts`, delete the moved definitions and add at the top:

```ts
export { runTurn, nowOf, type RunOptions, type TurnRun } from '../run/turn';
import { runTurn, nowOf, type RunOptions, type TurnRun } from '../run/turn';
```

Remove the now-unused imports (`performance`, `plan`, `resolve`, `TurnContext`, `TurnError`, `JevClientError`, `JevResponse`, `JsonValue`, `QuestionMap`, `buildTraceRecord`, `TraceRecord`) if nothing else in the file uses them; typecheck tells you which.

In `src/harness-text/cli.ts`, delete `DEFAULT_CORPUS_FILE`, `buildThresholds`, `buildClient` and their now-unused imports, and add:

```ts
export { buildThresholds, buildClient, DEFAULT_CORPUS_FILE } from '../run/client';
import { buildThresholds, buildClient, DEFAULT_CORPUS_FILE } from '../run/client';
```

`src/harness-text/regress.ts` keeps importing from `../jev/*` directly; no change unless typecheck complains.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm test && pnpm regress`
Expected: typecheck clean, 249 tests pass, `no changes`.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/run src/harness-text/runner.ts src/harness-text/cli.ts
git commit -m "refactor(run): share runTurn and client builders between CLI and server"
```

---

### Task 2: Wire parsing for ConversationRelay messages

**Files:**
- Modify: `src/channel/frames.ts`
- Create: `src/channel/wire.ts`, `src/channel/wire.test.ts`

Deviation, added after review of the first implementation: the committed
`wire.ts` is stricter than the block below. `serializeOutbound` builds each
message from an explicit per-type field list and throws on unknown types;
`parseInbound` caps text fields at `MAX_TEXT_LENGTH` (4000) and
`customParameters` at 50 entries of 500 characters, requires
`durationUntilInterruptMs` to be finite and non-negative, accepts DTMF digits
matching `[0-9*#]` only, and rejects present-but-wrong-typed `lang`, `last`,
`from`, `to`, and `description`. The committed code and tests are the source
of truth.

- [ ] **Step 1: Write the failing test**

`src/channel/wire.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseInbound, serializeOutbound } from './wire';
import { endFrame, textFrame } from './frames';

describe('parseInbound', () => {
  it('parses a setup message and keeps Twilio extras', () => {
    const f = parseInbound(JSON.stringify({
      type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+15550001', to: '+15550002',
      accountSid: 'AC1', direction: 'inbound', callStatus: 'in-progress', customParameters: { a: 'b' },
    }));
    expect(f).toMatchObject({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', accountSid: 'AC1', direction: 'inbound' });
  });

  it('defaults prompt lang and last', () => {
    expect(parseInbound('{"type":"prompt","voicePrompt":"hi"}')).toEqual({ type: 'prompt', voicePrompt: 'hi', lang: 'en-US', last: true });
    expect(parseInbound('{"type":"prompt","voicePrompt":"hi","lang":"en-GB","last":false}')).toEqual({ type: 'prompt', voicePrompt: 'hi', lang: 'en-GB', last: false });
  });

  it('parses dtmf, interrupt and error', () => {
    expect(parseInbound('{"type":"dtmf","digit":"4"}')).toEqual({ type: 'dtmf', digit: '4' });
    expect(parseInbound('{"type":"interrupt","utteranceUntilInterrupt":"wha","durationUntilInterruptMs":300}'))
      .toEqual({ type: 'interrupt', utteranceUntilInterrupt: 'wha', durationUntilInterruptMs: 300 });
    expect(parseInbound('{"type":"error","description":"x"}')).toEqual({ type: 'error', description: 'x' });
  });

  it('returns null for unknown types, bad JSON and missing fields', () => {
    expect(parseInbound('{"type":"nope"}')).toBeNull();
    expect(parseInbound('not json')).toBeNull();
    expect(parseInbound('{"type":"dtmf"}')).toBeNull();
    expect(parseInbound('{"type":"setup","sessionId":"s"}')).toBeNull();
    expect(parseInbound('{"type":"prompt","voicePrompt":5}')).toBeNull();
  });
});

describe('serializeOutbound', () => {
  it('serializes frames with exactly the documented fields', () => {
    expect(JSON.parse(serializeOutbound(textFrame('hi', true)))).toEqual({
      type: 'text', token: 'hi', last: true, lang: 'en-US', interruptible: true, preemptible: false,
    });
    expect(JSON.parse(serializeOutbound(endFrame('completed')))).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed"}' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channel/wire.test.ts`
Expected: FAIL, cannot find module './wire'.

- [ ] **Step 3: Extend `SetupFrame`**

In `src/channel/frames.ts` replace the `SetupFrame` interface with:

```ts
export interface SetupFrame {
  type: 'setup';
  sessionId: string;
  callSid: string;
  from: string;
  to: string;
  customParameters: Record<string, string>;
  // Optional fields Twilio also sends; passed through and logged, never read by the core.
  accountSid?: string;
  parentCallSid?: string;
  forwardedFrom?: string;
  callType?: string;
  callerName?: string;
  direction?: string;
  callStatus?: string;
}
```

`setupFrame()` is unchanged.

- [ ] **Step 4: Write wire.ts**

`src/channel/wire.ts`:

```ts
import { DEFAULT_LANG, type InboundFrame, type OutboundFrame } from './frames';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): v is string {
  return typeof v === 'string';
}

/** Parse one ConversationRelay message. Returns null for anything not in the documented set. */
export function parseInbound(raw: string): InboundFrame | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || !str(m.type)) return null;
  switch (m.type) {
    case 'setup': {
      if (!str(m.sessionId) || !str(m.callSid)) return null;
      const extras: Partial<Extract<InboundFrame, { type: 'setup' }>> = {};
      for (const k of ['accountSid', 'parentCallSid', 'forwardedFrom', 'callType', 'callerName', 'direction', 'callStatus'] as const) {
        if (str(m[k])) extras[k] = m[k] as string;
      }
      const custom: Record<string, string> = {};
      if (isObj(m.customParameters)) for (const [k, v] of Object.entries(m.customParameters)) if (str(v)) custom[k] = v;
      return {
        type: 'setup',
        sessionId: m.sessionId,
        callSid: m.callSid,
        from: str(m.from) ? m.from : '',
        to: str(m.to) ? m.to : '',
        customParameters: custom,
        ...extras,
      };
    }
    case 'prompt':
      if (!str(m.voicePrompt)) return null;
      return {
        type: 'prompt',
        voicePrompt: m.voicePrompt,
        lang: str(m.lang) ? m.lang : DEFAULT_LANG,
        last: typeof m.last === 'boolean' ? m.last : true,
      };
    case 'dtmf':
      if (!str(m.digit) || m.digit.length !== 1) return null;
      return { type: 'dtmf', digit: m.digit };
    case 'interrupt':
      if (!str(m.utteranceUntilInterrupt) || typeof m.durationUntilInterruptMs !== 'number') return null;
      return { type: 'interrupt', utteranceUntilInterrupt: m.utteranceUntilInterrupt, durationUntilInterruptMs: m.durationUntilInterruptMs };
    case 'error':
      return { type: 'error', description: str(m.description) ? m.description : '' };
    default:
      return null;
  }
}

export function serializeOutbound(frame: OutboundFrame): string {
  return JSON.stringify(frame);
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/channel && pnpm typecheck`
Expected: wire tests pass (5), frames tests still pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/channel
git commit -m "feat(channel): parse and validate ConversationRelay wire messages"
```

---

### Task 3: Server configuration

**Files:**
- Create: `src/server/config.ts`, `src/server/config.test.ts`

- [ ] **Step 1: Write the failing test**

`src/server/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, describeConfig } from './config';

const base = { PUBLIC_HOST: 'demo.ngrok.app', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15551234567' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 3000, publicHost: 'demo.ngrok.app', jevClient: 'stub', todayOverride: null,
      traceDir: 'traces', signatureCheck: true, reconnectLimit: 2, sessionTtlMs: 1_800_000,
    });
  });

  it('names the first missing required variable', () => {
    expect(() => loadConfig({ TWILIO_AUTH_TOKEN: 'x', HANDOFF_NUMBER: '+1' })).toThrow('missing required environment variable PUBLIC_HOST');
  });

  it('requires the api key only for the jev client', () => {
    expect(() => loadConfig({ ...base, JEV_CLIENT: 'jev' })).toThrow('TYPESAFE_API_KEY');
    expect(loadConfig({ ...base, JEV_CLIENT: 'jev', TYPESAFE_API_KEY: 'k' }).jevClient).toBe('jev');
    expect(() => loadConfig({ ...base, JEV_CLIENT: 'other' })).toThrow('JEV_CLIENT');
  });

  it('parses numbers and flags', () => {
    const c = loadConfig({ ...base, PORT: '4100', SIGNATURE_CHECK: 'off', RECONNECT_LIMIT: '1', TODAY_OVERRIDE: '2026-09-18' });
    expect(c.port).toBe(4100);
    expect(c.signatureCheck).toBe(false);
    expect(c.reconnectLimit).toBe(1);
    expect(c.todayOverride).toBe('2026-09-18');
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow('PORT');
    expect(() => loadConfig({ ...base, TODAY_OVERRIDE: 'yesterday' })).toThrow('TODAY_OVERRIDE');
  });

  it('masks secrets in the description', () => {
    const text = describeConfig(loadConfig({ ...base, TWILIO_AUTH_TOKEN: 'supersecret' }));
    expect(text).not.toContain('supersecret');
    expect(text).toContain('demo.ngrok.app');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/config.test.ts`
Expected: FAIL, cannot find module './config'.

- [ ] **Step 3: Write config.ts**

`src/server/config.ts`:

```ts
export type ClientKind = 'stub' | 'heuristic' | 'jev';

export interface ServerConfig {
  port: number;
  publicHost: string;
  twilioAuthToken: string;
  handoffNumber: string;
  jevClient: ClientKind;
  typesafeApiKey: string | null;
  todayOverride: string | null;
  traceDir: string;
  signatureCheck: boolean;
  reconnectLimit: number;
  sessionTtlMs: number;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export function loadConfig(env: Env): ServerConfig {
  const publicHost = required(env, 'PUBLIC_HOST').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const twilioAuthToken = required(env, 'TWILIO_AUTH_TOKEN');
  const handoffNumber = required(env, 'HANDOFF_NUMBER');
  const jevClientRaw = env.JEV_CLIENT ?? 'stub';
  if (jevClientRaw !== 'stub' && jevClientRaw !== 'heuristic' && jevClientRaw !== 'jev') {
    throw new Error(`JEV_CLIENT must be stub, heuristic, or jev, got "${jevClientRaw}"`);
  }
  const typesafeApiKey = env.TYPESAFE_API_KEY?.trim() || null;
  if (jevClientRaw === 'jev' && !typesafeApiKey) throw new Error('missing required environment variable TYPESAFE_API_KEY (JEV_CLIENT=jev)');
  const todayOverride = env.TODAY_OVERRIDE?.trim() || null;
  if (todayOverride && !/^\d{4}-\d{2}-\d{2}$/.test(todayOverride)) throw new Error(`TODAY_OVERRIDE must be YYYY-MM-DD, got "${todayOverride}"`);
  const sig = (env.SIGNATURE_CHECK ?? 'on').toLowerCase();
  if (sig !== 'on' && sig !== 'off') throw new Error(`SIGNATURE_CHECK must be on or off, got "${env.SIGNATURE_CHECK}"`);
  return {
    port: integer(env, 'PORT', 3000),
    publicHost,
    twilioAuthToken,
    handoffNumber,
    jevClient: jevClientRaw,
    typesafeApiKey,
    todayOverride,
    traceDir: env.TRACE_DIR?.trim() || 'traces',
    signatureCheck: sig === 'on',
    reconnectLimit: integer(env, 'RECONNECT_LIMIT', 2),
    sessionTtlMs: integer(env, 'SESSION_TTL_MS', 1_800_000),
  };
}

export function describeConfig(c: ServerConfig): string {
  const mask = (s: string | null) => (s ? `${s.slice(0, 2)}…(${s.length})` : 'unset');
  return [
    `port ${c.port}`,
    `public host ${c.publicHost}`,
    `handoff ${c.handoffNumber}`,
    `client ${c.jevClient}`,
    `api key ${mask(c.typesafeApiKey)}`,
    `auth token ${mask(c.twilioAuthToken)}`,
    `signature check ${c.signatureCheck ? 'on' : 'OFF'}`,
    `today ${c.todayOverride ?? 'wall clock'}`,
    `traces ${c.traceDir}`,
    `reconnect limit ${c.reconnectLimit}`,
  ].join('  ');
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/server/config.test.ts && pnpm typecheck`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts src/server/config.test.ts
git commit -m "feat(server): add environment configuration"
```

---

### Task 4: Twilio request signature

**Files:**
- Create: `src/server/signature.ts`, `src/server/signature.test.ts`

The test vector is Twilio's published example, verified locally: URL `https://mycompany.com/myapp.php?foo=1&bar=2`, auth token `12345`, the five parameters below, signature `0/KCTR6DLpKmkAf8muzZqo1nDgQ=`.

- [ ] **Step 1: Write the failing test**

`src/server/signature.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeTwilioSignature, validateTwilioSignature } from './signature';

const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
const token = '12345';
const expected = '0/KCTR6DLpKmkAf8muzZqo1nDgQ=';

describe('twilio signature', () => {
  it('matches the published example', () => {
    expect(computeTwilioSignature(url, params, token)).toBe(expected);
  });
  it('validates a correct header and rejects tampering', () => {
    expect(validateTwilioSignature(url, params, expected, token)).toBe(true);
    expect(validateTwilioSignature(url, { ...params, Digits: '9999' }, expected, token)).toBe(false);
    expect(validateTwilioSignature(url, params, undefined, token)).toBe(false);
    expect(validateTwilioSignature(url, params, 'short', token)).toBe(false);
    expect(validateTwilioSignature(url + '&x=1', params, expected, token)).toBe(false);
  });
  it('sorts parameters by key', () => {
    const shuffled = { To: params.To, Digits: params.Digits, CallSid: params.CallSid, From: params.From, Caller: params.Caller };
    expect(computeTwilioSignature(url, shuffled, token)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/signature.test.ts`
Expected: FAIL, cannot find module './signature'.

- [ ] **Step 3: Write signature.ts**

`src/server/signature.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio request signature: HMAC-SHA1 over the full URL followed by every POST
 * parameter's name and value in sorted key order, base64 encoded.
 */
export function computeTwilioSignature(fullUrl: string, params: Record<string, string>, authToken: string): string {
  const tail = Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(fullUrl + tail).digest('base64');
}

export function validateTwilioSignature(
  fullUrl: string,
  params: Record<string, string>,
  header: string | undefined,
  authToken: string,
): boolean {
  if (!header) return false;
  const expected = Buffer.from(computeTwilioSignature(fullUrl, params, authToken));
  const given = Buffer.from(header);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/server/signature.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/signature.ts src/server/signature.test.ts
git commit -m "feat(server): validate Twilio request signatures"
```

---

### Task 5: TwiML documents and hints

**Files:**
- Create: `src/server/twiml.ts`, `src/server/hints.ts`, `src/server/twiml.test.ts`

- [ ] **Step 1: Write the failing test**

`src/server/twiml.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { connectRelayTwiml, dialTwiml, hangupTwiml, apologizeAndDialTwiml, escapeXml } from './twiml';
import { buildHints } from './hints';

describe('twiml', () => {
  it('builds the ConversationRelay connect document with our attributes', () => {
    const xml = connectRelayTwiml({ publicHost: 'demo.ngrok.app', token: 'abc', hints: 'Dr. Chen, reschedule' });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true);
    expect(xml).toContain('<Connect action="https://demo.ngrok.app/cr-action">');
    expect(xml).toContain('url="wss://demo.ngrok.app/conversation?token=abc"');
    for (const attr of [
      'transcriptionProvider="Deepgram"', 'speechModel="flux"', 'partialPrompts="false"', 'dtmfDetection="true"',
      'interruptible="any"', 'interruptSensitivity="medium"', 'reportInputDuringAgentSpeech="any"',
      'deepgramSmartFormat="false"', 'hints="Dr. Chen, reschedule"',
    ]) expect(xml).toContain(attr);
    expect(xml.endsWith('</Response>')).toBe(true);
  });

  it('escapes attribute values', () => {
    expect(connectRelayTwiml({ publicHost: 'h', token: 'a&b', hints: 'x<y' })).toContain('token=a&amp;b');
    expect(escapeXml('"q" & <t>')).toBe('&quot;q&quot; &amp; &lt;t&gt;');
  });

  it('builds dial, hangup and apologize documents', () => {
    expect(dialTwiml('+15551234567')).toContain('<Dial>+15551234567</Dial>');
    expect(hangupTwiml()).toContain('<Hangup/>');
    const a = apologizeAndDialTwiml('+15551234567');
    expect(a).toContain('<Say>');
    expect(a).toContain('<Dial>+15551234567</Dial>');
  });
});

describe('buildHints', () => {
  it('lists every provider, the intent vocabulary and number words', () => {
    const hints = buildHints();
    for (const name of ['Dr. Chen', 'Dr. Cheng', 'Dr. Alvarez']) expect(hints).toContain(name);
    for (const w of ['reschedule', 'cancel', 'member ID', 'zero', 'nine']) expect(hints).toContain(w);
    expect(hints).not.toContain('"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/twiml.test.ts`
Expected: FAIL, cannot find module './twiml'.

- [ ] **Step 3: Write twiml.ts**

`src/server/twiml.ts`:

```ts
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function response(body: string): string {
  return `${XML_HEAD}<Response>${body}</Response>`;
}

export interface ConnectOptions {
  publicHost: string;
  token: string;
  hints: string;
}

/** The ConversationRelay connect document. Attributes follow the spec's §5 and handoff §10, finals only. */
export function connectRelayTwiml(o: ConnectOptions): string {
  const attrs = [
    `url="wss://${escapeXml(o.publicHost)}/conversation?token=${escapeXml(o.token)}"`,
    'transcriptionProvider="Deepgram"',
    'speechModel="flux"',
    'partialPrompts="false"',
    'dtmfDetection="true"',
    'interruptible="any"',
    'interruptSensitivity="medium"',
    'reportInputDuringAgentSpeech="any"',
    'deepgramSmartFormat="false"',
    `hints="${escapeXml(o.hints)}"`,
  ].join(' ');
  return response(`<Connect action="https://${escapeXml(o.publicHost)}/cr-action"><ConversationRelay ${attrs}/></Connect>`);
}

export function dialTwiml(number: string): string {
  return response(`<Dial>${escapeXml(number)}</Dial>`);
}

export function hangupTwiml(): string {
  return response('<Hangup/>');
}

export function apologizeAndDialTwiml(number: string): string {
  return response(`<Say>Sorry, we lost the connection. Let me get someone to help you.</Say><Dial>${escapeXml(number)}</Dial>`);
}
```

- [ ] **Step 4: Write hints.ts**

`src/server/hints.ts`:

```ts
import { PROVIDERS } from '../domain/slots/provider';

const INTENT_WORDS = [
  'reschedule', 'cancel', 'appointment', 'confirm', 'billing', 'member ID', 'agent', 'representative',
  'schedule', 'book', 'next week', 'this week', 'tomorrow',
];
const NUMBER_WORDS = ['zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'double'];

/** Comma-separated vocabulary for the ConversationRelay `hints` attribute. */
export function buildHints(): string {
  const providers = PROVIDERS.map((p) => `Dr. ${p.name}`);
  return [...providers, ...INTENT_WORDS, ...NUMBER_WORDS].join(', ');
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/server/twiml.test.ts && pnpm typecheck`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/twiml.ts src/server/hints.ts src/server/twiml.test.ts
git commit -m "feat(server): add TwiML documents and transcription hints"
```

---

### Task 6: Call tokens

**Files:**
- Create: `src/server/tokens.ts`, `src/server/tokens.test.ts`

Deviation, added after review: `CallTokens` also has `evictExpired(): number`, called from the server's eviction interval (Task 11), so tokens minted for calls that never connect do not accumulate.

- [ ] **Step 1: Write the failing test**

`src/server/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CallTokens } from './tokens';

describe('CallTokens', () => {
  it('mints a token bound to a call and verifies it once per call', () => {
    let t = 0;
    const tokens = new CallTokens(1000, () => t);
    const tok = tokens.mint('CA1');
    expect(tok).toMatch(/^[0-9a-f]{32}$/);
    expect(tokens.verify(tok, 'CA1')).toBe(true);
    expect(tokens.verify(tok, 'CA2')).toBe(false);
    expect(tokens.verify('nope', 'CA1')).toBe(false);
  });

  it('expires tokens', () => {
    let t = 0;
    const tokens = new CallTokens(1000, () => t);
    const tok = tokens.mint('CA1');
    t = 1001;
    expect(tokens.verify(tok, 'CA1')).toBe(false);
  });

  it('a new mint for the same call replaces the old token', () => {
    const tokens = new CallTokens(1000, () => 0);
    const a = tokens.mint('CA1');
    const b = tokens.mint('CA1');
    expect(tokens.verify(a, 'CA1')).toBe(false);
    expect(tokens.verify(b, 'CA1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/tokens.test.ts`
Expected: FAIL, cannot find module './tokens'.

- [ ] **Step 3: Write tokens.ts**

`src/server/tokens.ts`:

```ts
import { randomBytes } from 'node:crypto';

interface Entry {
  token: string;
  expiresAt: number;
}

/** One live token per call SID, carried in the ConversationRelay URL and checked at setup. */
export class CallTokens {
  private readonly byCall = new Map<string, Entry>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  mint(callSid: string): string {
    const token = randomBytes(16).toString('hex');
    this.byCall.set(callSid, { token, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  verify(token: string, callSid: string): boolean {
    const e = this.byCall.get(callSid);
    if (!e) return false;
    if (this.now() > e.expiresAt) {
      this.byCall.delete(callSid);
      return false;
    }
    return e.token === token;
  }

  revoke(callSid: string): void {
    this.byCall.delete(callSid);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/server/tokens.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/tokens.ts src/server/tokens.test.ts
git commit -m "feat(server): add per-call socket tokens"
```

---

### Task 7: Raw frame log

**Files:**
- Create: `src/server/frameLog.ts`, `src/server/frameLog.test.ts`

Deviation, added after review: `readFrameLog` skips a line that fails to parse (a truncated last line after a crash) instead of throwing, so a crashed call stays replayable. The committed code is the source of truth.

- [ ] **Step 1: Write the failing test**

`src/server/frameLog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameLog, readFrameLog } from './frameLog';

describe('FrameLog', () => {
  it('appends one JSON line per message with direction and timestamp, and reads them back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frames-'));
    const path = join(dir, 'calls', 'CA1.frames.jsonl');
    let t = 1_000;
    const log = new FrameLog(path, () => t);
    log.write('in', { type: 'setup', callSid: 'CA1' });
    t = 1_500;
    log.write('out', { type: 'text', token: 'hi' });
    log.write('http', { route: '/cr-action', CallSid: 'CA1' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ ts: '1970-01-01T00:00:01.000Z', dir: 'in', msg: { type: 'setup', callSid: 'CA1' } });
    expect(readFrameLog(path).map((l) => l.dir)).toEqual(['in', 'out', 'http']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/frameLog.test.ts`
Expected: FAIL, cannot find module './frameLog'.

- [ ] **Step 3: Write frameLog.ts**

`src/server/frameLog.ts`:

```ts
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type FrameDir = 'in' | 'out' | 'http' | 'log';

export interface FrameLogLine {
  ts: string;
  dir: FrameDir;
  msg: unknown;
}

/** Every socket message and webhook for one call, in arrival order. This is what replay consumes. */
export class FrameLog {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(dir: FrameDir, msg: unknown): void {
    const line: FrameLogLine = { ts: new Date(this.now()).toISOString(), dir, msg };
    appendFileSync(this.path, JSON.stringify(line) + '\n');
  }
}

export function readFrameLog(path: string): FrameLogLine[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FrameLogLine);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/server/frameLog.test.ts`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add src/server/frameLog.ts src/server/frameLog.test.ts
git commit -m "feat(server): add raw frame log per call"
```

---

### Task 8: Session store with a per-call queue

**Files:**
- Create: `src/server/sessions.ts`, `src/server/sessions.test.ts`

Deviation, added after review: the committed store makes the queue unpoisonable (a failing frame-log write cannot reject the tail), skips queued work once the entry has ended, tracks in-flight work so `evictIdle` never removes a session mid-turn, and closes a live socket on eviction. The committed code is the source of truth.

- [ ] **Step 1: Write the failing test**

`src/server/sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, type SocketLike } from './sessions';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import { FrameLog } from './frameLog';

function fakeSocket(): SocketLike & { sent: string[]; closed: boolean } {
  const s = { sent: [] as string[], closed: false, send(d: string, cb?: (e?: Error) => void) { s.sent.push(d); cb?.(); }, close() { s.closed = true; } };
  return s;
}

function store(now: () => number, ttl = 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  return new SessionStore((callSid) => ({
    session: newSession(callSid, now()),
    opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), now),
  }), ttl, now);
}

describe('SessionStore', () => {
  it('creates, gets, detaches and attaches', () => {
    const s = store(() => 0);
    const sock = fakeSocket();
    const e = s.create('CA1', sock);
    expect(s.get('CA1')).toBe(e);
    expect(e.socket).toBe(sock);
    s.detach('CA1');
    expect(e.socket).toBeNull();
    const sock2 = fakeSocket();
    expect(s.attach('CA1', sock2)?.socket).toBe(sock2);
    expect(s.attach('CA9', sock2)).toBeUndefined();
    expect(() => s.create('CA1', sock)).toThrow(/exists/);
  });

  it('runs queued work one at a time in order and survives an error', async () => {
    const s = store(() => 0);
    s.create('CA1', fakeSocket());
    const order: string[] = [];
    const p1 = s.enqueue('CA1', async () => { await new Promise((r) => setTimeout(r, 30)); order.push('a'); });
    const p2 = s.enqueue('CA1', async () => { order.push('b'); throw new Error('boom'); });
    const p3 = s.enqueue('CA1', async () => { order.push('c'); });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(await s.enqueue('CA9', async () => {})).toBeUndefined();
  });

  it('ends and evicts idle sessions', () => {
    let t = 0;
    const s = store(() => t, 1000);
    s.create('CA1', fakeSocket());
    s.create('CA2', fakeSocket());
    s.end('CA1');
    expect(s.get('CA1')?.ended).toBe(true);
    t = 500;
    s.touch('CA2');
    t = 1200;
    expect(s.evictIdle().sort()).toEqual(['CA1']);
    t = 1600;
    expect(s.evictIdle()).toEqual(['CA2']);
    expect(s.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/sessions.test.ts`
Expected: FAIL, cannot find module './sessions'.

- [ ] **Step 3: Write sessions.ts**

`src/server/sessions.ts`:

```ts
import type { Session } from '../core/session';
import type { RunOptions } from '../run/turn';
import type { TraceWriter } from '../trace/writer';
import type { FrameLog } from './frameLog';

/** The subset of a ws.WebSocket the adapter uses, so tests can substitute a fake. */
export interface SocketLike {
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export interface CallResources {
  session: Session;
  opts: RunOptions;
  trace: TraceWriter;
  frames: FrameLog;
}

export interface CallEntry extends CallResources {
  callSid: string;
  socket: SocketLike | null;
  reconnects: number;
  lastActivityMs: number;
  ended: boolean;
  tail: Promise<void>;
}

export type CallFactory = (callSid: string) => CallResources;

export class SessionStore {
  private readonly calls = new Map<string, CallEntry>();

  constructor(
    private readonly factory: CallFactory,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(callSid: string): CallEntry | undefined {
    return this.calls.get(callSid);
  }

  size(): number {
    return this.calls.size;
  }

  create(callSid: string, socket: SocketLike): CallEntry {
    if (this.calls.has(callSid)) throw new Error(`session for ${callSid} already exists`);
    const entry: CallEntry = {
      ...this.factory(callSid),
      callSid,
      socket,
      reconnects: 0,
      lastActivityMs: this.now(),
      ended: false,
      tail: Promise.resolve(),
    };
    this.calls.set(callSid, entry);
    return entry;
  }

  attach(callSid: string, socket: SocketLike): CallEntry | undefined {
    const e = this.calls.get(callSid);
    if (!e) return undefined;
    e.socket = socket;
    e.lastActivityMs = this.now();
    return e;
  }

  detach(callSid: string): void {
    const e = this.calls.get(callSid);
    if (e) e.socket = null;
  }

  touch(callSid: string): void {
    const e = this.calls.get(callSid);
    if (e) e.lastActivityMs = this.now();
  }

  /** Serialize work per call: fn runs after everything previously queued for this call, errors are logged, the chain continues. */
  enqueue(callSid: string, fn: (entry: CallEntry) => Promise<void>): Promise<void> {
    const e = this.calls.get(callSid);
    if (!e) return Promise.resolve();
    const run = e.tail.then(() => fn(e)).catch((err: unknown) => {
      e.frames.write('log', { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    });
    e.tail = run;
    e.lastActivityMs = this.now();
    return run;
  }

  end(callSid: string): void {
    const e = this.calls.get(callSid);
    if (e) {
      e.ended = true;
      e.lastActivityMs = this.now();
    }
  }

  /** Remove sessions idle longer than the TTL. Returns the evicted call SIDs. */
  evictIdle(): string[] {
    const cutoff = this.now() - this.ttlMs;
    const gone: string[] = [];
    for (const [sid, e] of this.calls) {
      if (e.lastActivityMs < cutoff) {
        this.calls.delete(sid);
        gone.push(sid);
      }
    }
    return gone;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/server/sessions.test.ts && pnpm typecheck`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions.ts src/server/sessions.test.ts
git commit -m "feat(server): add session store with a per-call turn queue"
```

---

### Task 9: ConversationRelay adapter

**Files:**
- Create: `src/server/adapter.ts`, `src/server/adapter.test.ts`

The adapter is tested with a fake socket object, no network. It owns: token check on `setup`, session create or resume, mapping inbound frames to core events, running turns through the store's queue, sending decision frames, and ending the call.

- [ ] **Step 1: Write the failing test**

`src/server/adapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSocketClose, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';

type Fake = SocketLike & { sent: unknown[]; closed: { code?: number; reason?: string } | null };
function fakeSocket(): Fake {
  const s: Fake = {
    sent: [], closed: null,
    send(d, cb) { s.sent.push(JSON.parse(d)); cb?.(); },
    close(code, reason) { s.closed = { code, reason }; },
  };
  return s;
}

function deps(): AdapterDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-'));
  const client = new FixtureStubClient(loadCorpus('fixtures/corpus.jsonl'), { sharpness: 0.9, fallback: new HeuristicStubClient() });
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0),
    opts: { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), now: () => 0 },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
  }), 60_000, () => 0);
  return { store, tokens: new CallTokens(60_000, () => 0), log: () => {}, dir };
}

const setupMsg = (callSid: string, sessionId = 'VX1') => JSON.stringify({ type: 'setup', sessionId, callSid, from: '+1', to: '+2', customParameters: {} });
const prompt = (t: string) => JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true });
const texts = (s: Fake) => s.sent.filter((m) => (m as { type: string }).type === 'text').map((m) => (m as { token: string }).token);

describe('adapter', () => {
  it('greets on a setup with a valid token and creates the session', async () => {
    const d = deps();
    const tok = d.tokens.mint('CA1');
    const sock = fakeSocket();
    const ctx = newConnectionContext(tok);
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    expect(ctx.callSid).toBe('CA1');
    expect(texts(sock)).toEqual(['Thanks for calling the clinic. How can I help you today?']);
    expect(d.store.get('CA1')?.session.lastPromptId).toBe('greeting');
    expect(existsSync(join(d.dir, 'CA1.frames.jsonl'))).toBe(true);
  });

  it('refuses a bad token with an end message and closes', async () => {
    const d = deps();
    d.tokens.mint('CA1');
    const sock = fakeSocket();
    await handleSocketMessage(d, sock, newConnectionContext('wrong'), setupMsg('CA1'));
    expect(sock.sent).toEqual([{ type: 'end', handoffData: '{"reasonCode":"unauthorized"}' }]);
    expect(sock.closed?.code).toBe(1008);
    expect(d.store.get('CA1')).toBeUndefined();
  });

  it('ignores messages before setup and counts malformed ones', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt('hello'));
    await handleSocketMessage(d, sock, ctx, 'garbage');
    expect(sock.sent).toEqual([]);
    expect(ctx.malformed).toBe(1);
  });

  it('runs the worked example to completion and ends the call', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week"));
    expect(texts(sock).at(-1)).toBe("What's your member ID?");
    await handleSocketMessage(d, sock, ctx, prompt('four four seven one eight two nine three'));
    expect(texts(sock).slice(-2)).toEqual(['Member ID 4471 8293.', 'Which day next week works for you?']);
    await handleSocketMessage(d, sock, ctx, prompt('Tuesday'));
    expect(texts(sock).at(-1)).toBe('Your appointment with Dr. Chen is moved to Tuesday, September 22. Goodbye.');
    expect(sock.sent.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed"}' });
    expect(sock.closed?.code).toBe(1000);
    expect(d.store.get('CA1')?.ended).toBe(true);
    const records = readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8').trim().split('\n');
    expect(records).toHaveLength(4);
    const frames = readFileSync(join(d.dir, 'CA1.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(frames.filter((f) => f.dir === 'in')).toHaveLength(4);
    expect(frames.filter((f) => f.dir === 'out').length).toBeGreaterThanOrEqual(6);
  });

  it('feeds dtmf digits one message at a time and speaks once the slot fills', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt('Cancel my appointment with Dr. Kim please'));
    const before = sock.sent.length;
    for (const digit of '4471829') await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'dtmf', digit }));
    expect(sock.sent.length).toBe(before);
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'dtmf', digit: '#' }));
    expect(sock.sent.length).toBe(before);
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'dtmf', digit: '3' }));
    expect(texts(sock).at(-1)).toBe('Your appointment with Dr. Kim is cancelled. Goodbye.');
  });

  it('forces prompts to final and records an interrupt as barge-in on the next turn', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'Thanks for', durationUntilInterruptMs: 400 }));
    await handleSocketMessage(d, sock, ctx, JSON.stringify({ type: 'prompt', voicePrompt: 'I need to reschedule my appointment', last: false }));
    const records = readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = records.at(-1);
    expect(last.event.last).toBe(true);
    expect(last.turnState.asr.bargeIn).toBe(true);
    expect(last.decision.promptId).toBe('ask_memberId');
  });

  it('resumes a session on a second setup for the same call and replays the last prompt', async () => {
    const d = deps();
    const sock = fakeSocket();
    const ctx = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock, ctx, setupMsg('CA1'));
    await handleSocketMessage(d, sock, ctx, prompt('I need to reschedule my appointment'));
    await handleSocketClose(d, ctx);
    expect(d.store.get('CA1')?.socket).toBeNull();
    const sock2 = fakeSocket();
    const ctx2 = newConnectionContext(d.tokens.mint('CA1'));
    await handleSocketMessage(d, sock2, ctx2, setupMsg('CA1', 'VX2'));
    expect(texts(sock2)).toEqual(["What's your member ID?"]);
    await handleSocketMessage(d, sock2, ctx2, prompt('Dr. Chen'));
    // The form asks for the member ID before the date, so the re-ask repeats; the provider fill
    // below is what proves the turn ran on the session the first connection left behind.
    expect(texts(sock2)).toEqual(["What's your member ID?", "What's your member ID?"]);
    expect(d.store.get('CA1')?.session.slots.provider.value).toBe('chen');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/adapter.test.ts`
Expected: FAIL, cannot find module './adapter'.

- [ ] **Step 3: Write adapter.ts**

`src/server/adapter.ts`:

```ts
import type { InboundFrame, OutboundFrame } from '../channel/frames';
import { endFrame, textFrame } from '../channel/frames';
import { parseInbound, serializeOutbound } from '../channel/wire';
import { runTurn } from '../run/turn';
import type { CallEntry, SessionStore, SocketLike } from './sessions';
import type { CallTokens } from './tokens';

export interface ConnectionContext {
  token: string | null;
  callSid: string | null;
  malformed: number;
}

export interface AdapterDeps {
  store: SessionStore;
  tokens: CallTokens;
  log: (line: string) => void;
}

export function newConnectionContext(token: string | null): ConnectionContext {
  return { token, callSid: null, malformed: 0 };
}

function sendOne(socket: SocketLike, frame: OutboundFrame): Promise<void> {
  return new Promise((resolve, reject) => socket.send(serializeOutbound(frame), (err) => (err ? reject(err) : resolve())));
}

async function sendFrames(entry: CallEntry, frames: OutboundFrame[], log: AdapterDeps['log']): Promise<void> {
  for (const frame of frames) {
    entry.frames.write('out', frame);
    if (!entry.socket) {
      log(`${entry.callSid}: no socket, dropped ${frame.type}`);
      entry.frames.write('log', { dropped: frame.type });
      continue;
    }
    await sendOne(entry.socket, frame);
  }
}

async function turn(deps: AdapterDeps, entry: CallEntry, event: InboundFrame): Promise<void> {
  const run = await runTurn(entry.session, event, entry.opts);
  entry.session = run.result.session;
  await sendFrames(entry, run.result.frames, deps.log);
  const kind = run.result.decision.kind;
  if (kind === 'complete' || kind === 'handoff') {
    deps.store.end(entry.callSid);
    deps.tokens.revoke(entry.callSid);
    entry.socket?.close(1000, 'call ended');
  }
}

/** Handle one raw socket message for a connection. Safe to call concurrently; turns are serialized per call by the store. */
export async function handleSocketMessage(deps: AdapterDeps, socket: SocketLike, ctx: ConnectionContext, raw: string): Promise<void> {
  const frame = parseInbound(raw);
  if (!frame) {
    ctx.malformed += 1;
    deps.log(`${ctx.callSid ?? 'unknown'}: malformed inbound message (${ctx.malformed})`);
    const entry = ctx.callSid ? deps.store.get(ctx.callSid) : undefined;
    entry?.frames.write('log', { malformed: raw.slice(0, 200) });
    return;
  }

  if (frame.type === 'setup') {
    if (!ctx.token || !deps.tokens.verify(ctx.token, frame.callSid)) {
      deps.log(`${frame.callSid}: setup refused, bad token`);
      await sendOne(socket, endFrame('unauthorized')).catch(() => undefined);
      socket.close(1008, 'unauthorized');
      return;
    }
    ctx.callSid = frame.callSid;
    const existing = deps.store.get(frame.callSid);
    if (existing && existing.ended) {
      deps.log(`${frame.callSid}: setup for an ended call, closing`);
      socket.close(1000, 'call ended');
      return;
    }
    if (existing) {
      const entry = deps.store.attach(frame.callSid, socket)!;
      entry.frames.write('in', frame);
      entry.frames.write('log', { resumed: true, sessionId: frame.sessionId });
      await deps.store.enqueue(frame.callSid, async (e) => {
        if (e.session.lastPromptText) await sendFrames(e, [textFrame(e.session.lastPromptText, true)], deps.log);
      });
      return;
    }
    const entry = deps.store.create(frame.callSid, socket);
    entry.frames.write('in', frame);
    await deps.store.enqueue(frame.callSid, (e) => turn(deps, e, frame));
    return;
  }

  if (!ctx.callSid) {
    deps.log(`message of type ${frame.type} before setup, ignored`);
    return;
  }
  const entry = deps.store.get(ctx.callSid);
  if (!entry || entry.ended) {
    deps.log(`${ctx.callSid}: ${frame.type} after end, ignored`);
    return;
  }
  entry.frames.write('in', frame);
  // The slots have fixed digit lengths, so the keypad terminators carry no meaning yet.
  if (frame.type === 'dtmf' && (frame.digit === '#' || frame.digit === '*')) {
    entry.frames.write('log', { ignoredDigit: frame.digit });
    return;
  }
  // Finals only in this sub-project: every prompt is treated as the complete utterance.
  const event: InboundFrame = frame.type === 'prompt' ? { ...frame, last: true } : frame;
  await deps.store.enqueue(ctx.callSid, (e) => turn(deps, e, event));
}

export async function handleSocketClose(deps: AdapterDeps, ctx: ConnectionContext): Promise<void> {
  if (!ctx.callSid) return;
  const entry = deps.store.get(ctx.callSid);
  if (!entry) return;
  entry.frames.write('log', { socketClosed: true, ended: entry.ended });
  deps.store.detach(ctx.callSid);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/server/adapter.test.ts && pnpm typecheck`
Expected: 7 tests pass. If the dtmf test speaks early, check that `applyDtmf` sees the buffer growing across separate `handleSocketMessage` calls (each enqueued turn must read `entry.session`, which `turn()` replaces after every run).

- [ ] **Step 5: Commit**

```bash
git add src/server/adapter.ts src/server/adapter.test.ts
git commit -m "feat(server): add the ConversationRelay adapter"
```

---

### Task 10: HTTP routes

**Files:**
- Create: `src/server/http.ts`, `src/server/http.test.ts`

- [ ] **Step 1: Write the failing test**

`src/server/http.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestHandler, decideActionTwiml, type HttpDeps } from './http';
import { loadConfig } from './config';
import { computeTwilioSignature } from './signature';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';

const TOKEN = 'authtok';
let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function deps(overrides: Record<string, string> = {}): HttpDeps {
  const dir = mkdtempSync(join(tmpdir(), 'http-'));
  const config = loadConfig({ PUBLIC_HOST: 'demo.ngrok.app', TWILIO_AUTH_TOKEN: TOKEN, HANDOFF_NUMBER: '+15551234567', RECONNECT_LIMIT: '1', ...overrides });
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0),
    opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18' },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000);
  return { config, store, tokens: new CallTokens(60_000), hints: 'Dr. Chen', log: () => {} };
}

async function listen(d: HttpDeps): Promise<string> {
  server = createServer(createRequestHandler(d));
  await new Promise<void>((r) => server!.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

async function post(base: string, path: string, params: Record<string, string>, sign = true, host = 'demo.ngrok.app') {
  const body = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = computeTwilioSignature(`https://${host}${path}`, params, TOKEN);
  const res = await fetch(base + path, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

describe('http routes', () => {
  it('serves health', async () => {
    const base = await listen(deps());
    const res = await fetch(base + '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessions: 0 });
  });

  it('answers /voice with connect TwiML and a token bound to the call', async () => {
    const d = deps();
    const base = await listen(d);
    const r = await post(base, '/voice', { CallSid: 'CA1', From: '+1', To: '+2' });
    expect(r.status).toBe(200);
    const token = /token=([0-9a-f]{32})/.exec(r.text)?.[1];
    expect(token).toBeDefined();
    expect(d.tokens.verify(token!, 'CA1')).toBe(true);
    expect(r.text).toContain('hints="Dr. Chen"');
  });

  it('rejects a missing or bad signature', async () => {
    const base = await listen(deps());
    expect((await post(base, '/voice', { CallSid: 'CA1' }, false)).status).toBe(403);
    expect((await post(base, '/cr-action', { CallSid: 'CA1' }, true, 'other.host')).status).toBe(403);
  });

  it('honors SIGNATURE_CHECK=off', async () => {
    const base = await listen(deps({ SIGNATURE_CHECK: 'off' }));
    expect((await post(base, '/voice', { CallSid: 'CA1' }, false)).status).toBe(200);
  });

  it('returns 404 elsewhere', async () => {
    const base = await listen(deps());
    expect((await fetch(base + '/nope')).status).toBe(404);
  });
});

describe('decideActionTwiml', () => {
  it('hangs up on completed, dials on any other handoff reason, and revokes the token', () => {
    const d = deps();
    d.tokens.mint('CA1');
    expect(decideActionTwiml(d, { CallSid: 'CA1', HandoffData: '{"reasonCode":"completed"}' }).twiml).toContain('<Hangup/>');
    expect(d.tokens.verify('x', 'CA1')).toBe(false);
    expect(decideActionTwiml(d, { CallSid: 'CA2', HandoffData: '{"reasonCode":"live-agent"}' }).twiml).toContain('<Dial>+15551234567</Dial>');
    expect(decideActionTwiml(d, { CallSid: 'CA3', HandoffData: 'not json' }).twiml).toContain('<Dial>');
  });

  it('reconnects a live call up to the limit, then apologizes and dials', () => {
    const d = deps();
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const first = decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(first.twiml).toContain('<ConversationRelay');
    const token = /token=([0-9a-f]{32})/.exec(first.twiml)![1]!;
    expect(d.tokens.verify(token, 'CA1')).toBe(true);
    expect(d.store.get('CA1')?.reconnects).toBe(1);
    const second = decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(second.twiml).toContain('<Say>');
    expect(second.twiml).toContain('<Dial>+15551234567</Dial>');
    expect(d.store.get('CA1')?.ended).toBe(true);
  });

  it('hangs up for an unknown or finished call', () => {
    const d = deps();
    expect(decideActionTwiml(d, { CallSid: 'CA9', CallStatus: 'completed' }).twiml).toContain('<Hangup/>');
    d.store.create('CA1', { send: () => {}, close: () => {} });
    d.store.end('CA1');
    expect(decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress' }).twiml).toContain('<Hangup/>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/http.test.ts`
Expected: FAIL, cannot find module './http'.

- [ ] **Step 3: Write http.ts**

`src/server/http.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from './config';
import { validateTwilioSignature } from './signature';
import { apologizeAndDialTwiml, connectRelayTwiml, dialTwiml, hangupTwiml } from './twiml';
import type { SessionStore } from './sessions';
import type { CallTokens } from './tokens';

export interface HttpDeps {
  config: ServerConfig;
  store: SessionStore;
  tokens: CallTokens;
  hints: string;
  log: (line: string) => void;
}

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function formParams(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

function reply(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function parseHandoff(raw: string | undefined): { reasonCode: string } | null {
  if (raw === undefined) return null;
  try {
    const v = JSON.parse(raw) as { reasonCode?: unknown };
    return { reasonCode: typeof v.reasonCode === 'string' ? v.reasonCode : 'unknown' };
  } catch {
    return { reasonCode: 'unknown' };
  }
}

/** The <Connect action> callback decision, per spec §5 step 6. Pure apart from store and token side effects. */
export function decideActionTwiml(deps: HttpDeps, params: Record<string, string>): { twiml: string; note: string } {
  const callSid = params.CallSid ?? '';
  const handoff = parseHandoff(params.HandoffData);
  if (handoff) {
    deps.store.end(callSid);
    deps.tokens.revoke(callSid);
    if (handoff.reasonCode === 'completed') return { twiml: hangupTwiml(), note: 'completed' };
    return { twiml: dialTwiml(deps.config.handoffNumber), note: `dial:${handoff.reasonCode}` };
  }
  const entry = deps.store.get(callSid);
  if (entry && !entry.ended) {
    if (params.CallStatus === 'in-progress' && entry.reconnects < deps.config.reconnectLimit) {
      entry.reconnects += 1;
      const token = deps.tokens.mint(callSid);
      return { twiml: connectRelayTwiml({ publicHost: deps.config.publicHost, token, hints: deps.hints }), note: `reconnect:${entry.reconnects}` };
    }
    deps.store.end(callSid);
    deps.tokens.revoke(callSid);
    return { twiml: apologizeAndDialTwiml(deps.config.handoffNumber), note: 'gave-up' };
  }
  return { twiml: hangupTwiml(), note: 'hangup' };
}

export function createRequestHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && path === '/health') {
        reply(res, 200, 'application/json', JSON.stringify({ ok: true, sessions: deps.store.size() }));
        return;
      }
      if (req.method !== 'POST' || (path !== '/voice' && path !== '/cr-action')) {
        reply(res, 404, 'text/plain', 'not found');
        return;
      }
      const body = await readBody(req);
      const params = formParams(body);
      if (deps.config.signatureCheck) {
        const fullUrl = `https://${deps.config.publicHost}${req.url ?? path}`;
        const header = req.headers['x-twilio-signature'];
        if (!validateTwilioSignature(fullUrl, params, Array.isArray(header) ? header[0] : header, deps.config.twilioAuthToken)) {
          deps.log(`${path}: signature rejected`);
          reply(res, 403, 'text/plain', 'invalid signature');
          return;
        }
      }
      if (path === '/voice') {
        const callSid = params.CallSid ?? '';
        const token = deps.tokens.mint(callSid);
        deps.log(`/voice ${callSid} from ${params.From ?? '?'}`);
        reply(res, 200, 'text/xml', connectRelayTwiml({ publicHost: deps.config.publicHost, token, hints: deps.hints }));
        return;
      }
      deps.store.get(params.CallSid ?? '')?.frames.write('http', { route: '/cr-action', ...params });
      const { twiml, note } = decideActionTwiml(deps, params);
      deps.log(`/cr-action ${params.CallSid ?? '?'} ${params.SessionStatus ?? ''} -> ${note}`);
      reply(res, 200, 'text/xml', twiml);
    })().catch((e: unknown) => {
      deps.log(`http error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) reply(res, 500, 'text/plain', 'error');
    });
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/server/http.test.ts && pnpm typecheck`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/http.ts src/server/http.test.ts
git commit -m "feat(server): add voice webhook, action callback and health routes"
```

---

### Task 11: WebSocket server, entry point, fake relay, end-to-end tests

**Files:**
- Create: `src/server/ws.ts`, `src/server/index.ts`, `src/testing/fakeRelay.ts`, `src/server/server.test.ts`

- [ ] **Step 1: Write the fake relay client**

`src/testing/fakeRelay.ts` (not a test file):

```ts
import WebSocket from 'ws';

type Msg = Record<string, unknown> & { type: string };

/** A minimal Twilio ConversationRelay stand-in: connects, sends the documented inbound messages, collects outbound ones. */
export class FakeRelay {
  readonly received: Msg[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Array<() => void> = [];

  private constructor(private readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('message', (data) => {
      this.received.push(JSON.parse(data.toString()) as Msg);
      const w = this.waiters;
      this.waiters = [];
      for (const fn of w) fn();
    });
  }

  static connect(url: string): Promise<FakeRelay> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(new FakeRelay(ws)));
      ws.once('error', reject);
    });
  }

  send(msg: Msg): void {
    this.ws.send(JSON.stringify(msg));
  }

  setup(callSid: string, sessionId = `VX-${callSid}`, extras: Record<string, unknown> = {}): void {
    this.send({ type: 'setup', sessionId, callSid, from: '+15550000001', to: '+15550000002', customParameters: {}, ...extras });
  }

  prompt(text: string, last = true): void {
    this.send({ type: 'prompt', voicePrompt: text, lang: 'en-US', last });
  }

  dtmf(digits: string): void {
    for (const digit of digits) this.send({ type: 'dtmf', digit });
  }

  interrupt(utterance: string, ms: number): void {
    this.send({ type: 'interrupt', utteranceUntilInterrupt: utterance, durationUntilInterruptMs: ms });
  }

  /** Resolve once a received message satisfies pred (checking already-received ones first). */
  waitFor(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const hit = this.received.find(pred);
        if (hit) {
          clearTimeout(timer);
          resolve(hit);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => reject(new Error(`timeout waiting for message; received ${JSON.stringify(this.received)}`)), timeoutMs);
      if (!check()) {
        const again = () => { if (!check()) this.waiters.push(again); };
        this.waiters.push(again);
      }
    });
  }

  /** Wait until at least n text messages have arrived; returns their tokens. */
  async waitForTexts(n: number, timeoutMs = 3000): Promise<string[]> {
    await this.waitFor(() => this.texts().length >= n, timeoutMs);
    return this.texts();
  }

  texts(): string[] {
    return this.received.filter((m) => m.type === 'text').map((m) => m.token as string);
  }

  close(): void {
    this.ws.close();
  }
}
```

- [ ] **Step 2: Write the failing end-to-end test**

`src/server/server.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import type { JevClient } from '../jev/types';

let running: RunningServer | null = null;
afterEach(async () => { await running?.close(); running = null; });

async function start(client?: JevClient) {
  const traceDir = mkdtempSync(join(tmpdir(), 'server-'));
  const config = loadConfig({
    PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567',
    PORT: '0', SIGNATURE_CHECK: 'off', TODAY_OVERRIDE: '2026-09-18', TRACE_DIR: traceDir,
  });
  running = await startServer(config, { client, log: () => {} });
  return { traceDir, base: `http://127.0.0.1:${running.port}`, ws: `ws://127.0.0.1:${running.port}/conversation` };
}

async function connected(callSid = 'CA1') {
  const s = await start();
  const token = running!.tokens.mint(callSid);
  const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
  relay.setup(callSid);
  await relay.waitForTexts(1);
  return { ...s, relay, callSid };
}

describe('server end to end', () => {
  it('greets on setup and rejects a bad token', async () => {
    const { relay, ws } = await connected();
    expect(relay.texts()).toEqual(['Thanks for calling the clinic. How can I help you today?']);
    const bad = await FakeRelay.connect(`${ws}?token=nope`);
    bad.setup('CA2');
    const end = await bad.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"unauthorized"}');
    expect((await bad.closed).code).toBe(1008);
  });

  it('runs the worked example over the socket and ends the call', async () => {
    const { relay, traceDir, callSid } = await connected();
    relay.prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week");
    expect((await relay.waitForTexts(2)).at(-1)).toBe("What's your member ID?");
    relay.prompt('four four seven one eight two nine three');
    expect((await relay.waitForTexts(4)).slice(-2)).toEqual(['Member ID 4471 8293.', 'Which day next week works for you?']);
    relay.prompt('Tuesday');
    const end = await relay.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"completed"}');
    expect(relay.texts().at(-1)).toBe('Your appointment with Dr. Chen is moved to Tuesday, September 22. Goodbye.');
    expect((await relay.closed).code).toBe(1000);
    expect(existsSync(join(traceDir, `${callSid}.jsonl`))).toBe(true);
    expect(existsSync(join(traceDir, `${callSid}.frames.jsonl`))).toBe(true);
    expect(readFileSync(join(traceDir, `${callSid}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('handles dtmf and agent handoff', async () => {
    const { relay } = await connected();
    relay.prompt('Cancel my appointment with Dr. Kim please');
    await relay.waitForTexts(2);
    relay.dtmf('44718293');
    const end = await relay.waitFor((m) => m.type === 'end');
    expect(end.handoffData).toBe('{"reasonCode":"completed"}');
    const token2 = running!.tokens.mint('CA5');
    const second = await FakeRelay.connect(`ws://127.0.0.1:${running!.port}/conversation?token=${token2}`);
    second.setup('CA5');
    await second.waitForTexts(1);
    second.prompt('I want to talk to a person');
    const handoff = await second.waitFor((m) => m.type === 'end');
    expect(handoff.handoffData).toBe('{"reasonCode":"live-agent"}');
    expect(second.texts().at(-1)).toBe('One moment while I connect you to someone who can help.');
  });

  it('serializes a prompt and a digit that arrive back to back', async () => {
    const slow: JevClient = {
      ask: async (req) => {
        await new Promise((r) => setTimeout(r, 150));
        const { FixtureStubClient } = await import('../jev/fixtureStub');
        const { HeuristicStubClient } = await import('../jev/heuristicStub');
        const { loadCorpus } = await import('../jev/corpus');
        return new FixtureStubClient(loadCorpus('fixtures/corpus.jsonl'), { sharpness: 0.9, fallback: new HeuristicStubClient() }).ask(req);
      },
    };
    const s = await start(slow);
    const token = running!.tokens.mint('CA7');
    const relay = await FakeRelay.connect(`${s.ws}?token=${token}`);
    relay.setup('CA7');
    await relay.waitForTexts(1);
    relay.prompt('Cancel my appointment with Dr. Kim please');
    relay.dtmf('44718293');
    const end = await relay.waitFor((m) => m.type === 'end', 6000);
    expect(end.handoffData).toBe('{"reasonCode":"completed"}');
    const records = readFileSync(join(s.traceDir, 'CA7.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.map((r) => r.event.type)).toEqual(['setup', 'prompt', ...Array(8).fill('dtmf')]);
    expect(records[1].decision.promptId).toBe('ask_memberId');
  });

  it('records an interrupt as barge-in on the next prompt turn', async () => {
    const { relay, traceDir, callSid } = await connected();
    relay.interrupt('Thanks for', 300);
    relay.prompt('I need to reschedule my appointment');
    await relay.waitForTexts(2);
    const records = readFileSync(join(traceDir, `${callSid}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.at(-1).turnState.asr.bargeIn).toBe(true);
  });

  it('sanitizes call sids before building file names', async () => {
    const { safeFileStem } = await import('./index');
    expect(safeFileStem('CA' + 'a'.repeat(32))).toBe('CA' + 'a'.repeat(32));
    expect(safeFileStem('../etc/passwd')).toBe('.._etc_passwd');
    expect(safeFileStem('')).toBe('unknown');
  });

  it('exposes health and refuses upgrades on other paths', async () => {
    const s = await start();
    const res = await fetch(`${s.base}/health`);
    expect(await res.json()).toEqual({ ok: true, sessions: 0 });
    await expect(FakeRelay.connect(`ws://127.0.0.1:${running!.port}/other`)).rejects.toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/server/server.test.ts`
Expected: FAIL, cannot find module './index'.

- [ ] **Step 4: Write ws.ts**

`src/server/ws.ts`:

```ts
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleSocketClose, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import type { SocketLike } from './sessions';

function wrap(ws: WebSocket): SocketLike {
  return {
    send: (data, cb) => ws.send(data, cb),
    close: (code, reason) => ws.close(code, reason),
  };
}

/** Accept ConversationRelay upgrades on /conversation only; the token from the query is checked at setup. */
export function attachWebSocketServer(server: Server, deps: AdapterDeps): WebSocketServer {
  // 64 KiB is far above any ConversationRelay message; larger payloads are closed with 1009 by ws.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/conversation') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, token));
  });
  wss.on('connection', (ws: WebSocket, token: string | null) => {
    const ctx = newConnectionContext(token);
    const sock = wrap(ws);
    ws.on('message', (data) => {
      void handleSocketMessage(deps, sock, ctx, data.toString());
    });
    ws.on('close', () => {
      void handleSocketClose(deps, ctx);
    });
    ws.on('error', (err) => deps.log(`${ctx.callSid ?? 'unknown'}: socket error ${err.message}`));
  });
  return wss;
}
```

- [ ] **Step 5: Write index.ts**

`src/server/index.ts`:

```ts
import { createServer, type Server } from 'node:http';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeConfig, loadConfig, type ServerConfig } from './config';
import { createRequestHandler } from './http';
import { attachWebSocketServer } from './ws';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { buildHints } from './hints';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { buildClient, DEFAULT_CORPUS_FILE } from '../run/client';
import type { JevClient } from '../jev/types';
import { TraceWriter } from '../trace/writer';

export interface RunningServer {
  server: Server;
  port: number;
  store: SessionStore;
  tokens: CallTokens;
  close(): Promise<void>;
}

export interface ServerOverrides {
  client?: JevClient;
  now?: () => number;
  log?: (line: string) => void;
}

const TOKEN_TTL_MS = 10 * 60 * 1000;
const EVICT_EVERY_MS = 60 * 1000;

/** Call SIDs come from Twilio (CA + 32 hex), but they arrive over the socket, so never let one shape a path. */
export function safeFileStem(callSid: string): string {
  const cleaned = callSid.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length ? cleaned.slice(0, 64) : 'unknown';
}

export async function startServer(config: ServerConfig, overrides: ServerOverrides = {}): Promise<RunningServer> {
  const log = overrides.log ?? ((line: string) => console.log(`[server] ${line}`));
  const now = overrides.now ?? (() => Date.now());
  const thresholds = { ...DEFAULT_THRESHOLDS };
  const client = overrides.client ?? buildClient(config.jevClient, DEFAULT_CORPUS_FILE, thresholds);
  const todayIso = () => config.todayOverride ?? new Date(now()).toISOString().slice(0, 10);

  const store = new SessionStore((callSid) => {
    const file = safeFileStem(callSid);
    const trace = new TraceWriter(join(config.traceDir, `${file}.jsonl`));
    return {
      session: newSession(callSid, now()),
      opts: { client, thresholds, todayIso: todayIso(), trace, now },
      trace,
      frames: new FrameLog(join(config.traceDir, `${file}.frames.jsonl`), now),
    };
  }, config.sessionTtlMs, now);
  const tokens = new CallTokens(TOKEN_TTL_MS, now);
  const deps = { config, store, tokens, hints: buildHints(), log };

  const server = createServer(createRequestHandler(deps));
  const wss = attachWebSocketServer(server, { store, tokens, log });
  const evictor = setInterval(() => {
    for (const sid of store.evictIdle()) log(`${sid}: evicted idle session`);
    const swept = tokens.evictExpired();
    if (swept) log(`swept ${swept} expired call tokens`);
  }, EVICT_EVERY_MS);
  evictor.unref();

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const port = (server.address() as { port: number }).port;

  return {
    server,
    port,
    store,
    tokens,
    close: () =>
      new Promise((resolve) => {
        clearInterval(evictor);
        for (const c of wss.clients) c.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    const config = loadConfig(process.env);
    console.log(`[server] ${describeConfig(config)}`);
    if (!config.signatureCheck) console.log('[server] WARNING: Twilio signature validation is OFF');
    const running = await startServer(config);
    console.log(`[server] listening on ${running.port}; voice webhook https://${config.publicHost}/voice`);
    const stop = () => {
      console.log('[server] shutting down');
      void running.close().then(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run src/server/server.test.ts && pnpm typecheck`
Expected: 6 tests pass. If the queue test's record order is wrong, the store's `enqueue` is not being awaited per message in `ws.ts`, which is fine (it must not block the socket), but `turn()` must read `entry.session` at run time, not capture it at enqueue time. If `FakeRelay.connect` to `/other` resolves instead of rejecting, ensure the upgrade handler destroys the socket before `handleUpgrade`.

- [ ] **Step 7: Smoke the entry point**

Run: `PUBLIC_HOST=localhost TWILIO_AUTH_TOKEN=t HANDOFF_NUMBER=+15551234567 SIGNATURE_CHECK=off PORT=3999 timeout 3 pnpm server; true`
Expected: two config lines, the OFF warning, `listening on 3999`, then exit on the timeout. Then run `PUBLIC_HOST= pnpm server` and confirm a single `error: missing required environment variable PUBLIC_HOST` line with exit 1.

- [ ] **Step 8: Commit**

```bash
git add src/server/ws.ts src/server/index.ts src/testing/fakeRelay.ts src/server/server.test.ts
git commit -m "feat(server): add WebSocket server, entry point and end-to-end tests"
```

---

### Task 12: Reconnect end to end

**Files:**
- Modify: `src/server/server.test.ts`

- [ ] **Step 1: Add the reconnect test**

Append to the `describe('server end to end')` block in `src/server/server.test.ts`:

```ts
  it('reconnects a dropped call through the action callback and resumes the form', async () => {
    const { relay, base, ws, callSid } = await connected();
    relay.prompt("I need to reschedule my appointment, it's with Dr. Chen sometime next week");
    await relay.waitForTexts(2);
    relay.close();
    await relay.closed;
    const body = new URLSearchParams({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' }).toString();
    const res = await fetch(`${base}/cr-action`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const twiml = await res.text();
    expect(twiml).toContain('<ConversationRelay');
    const token = /token=([0-9a-f]{32})/.exec(twiml)![1]!;
    const again = await FakeRelay.connect(`${ws}?token=${token}`);
    again.setup(callSid, 'VX-second');
    expect(await again.waitForTexts(1)).toEqual(["What's your member ID?"]);
    again.prompt('four four seven one eight two nine three');
    expect((await again.waitForTexts(3)).at(-1)).toBe('Which day next week works for you?');
    const done = await fetch(`${base}/cr-action`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' }).toString(),
    });
    expect(await done.text()).toContain('<ConversationRelay');
    const third = await fetch(`${base}/cr-action`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'failed' }).toString(),
    });
    expect(await third.text()).toContain('<Dial>+15551234567</Dial>');
    expect(running!.store.get(callSid)?.ended).toBe(true);
  });
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run src/server/server.test.ts`
Expected: 7 tests pass. The default `RECONNECT_LIMIT` is 2, so the second callback reconnects and the third gives up.

- [ ] **Step 3: Commit**

```bash
git add src/server/server.test.ts
git commit -m "test(server): cover reconnect through the action callback"
```

---

### Task 13: Replay a frame log through the harness

**Files:**
- Create: `src/harness-text/replay.ts`, `src/harness-text/replay.test.ts`
- Modify: `src/harness-text/cli.ts`

- [ ] **Step 1: Write the failing test**

`src/harness-text/replay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayFrameLog } from './replay';
import { handleSocketMessage, newConnectionContext } from '../server/adapter';
import { SessionStore } from '../server/sessions';
import { CallTokens } from '../server/tokens';
import { FrameLog } from '../server/frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';

describe('replayFrameLog', () => {
  it('reproduces a live run decision for decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-'));
    const client = new FixtureStubClient(loadCorpus('fixtures/corpus.jsonl'), { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
    const store = new SessionStore((callSid) => ({
      session: newSession(callSid, 0),
      opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
      frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
    }), 60_000, () => 0);
    const tokens = new CallTokens(60_000, () => 0);
    const deps = { store, tokens, log: () => {} };
    const sock = { send: (_d: string, cb?: (e?: Error) => void) => cb?.(), close: () => {} };
    const ctx = newConnectionContext(tokens.mint('CA1'));
    const say = (t: string) => handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }));
    await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} }));
    await say("I need to reschedule my appointment, it's with Dr. Chen sometime next week");
    await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'x', durationUntilInterruptMs: 10 }));
    for (const d of '44718293') await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'dtmf', digit: d }));
    await say('Tuesday');

    const live = readFileSync(join(dir, 'CA1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const replay = await replayFrameLog(join(dir, 'CA1.frames.jsonl'), { ...opts, trace: null });
    const shape = (r: { event: { type: string }; decision: { kind: string; promptId?: string } }) => [r.event.type, r.decision.kind, r.decision.promptId ?? null];
    expect(replay.records.map(shape)).toEqual(live.map(shape));
    expect(replay.records.at(-1)!.decision.kind).toBe('complete');
    expect(replay.skipped).toEqual([]);
  });

  it('skips a second setup for the same call and reports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay2-'));
    const path = join(dir, 'x.frames.jsonl');
    const log = new FrameLog(path, () => 0);
    log.write('in', { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    log.write('out', { type: 'text', token: 'ignored' });
    log.write('in', { type: 'setup', sessionId: 'VX2', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    log.write('in', { type: 'bogus' });
    const client = new HeuristicStubClient();
    const r = await replayFrameLog(path, { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null });
    expect(r.records).toHaveLength(1);
    expect(r.skipped).toEqual(['line 3: setup for CA1 after the session started', 'line 4: unrecognized message']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/harness-text/replay.test.ts`
Expected: FAIL, cannot find module './replay'.

- [ ] **Step 3: Write replay.ts**

`src/harness-text/replay.ts`:

```ts
import { readFrameLog } from '../server/frameLog';
import { parseInbound } from '../channel/wire';
import { newSession, type Session } from '../core/session';
import { runTurn, type RunOptions, type TurnRun } from '../run/turn';
import type { TraceRecord } from '../trace/types';

export interface ReplayResult {
  runs: TurnRun[];
  records: TraceRecord[];
  skipped: string[];
}

/**
 * Feed every inbound message of a recorded call through runTurn, in order, exactly as the
 * adapter did: prompts are forced final, a repeated setup (reconnect) is skipped.
 */
export async function replayFrameLog(path: string, opts: RunOptions, onRun?: (run: TurnRun) => void): Promise<ReplayResult> {
  const lines = readFrameLog(path);
  const runs: TurnRun[] = [];
  const skipped: string[] = [];
  let session: Session | null = null;
  for (const [i, line] of lines.entries()) {
    if (line.dir !== 'in') continue;
    const frame = parseInbound(JSON.stringify(line.msg));
    if (!frame) {
      skipped.push(`line ${i + 1}: unrecognized message`);
      continue;
    }
    if (frame.type === 'setup') {
      if (session) {
        skipped.push(`line ${i + 1}: setup for ${frame.callSid} after the session started`);
        continue;
      }
      session = newSession(frame.callSid, (opts.now ?? Date.now)());
    }
    if (!session) {
      skipped.push(`line ${i + 1}: ${frame.type} before setup`);
      continue;
    }
    const event = frame.type === 'prompt' ? { ...frame, last: true } : frame;
    const run = await runTurn(session, event, opts);
    session = run.result.session;
    runs.push(run);
    onRun?.(run);
  }
  return { runs, records: runs.map((r) => r.record), skipped };
}
```

- [ ] **Step 4: Add `--replay` to the CLI**

In `src/harness-text/cli.ts`:

1. Add `replay: { type: 'string' }` to the `parseArgs` options.
2. Import `replayFrameLog` from `./replay`.
3. In `main()`, after the scenarios block and before the REPL fallback, add:

```ts
  if (args.replay) {
    const r = await replayFrameLog(args.replay, opts, (run) => printRun(run, args.quiet!));
    records.push(...r.records);
    for (const s of r.skipped) console.log(`skipped ${s}`);
  }
```

4. Change the REPL condition to `if (!args.corpus && !args.scenarios && !args.replay)`.

- [ ] **Step 5: Run tests and try the flag**

Run: `pnpm vitest run src/harness-text/replay.test.ts && pnpm typecheck`
Expected: 2 tests pass.

Then produce a frame log with the server test (`pnpm vitest run src/server/server.test.ts`) and replay one: find a file with `ls /private/tmp/server-*/CA1.frames.jsonl 2>/dev/null | head -1` (macOS temp dirs live under /private/var/folders; use `find "$(dirname "$(mktemp -d)")" -name 'CA1.frames.jsonl' | head -1`) and run `pnpm cli --replay <file> --today 2026-09-18`. Expected: the per-turn tables and the same decisions as the live run.

- [ ] **Step 6: Commit**

```bash
git add src/harness-text/replay.ts src/harness-text/replay.test.ts src/harness-text/cli.ts
git commit -m "feat(harness): replay recorded call frame logs"
```

---

### Task 14: README, env example, live-call checklist

**Files:**
- Create: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Write .env.example**

```
# Public hostname Twilio reaches (your ngrok reserved domain), no scheme, no trailing slash
PUBLIC_HOST=your-domain.ngrok.app
# From the Twilio console; used to validate X-Twilio-Signature
TWILIO_AUTH_TOKEN=
# E.164 number dialed when the caller is handed to an agent (your cell for the demo)
HANDOFF_NUMBER=+15551234567
# stub (corpus fixture), heuristic (keyword), or jev (real model; needs TYPESAFE_API_KEY)
JEV_CLIENT=stub
TYPESAFE_API_KEY=
# Optional
PORT=3000
TRACE_DIR=traces
SIGNATURE_CHECK=on
RECONNECT_LIMIT=2
# TODAY_OVERRIDE=2026-09-18
```

- [ ] **Step 2: Add the server section to README.md**

Insert after the "Regression" section:

```markdown
## Phone line (Twilio ConversationRelay)

The server puts the same decision core on a Twilio number. Prompts are
spoken by Twilio's TTS from the manifest text; recorded audio comes later.

    cp .env.example .env      # fill in PUBLIC_HOST, TWILIO_AUTH_TOKEN, HANDOFF_NUMBER
    set -a; source .env; set +a
    pnpm server

Routes: `POST /voice` (the number's voice webhook), `POST /cr-action`
(ConversationRelay's connect callback), `GET /health`, and the WebSocket at
`wss://PUBLIC_HOST/conversation`.

### Live-call checklist

1. `ngrok http --domain=PUBLIC_HOST 3000` in one terminal; `pnpm server` in another.
2. In the Twilio console, set the number's voice webhook to
   `https://PUBLIC_HOST/voice` (HTTP POST). Nothing else is configured there;
   the TwiML returned by `/voice` carries every ConversationRelay attribute.
3. Call the number. You should hear the greeting within a second.
4. Say: "I need to reschedule my appointment, it's with Dr. Chen sometime next
   week." Expect: "What's your member ID?"
5. Say the eight digits, or press them on the keypad. Expect: "Member ID
   4471 8293. Which day next week works for you?"
6. Say "Tuesday". Expect the confirmation and the call ends.
7. Call again and say "agent". Expect the transfer to `HANDOFF_NUMBER`.
8. Call again, say "what are your hours" three times. Expect the open
   reprompt, the keypad menu, then the transfer.
9. Replay the call: `pnpm cli --replay traces/<CallSid>.frames.jsonl --today $(date +%F)`
   and compare its decisions with `traces/<CallSid>.jsonl`.

Things to note on the first real call, per the spec's open questions: whether
`speechModel="flux"` is accepted with partial prompts off, how long Deepgram
takes to finalize a turn, whether an interrupted prompt also arrives as a
`prompt`, and how TTS reads the member ID and provider names.

### Operational notes

- ConversationRelay never reconnects on its own. If the socket drops mid-call,
  the `/cr-action` callback returns a fresh connect document up to
  `RECONNECT_LIMIT` times, and the caller hears the last prompt again.
- Ten consecutive unrecognized outbound messages close the socket (Twilio
  error 64105). The adapter sends only the five documented message types.
- Signature validation needs `PUBLIC_HOST` to match the ngrok domain exactly.
  `SIGNATURE_CHECK=off` is for local tests only and prints a warning.
- Every call writes `traces/<CallSid>.jsonl` (trace records) and
  `traces/<CallSid>.frames.jsonl` (raw socket messages and webhooks).
```

Also add `--replay traces/<CallSid>.frames.jsonl` to the text-harness command list and `src/server` and `src/run` to the layout list.

- [ ] **Step 3: Verify and commit**

Run: `pnpm test && pnpm typecheck && pnpm regress`
Expected: all green; the regression baseline is unchanged by this sub-project.

```bash
git add .env.example README.md
git commit -m "docs: server setup, live-call checklist and operational notes"
```

---

## Self-review notes

Spec coverage:

| Spec section | Tasks |
| --- | --- |
| §1 scope, §2 decisions (stack, shared runTurn, queue, call SID key, token, TTS, greeting, transcription, handoff, reconnect) | 1, 5, 6, 8, 9, 10 |
| §3 layout | file structure table; every listed file has a task |
| §4 configuration | 3, 14 |
| §5 call flow steps 1–6 | 5, 9, 10, 11 |
| §6 sessions and queue | 8, 9 |
| §7 signature | 4, 10 |
| §8 frame log and replay | 7, 9, 13 |
| §9 testing (fake relay, adapter, queue, http, signature, reconnect, replay, manual checklist) | 4, 8, 9, 10, 11, 12, 13, 14 |
| §10 operational notes | 14 |

Deviations from the spec, all small: the WebSocket token is verified at `setup` against the call SID exactly as specified, but a connection that never sends `setup` is simply left open until the socket closes (no timeout; ConversationRelay always sends `setup` first). `SESSION_TTL_MS` eviction runs on a one-minute interval rather than per activity. Tokens live ten minutes, long enough for the Twilio round trip and any reconnect.

Type consistency checks: `SocketLike.send(data, cb)` is used by the adapter (`sendOne`), the fake sockets in tests, and `ws.ts`'s wrapper; `RunOptions` comes from `src/run/turn.ts` everywhere; `FrameLog.write(dir, msg)` directions are `'in' | 'out' | 'http' | 'log'` in Tasks 7, 8, 9, 10, 13; `CallEntry.session` is replaced after every turn, never mutated in place; `decideActionTwiml` and `createRequestHandler` share `HttpDeps`.

