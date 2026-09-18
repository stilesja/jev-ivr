/**
 * Date resolution for the slot logic. "Today" is a wall-clock notion: a caller at 8pm Pacific on
 * the 18th means the 18th, not the 19th that `toISOString()` would report. Everything that needs
 * a calendar date resolves it here, in an explicit zone, rather than from a UTC timestamp.
 */

/** The date `ms` falls on in `timeZone`, as YYYY-MM-DD. `en-CA` formats exactly that way. */
export function localDateIso(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** The host's IANA zone, used when nothing configures one. */
export function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
