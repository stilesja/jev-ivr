const UNITS: Record<string, number> = {
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const REPEATS: Record<string, number> = { double: 2, triple: 3 };

export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...Object.keys(UNITS), ...Object.keys(TEENS), ...Object.keys(TENS), ...Object.keys(REPEATS),
]);

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Convert spoken number words to a digit string. Non-number tokens are
 * ignored so a loosely chosen span still yields digits; the slot mask
 * decides whether the result is acceptable.
 */
export function spokenToDigits(text: string): string {
  let out = '';
  let pendingTens: number | null = null;
  let repeat = 1;

  const emit = (n: number): void => {
    out += String(n).repeat(repeat);
    repeat = 1;
  };
  const flush = (): void => {
    if (pendingTens !== null) {
      emit(pendingTens);
      pendingTens = null;
    }
  };

  for (const tok of tokenize(text)) {
    if (/^\d+$/.test(tok)) {
      flush();
      out += tok.repeat(repeat);
      repeat = 1;
    } else if (tok in REPEATS) {
      flush();
      repeat = REPEATS[tok]!;
    } else if (tok in UNITS) {
      const unit = UNITS[tok]!;
      if (pendingTens !== null && unit !== 0) {
        emit(pendingTens + unit);
        pendingTens = null;
      } else {
        flush();
        emit(unit);
      }
    } else if (tok in TEENS) {
      flush();
      emit(TEENS[tok]!);
    } else if (tok in TENS) {
      flush();
      pendingTens = TENS[tok]!;
    }
    // any other token is ignored
  }
  flush();
  return out;
}
