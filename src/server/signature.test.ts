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
