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
  if (/[/?:]/.test(publicHost)) throw new Error(`PUBLIC_HOST must be a bare hostname, got "${publicHost}"`);
  const twilioAuthToken = required(env, 'TWILIO_AUTH_TOKEN');
  const handoffNumber = required(env, 'HANDOFF_NUMBER');
  if (!/^\+\d{8,15}$/.test(handoffNumber)) throw new Error(`HANDOFF_NUMBER must be an E.164 number like +15551234567, got "${handoffNumber}"`);
  const port = integer(env, 'PORT', 3000);
  if (port < 0 || port > 65535) throw new Error(`PORT must be between 0 and 65535, got "${env.PORT}"`);
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
    port,
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
