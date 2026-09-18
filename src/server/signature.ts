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
