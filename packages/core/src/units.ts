/**
 * Units, fixed once so that nothing downstream has to ask.
 *
 * **Kilometres and seconds throughout**, with GM in km3/s2. The Orrery this
 * grew out of works in AU and days, which suits a solar system; it does not
 * suit this one. Pan laps Saturn in 0.575 days and a course correction lasts
 * seconds, so days would put every interesting number in the fifth decimal
 * place — and AU would put every position there too, Mimas orbiting at 0.0012
 * of one.
 *
 * Kilometres and seconds keep the whole system inside a comfortable range:
 * distances from 6e4 to 2.5e7, speeds from 0.1 to 30, GM from 1e-5 to 3.8e7.
 */

/** Newtonian constant of gravitation, m^3 kg^-1 s^-2 (CODATA 2018). */
export const GRAVITATIONAL_CONSTANT = 6.674_30e-11;

/** The same constant in the working units, km^3 kg^-1 s^-2. */
export const G_KM = GRAVITATIONAL_CONSTANT * 1e-9;

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_YEAR = 365.25 * SECONDS_PER_DAY;

/** Metres in an astronomical unit (IAU 2012). */
export const AU_IN_METRES = 1.495_978_707e11;
export const AU_IN_KM = AU_IN_METRES / 1000;

/**
 * Mass in kilograms, from a tabulated GM.
 *
 * Only GM is tabulated, because that is what tracking a spacecraft actually
 * measures: the product is known to many digits while G itself is the least
 * precisely known constant in physics. So this division is the least accurate
 * step in the package, and it is here only to put a number on a display.
 */
export const massInKg = (gm: number): number => gm / G_KM;

/** Surface gravity of a uniform sphere, m/s2, from GM in km3/s2 and radius in km. */
export const surfaceGravity = (gm: number, radiusKm: number): number =>
  (gm / (radiusKm * radiusKm)) * 1000;

/** Escape speed at a distance, km/s. */
export const escapeSpeed = (gm: number, distanceKm: number): number =>
  Math.sqrt((2 * gm) / distanceKm);

/** Speed of a circular orbit at a distance, km/s. */
export const circularSpeed = (gm: number, distanceKm: number): number =>
  Math.sqrt(gm / distanceKm);

/** Period of a circular orbit at a distance, seconds. */
export const circularPeriod = (gm: number, distanceKm: number): number =>
  2 * Math.PI * Math.sqrt(distanceKm ** 3 / gm);

/**
 * Radius of a body's Hill sphere, km — where its own pull beats Saturn's.
 *
 * The single most useful number in the game, because it is the boundary between
 * "orbiting Titan" and "orbiting Saturn near Titan", and the boundary is much
 * closer in than players expect: Titan's is 52 000 km, Mimas's only 550.
 */
export const hillRadius = (
  gmSecondary: number,
  gmPrimary: number,
  semiMajorAxisKm: number,
  eccentricity = 0,
): number =>
  semiMajorAxisKm * (1 - eccentricity) * Math.cbrt(gmSecondary / (3 * gmPrimary));
