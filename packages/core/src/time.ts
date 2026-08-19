/**
 * One clock for the whole simulation: seconds from J2000.
 *
 * The integrator wants a uniform time coordinate with no leap seconds and no
 * calendar; the interface wants a date. Keeping the simulation on seconds-from-
 * epoch and converting only at the edges means no part of the physics ever
 * touches a `Date` — which is what makes a whole run reproducible from a single
 * number, and what lets the predictor fork a state and run it forward without
 * carrying any of the calendar with it.
 *
 * The difference between TDB and UTC is under a minute and a half across the
 * supported range, and it is ignored. Nothing here is trying to time an
 * occultation to the second.
 */

import { SECONDS_PER_DAY } from './units.js';

/** Julian Date of the J2000.0 epoch, 2000-01-01 12:00 TT. */
export const J2000_JD = 2_451_545.0;

/** Unix milliseconds at J2000.0. */
const J2000_UNIX_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/**
 * The range the model is offered over: 1980 to 2120.
 *
 * Not a limit of the integrator, which will run as far as it is asked. It is a
 * limit of honesty. The moon elements are a Cassini-era fit, and the further
 * the clock runs from that, the further the catalogue's mean elements are from
 * where the moons actually will be. See `docs/accuracy.md`.
 */
export const MIN_TIME = -20 * 365.25 * SECONDS_PER_DAY;
export const MAX_TIME = 120 * 365.25 * SECONDS_PER_DAY;

export const clampTime = (seconds: number): number =>
  Math.min(MAX_TIME, Math.max(MIN_TIME, seconds));

export const toJulianDate = (seconds: number): number =>
  J2000_JD + seconds / SECONDS_PER_DAY;

export const fromJulianDate = (jd: number): number => (jd - J2000_JD) * SECONDS_PER_DAY;

export const toDate = (seconds: number): Date => new Date(J2000_UNIX_MS + seconds * 1000);

export const fromDate = (date: Date): number => (date.getTime() - J2000_UNIX_MS) / 1000;

/** Julian centuries from J2000 — the argument the planetary elements take. */
export const julianCenturies = (seconds: number): number =>
  seconds / (SECONDS_PER_DAY * 36_525);

export type DurationUnit = 'd' | 'h' | 'm' | 's';

/**
 * A duration expressed in the largest unit that leaves it readable.
 *
 * Periods in this system run from thirty-three minutes, for a grazing orbit at
 * the cloud tops, to four years for Fornjot. Any single unit makes one end of
 * that range unreadable.
 */
export function splitDuration(seconds: number): { value: number; unit: DurationUnit } {
  const magnitude = Math.abs(seconds);
  if (magnitude >= SECONDS_PER_DAY) return { value: seconds / SECONDS_PER_DAY, unit: 'd' };
  if (magnitude >= 3_600) return { value: seconds / 3_600, unit: 'h' };
  if (magnitude >= 60) return { value: seconds / 60, unit: 'm' };
  return { value: seconds, unit: 's' };
}
