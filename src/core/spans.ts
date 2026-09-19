import { MULTIPLIER_WORDS, NUMBER_WORDS, tokenize } from './extract/spokenNumber';

export const MAX_SPANS = 120;
export const MAX_NGRAM = 10;

// A multiplier word alone ("hundred", "thousand") must not qualify a span on
// its own, or ordinary phrases like "a hundred percent sure" spawn dozens of
// junk number-ish spans. It still counts within a span that has another
// number word.
function isNumberish(tok: string): boolean {
  return /\d/.test(tok) || (NUMBER_WORDS.has(tok) && !MULTIPLIER_WORDS.has(tok));
}

/**
 * All n-grams (1..MAX_NGRAM tokens) that contain at least one digit or
 * number word, deduplicated in document order, capped at MAX_SPANS.
 * Shorter spans come first so the cap keeps the tight candidates.
 */
export function candidateSpans(text: string): string[] {
  const tokens = tokenize(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let n = 1; n <= MAX_NGRAM && out.length < MAX_SPANS; n++) {
    for (let i = 0; i + n <= tokens.length && out.length < MAX_SPANS; i++) {
      const slice = tokens.slice(i, i + n);
      if (!slice.some(isNumberish)) continue;
      const span = slice.join(' ');
      if (seen.has(span)) continue;
      seen.add(span);
      out.push(span);
    }
  }
  return out;
}
