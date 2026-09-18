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
