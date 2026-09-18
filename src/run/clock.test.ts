import { describe, expect, it } from 'vitest';
import { defaultTimeZone, localDateIso } from './clock';

// 2026-09-19T03:30:00Z is still the evening of the 18th in California.
const LATE_EVENING_PACIFIC = Date.parse('2026-09-19T03:30:00Z');

describe('localDateIso', () => {
  it('resolves the date in the given zone, not in UTC', () => {
    expect(localDateIso(LATE_EVENING_PACIFIC, 'America/Los_Angeles')).toBe('2026-09-18');
    expect(localDateIso(LATE_EVENING_PACIFIC, 'UTC')).toBe('2026-09-19');
  });

  it('can be a day ahead of UTC too', () => {
    expect(localDateIso(Date.parse('2026-09-18T22:00:00Z'), 'Asia/Tokyo')).toBe('2026-09-19');
  });

  it('formats as YYYY-MM-DD with zero padding', () => {
    expect(localDateIso(Date.parse('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05');
  });
});

describe('defaultTimeZone', () => {
  it('returns a zone the formatter accepts', () => {
    const zone = defaultTimeZone();
    expect(zone).toMatch(/\S/);
    expect(localDateIso(LATE_EVENING_PACIFIC, zone)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
