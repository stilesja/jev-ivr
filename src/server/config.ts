import { defaultTimeZone, localDateIso } from '../run/clock';

export type ClientKind = 'stub' | 'heuristic' | 'jev';

/** ConversationRelay's documented TTS providers (Twilio docs, <ConversationRelay> ttsProvider). */
const TTS_PROVIDERS = ['Google', 'Amazon', 'ElevenLabs'] as const;

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
  sessionMaxAgeMs: number;
  timezone: string;
  audioDir: string;
  ttsProvider: string | null;
  ttsVoice: string | null;
  /** Silence after a prompt's estimated playback before the caller is asked again; 0 disables. */
  noInputMs: number;
  /** Serve the live call dashboard and publish call moments to its bus. */
  dashboard: boolean;
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

/** An IANA zone name the runtime actually knows; `Intl` is the only authority worth asking. */
function timeZone(env: Env): string {
  const raw = env.TIMEZONE?.trim() || defaultTimeZone();
  try {
    localDateIso(0, raw);
  } catch {
    throw new Error(`TIMEZONE must be an IANA zone like America/Los_Angeles, got "${raw}"`);
  }
  return raw;
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
  const dash = (env.DASHBOARD ?? 'on').toLowerCase();
  if (dash !== 'on' && dash !== 'off') throw new Error(`DASHBOARD must be on or off, got "${env.DASHBOARD}"`);
  const ttsProvider = env.TTS_PROVIDER?.trim() || null;
  const ttsVoice = env.TTS_VOICE?.trim() || null;
  if (ttsProvider && !(TTS_PROVIDERS as readonly string[]).includes(ttsProvider)) {
    throw new Error(`TTS_PROVIDER must be one of ${TTS_PROVIDERS.join(', ')}, got "${ttsProvider}"`);
  }
  // Twilio itself allows a provider with the connection's default voice, but we require both:
  // the fallback voice for unrecorded segments should be a deliberate match to the recorded
  // clips, not whatever ConversationRelay defaults to.
  if ((ttsProvider === null) !== (ttsVoice === null)) throw new Error('TTS_PROVIDER and TTS_VOICE must be set together');
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
    sessionMaxAgeMs: integer(env, 'SESSION_MAX_AGE_MS', 7_200_000),
    timezone: timeZone(env),
    audioDir: env.AUDIO_DIR?.trim() || 'assets/audio',
    ttsProvider,
    ttsVoice,
    noInputMs: integer(env, 'NO_INPUT_MS', 7_000),
    dashboard: dash === 'on',
  };
}

export function describeConfig(c: ServerConfig): string {
  // A prefix of a secret is still a piece of the secret; the length alone is enough to tell
  // "the variable is set" from "the variable is the wrong value".
  const mask = (s: string | null) => (s ? `set (${s.length} chars)` : 'unset');
  return [
    `port ${c.port}`,
    `public host ${c.publicHost}`,
    `handoff ${c.handoffNumber}`,
    `client ${c.jevClient}`,
    `api key ${mask(c.typesafeApiKey)}`,
    `auth token ${mask(c.twilioAuthToken)}`,
    `signature check ${c.signatureCheck ? 'on' : 'OFF'}`,
    `today ${c.todayOverride ?? 'wall clock'}`,
    `timezone ${c.timezone}`,
    `traces ${c.traceDir}`,
    `reconnect limit ${c.reconnectLimit}`,
    `audio dir ${c.audioDir}`,
    c.noInputMs > 0 ? `no-input ${c.noInputMs} ms` : 'no-input off',
    `dashboard ${c.dashboard ? 'on' : 'OFF'}`,
    c.ttsProvider && c.ttsVoice ? `tts ${c.ttsProvider} ${c.ttsVoice}` : 'tts default',
  ].join('  ');
}
