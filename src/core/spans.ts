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

/** Words that never begin or end a name span; kept small and general, like NUMBER_WORDS. */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  'my', 'name', 'is', "it's", 'its', 'this', 'the', 'a', 'an', 'and', 'um', 'uh', 'i', "i'm", 'im',
  'for', 'with', 'to', 'of', 'please', 'hi', 'hello', 'hey', 'yes', 'no', 'calling', 'speaking', 'here',
  // tokenize() strips apostrophes, so "it's" and "I'm" arrive as "it s" and "i m"
  's', 'm',
]);
export const MAX_WORD_NGRAM = 3;

/**
 * 1..3-token n-grams with no digit or number word, not starting or ending with a filler;
 * document order; capped at MAX_SPANS.
 */
export function candidateWordSpans(text: string): string[] {
  const tokens = tokenize(text);
  const seen = new Set<string>();
  const out: string[] = [];
  const isWord = (tok: string) => !/\d/.test(tok) && !NUMBER_WORDS.has(tok);
  for (let n = 1; n <= MAX_WORD_NGRAM && out.length < MAX_SPANS; n++) {
    for (let i = 0; i + n <= tokens.length && out.length < MAX_SPANS; i++) {
      const slice = tokens.slice(i, i + n);
      if (!slice.every(isWord)) continue;
      if (FILLER_WORDS.has(slice[0]!) || FILLER_WORDS.has(slice[n - 1]!)) continue;
      const span = slice.join(' ');
      if (seen.has(span)) continue;
      seen.add(span);
      out.push(span);
    }
  }
  return out;
}
