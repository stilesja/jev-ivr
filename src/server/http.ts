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
