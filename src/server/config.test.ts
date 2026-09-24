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
      sessionMaxAgeMs: 7_200_000, timezone: defaultTimeZone(), noInputMs: 7000,
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

  it('defaults the audio dir and takes an optional TTS voice as a provider and voice pair', () => {
    expect(loadConfig(base)).toMatchObject({ audioDir: 'assets/audio', ttsProvider: null, ttsVoice: null });
    expect(loadConfig({ ...base, AUDIO_DIR: '/tmp/a', TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' })).toMatchObject({ audioDir: '/tmp/a', ttsProvider: 'Google', ttsVoice: 'en-US-Neural2-F' });
    expect(() => loadConfig({ ...base, TTS_VOICE: 'x' })).toThrow(/TTS_PROVIDER and TTS_VOICE/);
  });

  it('requires TTS_PROVIDER to be one ConversationRelay actually offers, and requires TTS_VOICE alongside it', () => {
    expect(() => loadConfig({ ...base, TTS_PROVIDER: 'Polly', TTS_VOICE: 'x' })).toThrow('TTS_PROVIDER must be one of Google, Amazon, ElevenLabs, got "Polly"');
    // Symmetric to TTS_VOICE alone (already covered above): a provider with no voice is just as incomplete.
    expect(() => loadConfig({ ...base, TTS_PROVIDER: 'Google' })).toThrow(/TTS_PROVIDER and TTS_VOICE/);
  });

  it('describes the tts setting as default or as the configured provider and voice', () => {
    expect(describeConfig(loadConfig(base))).toContain('tts default');
    expect(describeConfig(loadConfig({ ...base, TTS_PROVIDER: 'Google', TTS_VOICE: 'en-US-Neural2-F' }))).toContain('tts Google en-US-Neural2-F');
  });

  it('defaults the no-input wait to seven seconds, takes 0 as off, and rejects a negative one', () => {
    expect(loadConfig(base).noInputMs).toBe(7000);
    expect(loadConfig({ ...base, NO_INPUT_MS: '250' }).noInputMs).toBe(250);
    expect(loadConfig({ ...base, NO_INPUT_MS: '0' }).noInputMs).toBe(0);
    expect(() => loadConfig({ ...base, NO_INPUT_MS: '-1' })).toThrow('NO_INPUT_MS');
    expect(() => loadConfig({ ...base, NO_INPUT_MS: 'soon' })).toThrow('NO_INPUT_MS');
  });

  it('describes the no-input wait, and says off when it is disabled', () => {
    expect(describeConfig(loadConfig(base))).toContain('no-input 7000 ms');
    expect(describeConfig(loadConfig({ ...base, NO_INPUT_MS: '0' }))).toContain('no-input off');
  });

  it('takes the dashboard switch, defaults it on, and rejects anything else', () => {
    expect(loadConfig(base).dashboard).toBe(true);
    expect(loadConfig({ ...base, DASHBOARD: 'on' }).dashboard).toBe(true);
    expect(loadConfig({ ...base, DASHBOARD: 'off' }).dashboard).toBe(false);
    expect(() => loadConfig({ ...base, DASHBOARD: 'yes' })).toThrow('DASHBOARD must be on or off, got "yes"');
  });

  it('takes the clips switch, defaults it off, and rejects anything else', () => {
    expect(loadConfig(base).clips).toBe(false);
    expect(loadConfig({ ...base, CLIPS: 'on' }).clips).toBe(true);
    expect(loadConfig({ ...base, CLIPS: 'ON' }).clips).toBe(true);
    expect(() => loadConfig({ ...base, CLIPS: 'no' })).toThrow('CLIPS must be on or off, got "no"');
    expect(describeConfig(loadConfig(base))).toContain('clips OFF (all TTS)');
    expect(describeConfig(loadConfig({ ...base, CLIPS: 'on' }))).toContain('clips on');
  });

  it('describes the dashboard switch', () => {
    expect(describeConfig(loadConfig(base))).toContain('dashboard on');
    expect(describeConfig(loadConfig({ ...base, DASHBOARD: 'off' }))).toContain('dashboard OFF');
  });

  it('rejects a PUBLIC_HOST with a path, query, or port', () => {
    expect(() => loadConfig({ ...base, PUBLIC_HOST: 'demo.ngrok.app/foo' })).toThrow(/bare hostname/);
    expect(loadConfig({ ...base, PUBLIC_HOST: 'https://demo.ngrok.app/' }).publicHost).toBe('demo.ngrok.app');
  });
});
