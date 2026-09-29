/** Injectable clock so expiry rules can be tested without waiting. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
