import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerConfig } from './config';
import { validateTwilioSignature } from './signature';
import { apologizeAndDialTwiml, connectRelayTwiml, dialTwiml, hangupTwiml } from './twiml';
import type { SessionStore } from './sessions';
import type { CallTokens } from './tokens';
import type { DashboardBus } from './dashboard/bus';
import { handleDashboardRequest } from './dashboard/routes';
import { AUDIO_TYPES, CLIP_FILE } from '../prompts/clips';

export interface HttpDeps {
  config: ServerConfig;
  store: SessionStore;
  tokens: CallTokens;
  hints: string;
  log: (line: string) => void;
  /** The dashboard's event bus, absent when DASHBOARD=off; without it the routes 404 like any other path. */
  bus?: DashboardBus;
}

const MAX_BODY = 64 * 1024;

/**
 * Reads the request body, capped at MAX_BODY. If the body is too large, the 413 response is
 * written directly here (before the socket is torn down) and the promise resolves to null so
 * the caller stops without falling through to the generic error handler.
 */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        reply(res, 413, 'text/plain', 'body too large');
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!tooLarge) reject(err);
    });
  });
}

function formParams(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

function reply(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Decodes a raw `/audio/<raw>` path segment and checks it against the same filename shape
 * `discoverClips` accepts: an id made of `[A-Za-z0-9_.-]`, a dot, and a wav/mp3 extension.
 * That shape has no room for a `/` (or, once decoded, a bare `..`), so it alone rules out path
 * traversal — no separate `..` check is needed, and `discoverClips` itself has none either;
 * the two are meant to accept exactly the same names. Returns the decoded name, or null if the
 * segment fails to decode or doesn't match.
 */
export function clipName(raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return CLIP_FILE.test(name) ? name : null;
}

/**
 * Serves a recorded clip from `audioDir` by filename. Clips are read synchronously, one file
 * per request: there are few of them, each is small, and the response is cached for a day, so
 * this is not a hot path. If that stops being true, the next step is an in-memory Map of
 * Buffers built once at startup rather than a per-request `readFileSync`.
 * Any read failure — missing file, a directory, a dangling symlink — is a 404, never a 500.
 */
function serveClip(req: IncomingMessage, res: ServerResponse, audioDir: string, raw: string): void {
  const name = clipName(raw);
  if (!name) {
    reply(res, 404, 'text/plain', 'not found');
    return;
  }
  let body: Buffer;
  try {
    body = readFileSync(join(audioDir, name));
  } catch {
    reply(res, 404, 'text/plain', 'not found');
    return;
  }
  const ext = CLIP_FILE.exec(name)![2]!.toLowerCase();
  res.writeHead(200, {
    'content-type': AUDIO_TYPES[ext]!,
    'content-length': body.length,
    'cache-control': 'public, max-age=86400',
    'accept-ranges': 'none',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function isBlank(raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === '';
}

function parseHandoff(raw: string): { reasonCode: string } {
  try {
    const v = JSON.parse(raw) as { reasonCode?: unknown };
    return { reasonCode: typeof v.reasonCode === 'string' ? v.reasonCode : 'unknown' };
  } catch {
    return { reasonCode: 'unknown' };
  }
}

/** The ConversationRelay connect attributes shared by the initial /voice answer and a reconnect. */
function connectOptions(deps: HttpDeps, token: string): Parameters<typeof connectRelayTwiml>[0] {
  const { publicHost, ttsProvider, ttsVoice } = deps.config;
  return {
    publicHost,
    token,
    hints: deps.hints,
    ...(ttsProvider && ttsVoice ? { ttsProvider, voice: ttsVoice } : {}),
  };
}

/** The <Connect action> callback decision, per spec §5 step 6. Pure apart from store and token side effects. */
export function decideActionTwiml(deps: HttpDeps, params: Record<string, string>): { twiml: string; note: string } {
  const callSid = params.CallSid ?? '';

  // (a) An explicit handoff decision from the adapter wins outright.
  const handoffData = params.HandoffData;
  if (!isBlank(handoffData)) {
    const handoff = parseHandoff(handoffData!);
    deps.store.end(callSid);
    deps.tokens.revoke(callSid);
    if (handoff.reasonCode === 'completed') return { twiml: hangupTwiml(), note: 'completed' };
    return { twiml: dialTwiml(deps.config.handoffNumber), note: `dial:${handoff.reasonCode}` };
  }

  // (b) No handoff: an ordinary caller hangup (or any status that isn't a live in-progress call)
  // just ends the call. This must not be logged as gave-up or dialed.
  if (params.SessionStatus === 'completed' || params.CallStatus !== 'in-progress') {
    deps.store.end(callSid);
    deps.tokens.revoke(callSid);
    const reason = params.SessionStatus ?? params.CallStatus ?? 'unknown';
    return { twiml: hangupTwiml(), note: `hangup:${reason}` };
  }

  // (c) Live call, session failed or otherwise ended on the ConversationRelay side: reconnect
  // if we're under the limit, otherwise hand off to a human.
  const entry = deps.store.get(callSid);
  if (entry && !entry.ended) {
    if (entry.reconnects < deps.config.reconnectLimit) {
      deps.store.detach(callSid);
      entry.reconnects += 1;
      const token = deps.tokens.mint(callSid);
      return { twiml: connectRelayTwiml(connectOptions(deps, token)), note: `reconnect:${entry.reconnects}` };
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
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      if (deps.bus && handleDashboardRequest(req, res, { bus: deps.bus, traceDir: deps.config.traceDir, enabled: deps.config.dashboard })) return;
      if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/audio/')) {
        serveClip(req, res, deps.config.audioDir, path.slice('/audio/'.length));
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/health') {
        // `sessions` is what is live; `retained` is ended calls still inside their grace period,
        // which are memory but not callers.
        const live = deps.store.liveCount();
        const body = JSON.stringify({ ok: true, sessions: live, retained: deps.store.size() - live });
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
          res.end();
        } else {
          reply(res, 200, 'application/json', body);
        }
        return;
      }
      if (req.method !== 'POST' || (path !== '/voice' && path !== '/cr-action')) {
        reply(res, 404, 'text/plain', 'not found');
        return;
      }
      const body = await readBody(req, res);
      if (body === null) return; // 413 already sent by readBody
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
        const callSid = (params.CallSid ?? '').trim();
        if (!callSid) {
          deps.log('/voice: missing CallSid');
          reply(res, 400, 'text/plain', 'missing CallSid');
          return;
        }
        const token = deps.tokens.mint(callSid);
        deps.log(`/voice ${callSid} from ${params.From ?? '?'}`);
        reply(res, 200, 'text/xml', connectRelayTwiml(connectOptions(deps, token)));
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
