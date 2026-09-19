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
const MULTIPLIERS: Record<string, number> = { hundred: 100, thousand: 1000 };

export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...Object.keys(UNITS), ...Object.keys(TEENS), ...Object.keys(TENS), ...Object.keys(REPEATS), ...Object.keys(MULTIPLIERS),
]);

export const MULTIPLIER_WORDS: ReadonlySet<string> = new Set(Object.keys(MULTIPLIERS));

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Convert spoken number words to a digit string. Groups compose the way
 * English does ("forty four" 44, "three hundred five" 305, "two thousand"
 * 2000, "one thousand two hundred thirty four" 1234) and consecutive
 * groups concatenate ("forty four, one eighty seven" 44187). Non-number
 * tokens close the current group and are otherwise ignored, so a loosely
 * chosen span still yields digits; the slot mask decides whether the
 * result is acceptable. A spoken zero always starts its own digit rather
 * than composing into a group.
 */
export function spokenToDigits(text: string): string {
  const parts: string[] = [];
  let cur: { total: number; small: number } | null = null; // the group being built
  let pendingTens: number | null = null;
  let repeat = 1;
  let open = false; // a multiplier was just applied

  const closeGroup = (): void => {
    if (cur) parts.push(String(cur.total + cur.small));
    cur = null;
    open = false;
  };
  const add = (n: number): void => {
    if (repeat !== 1) {
      closeGroup();
      parts.push(String(n).repeat(repeat));
      repeat = 1;
      return;
    }
    // "three hundred" then "five" adds into the group; a spoken zero never does (it is its own digit).
    if (open && cur && n !== 0) {
      cur.small += n;
      open = false;
      return;
    }
    closeGroup();
    cur = { total: 0, small: n };
  };
  const flush = (): void => {
    if (pendingTens !== null) {
      const n = pendingTens;
      pendingTens = null;
      add(n);
    }
  };
  const close = (): void => {
    flush();
    closeGroup();
    repeat = 1;
  };
  const multiply = (m: number): void => {
    flush();
    if (!cur) {
      add(m);
      return;
    }
    if (m >= 1000) {
      cur.total = (cur.total + cur.small) * m;
      cur.small = 0;
    } else {
      cur.small = (cur.small || 1) * m;
    }
    open = true;
  };

  for (const tok of tokenize(text)) {
    if (/^\d+$/.test(tok)) {
      close();
      parts.push(tok.repeat(repeat));
      repeat = 1;
    } else if (tok in REPEATS) {
      flush();
      repeat = REPEATS[tok]!;
    } else if (tok in MULTIPLIERS) {
      multiply(MULTIPLIERS[tok]!);
    } else if (tok === 'and') {
      if (!open) close();
    } else if (tok in UNITS) {
      const unit = UNITS[tok]!;
      if (pendingTens !== null && unit !== 0) {
        const n = pendingTens + unit;
        pendingTens = null;
        add(n);
      } else {
        flush();
        add(unit);
      }
    } else if (tok in TEENS) {
      flush();
      add(TEENS[tok]!);
    } else if (tok in TENS) {
      flush();
      pendingTens = TENS[tok]!;
    } else {
      close();
    }
  }
  close();
  return parts.join('');
}
