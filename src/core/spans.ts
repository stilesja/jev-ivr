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

/**
 * Words that never begin or end a name span; kept small and general, like NUMBER_WORDS.
 * tokenize() strips apostrophes, so a contraction arrives split into fragments: "it's" as
 * "it s", "I'm" as "i m", "I'd" as "i d", "don't" as "don t", "we're" as "we re", "I'll" as
 * "i ll", "I've" as "i ve". The fragments themselves (not the un-tokenizable "it's"/"i'm"
 * spellings) are what need listing here.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  'my', 'name', 'is', 'its', 'this', 'the', 'a', 'an', 'and', 'um', 'uh', 'i', 'im',
  'for', 'with', 'to', 'of', 'please', 'hi', 'hello', 'hey', 'yes', 'no', 'calling', 'speaking', 'here',
  's', 'm', 'it', 'd', 't', 're', 'll', 've',
]);
export const MAX_WORD_NGRAM = 4;

/**
 * 1..4-token n-grams with no digit or number word, not starting or ending with a filler;
 * within a name span "o"/"oh" is an ordinary word (so "O'Neil" tokenizes to "o neil" and
 * survives), not the digit zero the number-span reader takes it for. Emitted a position at a
 * time, shortest n first, so a long opener cannot exhaust the cap on 1-grams alone and push a
 * later multi-word name out from under it; document order within that; capped at MAX_SPANS.
 */
export function candidateWordSpans(text: string): string[] {
  const tokens = tokenize(text);
  const seen = new Set<string>();
  const out: string[] = [];
  const isWord = (tok: string) => !/\d/.test(tok) && (tok === 'o' || tok === 'oh' || !NUMBER_WORDS.has(tok));
  for (let i = 0; i < tokens.length && out.length < MAX_SPANS; i++) {
    for (let n = 1; n <= MAX_WORD_NGRAM && i + n <= tokens.length && out.length < MAX_SPANS; n++) {
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
