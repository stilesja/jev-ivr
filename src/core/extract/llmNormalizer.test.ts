import { describe, expect, it } from 'vitest';
import { unavailableNormalizer } from './llmNormalizer';

describe('unavailableNormalizer', () => {
  it('always reports unavailable', async () => {
    const result = await unavailableNormalizer.normalize({
      slotType: 'memberId',
      spanText: 'four four',
      fullTranscript: 'it is four four',
      expectedMask: '^\\d{8}$',
      attempt: 1,
    });
    expect(result).toBe('unavailable');
  });
});
