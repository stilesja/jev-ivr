/** One diff line per differing key, so a changed outcome names exactly what moved. */
export function diffOne<T extends object>(name: string, id: string, e: T | undefined, a: T | undefined): string[] {
  if (!e) return [`+ ${name} ${id}: new`];
  if (!a) return [`- ${name} ${id}: removed`];
  const out: string[] = [];
  for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) {
    const ev = JSON.stringify((e as Record<string, unknown>)[key]);
    const av = JSON.stringify((a as Record<string, unknown>)[key]);
    if (ev !== av) out.push(`~ ${name} ${id}.${key}: ${ev} -> ${av}`);
  }
  return out;
}

/** Diff lines across every id on either side, plus the count of ids that matched exactly. */
export function diff<T extends object>(name: string, expected: Record<string, T>, actual: Record<string, T>): { lines: string[]; matching: number } {
  const lines: string[] = [];
  let matching = 0;
  for (const id of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const own = diffOne(name, id, expected[id], actual[id]);
    if (own.length === 0) matching += 1;
    lines.push(...own);
  }
  return { lines, matching };
}
