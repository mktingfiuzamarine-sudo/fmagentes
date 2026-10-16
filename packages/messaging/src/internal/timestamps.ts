/**
 * Epoch microseconds of a timestamptz string. Postgres keeps microseconds and
 * Date.parse truncates to milliseconds, so the sub-millisecond digits are read
 * from the string itself.
 */
function epochMicros(timestamp: string): number {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${timestamp}`);
  const fraction = /\.(\d+)/.exec(timestamp)?.[1] ?? "";
  return ms * 1000 + Number(fraction.slice(3, 6).padEnd(3, "0"));
}

/** a <= b, to the microsecond. */
export function notAfter(a: string, b: string): boolean {
  return epochMicros(a) <= epochMicros(b);
}

/** The later of two database timestamps, returned as given (no rounding). */
export function laterTimestamp(a: string, b: string | null): string;
export function laterTimestamp(a: string | null, b: string): string;
export function laterTimestamp(a: string | null, b: string | null): string | null;
export function laterTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return epochMicros(b) > epochMicros(a) ? b : a;
}
