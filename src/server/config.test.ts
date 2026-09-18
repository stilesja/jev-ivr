import { describe, expect, it } from 'vitest';
import { loadConfig, describeConfig } from './config';
import { defaultTimeZone } from '../run/clock';

const base = { PUBLIC_HOST: 'demo.ngrok.app', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15551234567' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 3000, publicHost: 'demo.ngrok.app', jevClient: 'stub', todayOverride: null,
      traceDir: 'traces', signatureCheck: true, reconnectLimit: 2, sessionTtlMs: 1_800_000,
      sessionMaxAgeMs: 7_200_000, timezone: defaultTimeZone(),
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

  it('masks secrets in the description, prefix included', () => {
    const text = describeConfig(loadConfig({ ...base, TWILIO_AUTH_TOKEN: 'supersecret' }));
    expect(text).not.toContain('supersecret');
    // Not even the first characters: the length alone says whether the variable is set.
    expect(text).not.toContain('su');
    expect(text).toContain('auth token set (11 chars)');
    expect(text).toContain('api key unset');
    expect(text).toContain('demo.ngrok.app');
  });

  it('takes an IANA zone and rejects anything Intl does not know', () => {
    expect(loadConfig({ ...base, TIMEZONE: 'America/Los_Angeles' }).timezone).toBe('America/Los_Angeles');
    expect(() => loadConfig({ ...base, TIMEZONE: 'Pacific Time' })).toThrow(
      'TIMEZONE must be an IANA zone like America/Los_Angeles, got "Pacific Time"',
    );
    // Blank falls back to the host zone rather than failing.
    expect(loadConfig({ ...base, TIMEZONE: '  ' }).timezone).toBe(defaultTimeZone());
  });

  it('parses the session lifetimes', () => {
    const c = loadConfig({ ...base, SESSION_TTL_MS: '5000', SESSION_MAX_AGE_MS: '9000' });
    expect(c.sessionTtlMs).toBe(5000);
    expect(c.sessionMaxAgeMs).toBe(9000);
    expect(() => loadConfig({ ...base, SESSION_MAX_AGE_MS: '-1' })).toThrow('SESSION_MAX_AGE_MS');
  });

  it('rejects a PORT outside 0..65535', () => {
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/between 0 and 65535/);
  });

  it('rejects a HANDOFF_NUMBER that is not E.164', () => {
    expect(() => loadConfig({ ...base, HANDOFF_NUMBER: 'cell' })).toThrow(/E\.164/);
  });

  it('rejects a PUBLIC_HOST with a path, query, or port', () => {
    expect(() => loadConfig({ ...base, PUBLIC_HOST: 'demo.ngrok.app/foo' })).toThrow(/bare hostname/);
    expect(loadConfig({ ...base, PUBLIC_HOST: 'https://demo.ngrok.app/' }).publicHost).toBe('demo.ngrok.app');
  });
});
