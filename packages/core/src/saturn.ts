/**
 * Saturn itself: the shape of the primary, the frame everything is measured in,
 * and the rings.
 *
 * Two things here matter more than they would for any other planet.
 *
 * **Saturn is not a sphere and cannot be treated as one.** Its flattening is
 * 0.098 — the pole is nearly six thousand kilometres closer to the centre than
 * the equator — and its J2 is 1.63e-2, some 15 times the Earth's. That is not a
 * refinement. It is the reason Saturn's inner moons keep their orbits in the
 * ring plane at all, and a module in a low orbit has its node dragged round by
 * whole degrees a day. Model Saturn as a point mass and the game is wrong in a
 * way the player can see within one orbit, so the zonal harmonics are in the
 * force law from the start rather than bolted on.
 *
 * **The working frame is Saturn's equator, not the ecliptic.** Everything
 * interesting is in the ring plane, so that plane is the xy-plane, +z is
 * Saturn's north pole, and +x points along the ascending node of that equator
 * on the ecliptic. The one thing that is not in this frame naturally is the
 * Sun, and `sun.ts` does that conversion.
 */

import { DEG, rotateX, rotateZ, vec3, type Vec3 } from './vec.js';

/**
 * GM of Saturn alone, km3/s2 (JPL sat441).
 *
 * Alone, not the system value of 37 940 585 — the moons are integrated
 * explicitly here, so folding their mass into the primary as well would count
 * them twice.
 */
export const SATURN_GM = 37_931_206.2;

/** Equatorial radius at the 1-bar level, km. What the disc is drawn as. */
export const SATURN_EQUATORIAL_RADIUS = 60_268;

/** Polar radius at the 1-bar level, km. */
export const SATURN_POLAR_RADIUS = 54_364;

export const SATURN_FLATTENING =
  (SATURN_EQUATORIAL_RADIUS - SATURN_POLAR_RADIUS) / SATURN_EQUATORIAL_RADIUS;

/**
 * Reference radius for the gravity coefficients, km.
 *
 * Deliberately *not* the 1-bar radius. A spherical-harmonic expansion is only
 * defined together with the radius it was normalised against, and JPL's Saturn
 * field uses 60 330 km. Using the 1-bar figure instead would misscale J2 by
 * one part in a thousand — small, but it is the kind of error that never
 * announces itself, so the two radii are kept as separate constants.
 */
export const SATURN_GRAVITY_RADIUS = 60_330;

/**
 * Zonal harmonics (JPL sat441 / Cassini Grand Finale).
 *
 * Truncated at J6. J8 is about 1e-5 and contributes less than the error in the
 * moon elements at every altitude the module can reach.
 */
export const SATURN_J2 = 1.629_056e-2;
export const SATURN_J4 = -9.358_3e-4;
export const SATURN_J6 = 8.614e-5;

/**
 * Rotation period of the interior, seconds — 10h 33m 38s.
 *
 * Not the System III radio period of 10h 39m 22s, which was long used for want
 * of anything better and is now known to track the magnetosphere rather than
 * the planet. This is the figure from ring seismology: waves raised in the C
 * ring by Saturn's own oscillations, read as a seismograph.
 */
export const SATURN_ROTATION_PERIOD = 38_018;

/** Saturn's north pole, IAU 2015, in J2000 equatorial coordinates. */
export const SATURN_POLE_RA_DEG = 40.589;
export const SATURN_POLE_DEC_DEG = 83.537;

/** Obliquity of the ecliptic at J2000. */
const ECLIPTIC_OBLIQUITY = 23.439_291 * DEG;

/**
 * Saturn's pole expressed in ecliptic coordinates, and from that the two
 * angles that define the working frame.
 *
 * Derived rather than tabulated, so that changing the pole in one place changes
 * the frame everywhere. `TILT` is the inclination of Saturn's equator to the
 * ecliptic — about 28.05 degrees, which is *not* the 26.73 degrees usually
 * quoted for Saturn's axial tilt; that figure is measured against Saturn's own
 * orbit, which is itself inclined 2.49 degrees.
 */
function poleAngles(): { node: number; tilt: number } {
  const ra = SATURN_POLE_RA_DEG * DEG;
  const dec = SATURN_POLE_DEC_DEG * DEG;

  // Equatorial to ecliptic.
  const sinBeta =
    Math.sin(dec) * Math.cos(ECLIPTIC_OBLIQUITY) -
    Math.cos(dec) * Math.sin(ECLIPTIC_OBLIQUITY) * Math.sin(ra);
  const beta = Math.asin(sinBeta);
  const lambda = Math.atan2(
    Math.sin(dec) * Math.sin(ECLIPTIC_OBLIQUITY) +
      Math.cos(dec) * Math.cos(ECLIPTIC_OBLIQUITY) * Math.sin(ra),
    Math.cos(dec) * Math.cos(ra),
  );

  // The equator's ascending node on the ecliptic sits a quarter turn ahead of
  // the pole's longitude; its inclination is the pole's colatitude.
  return { node: lambda + Math.PI / 2, tilt: Math.PI / 2 - beta };
}

const { node: EQUATOR_NODE, tilt: EQUATOR_TILT } = poleAngles();

/** Inclination of Saturn's equator to the ecliptic, radians. */
export const SATURN_EQUATOR_TILT = EQUATOR_TILT;

/** Ecliptic longitude of the ascending node of Saturn's equator, radians. */
export const SATURN_EQUATOR_NODE = EQUATOR_NODE;

/** Rotate an ecliptic vector into the working (Saturn-equatorial) frame. */
export const eclipticToSaturn = (v: Vec3): Vec3 =>
  rotateX(rotateZ(v, -EQUATOR_NODE), -EQUATOR_TILT);

/** The inverse: a working-frame vector back into ecliptic coordinates. */
export const saturnToEcliptic = (v: Vec3): Vec3 =>
  rotateZ(rotateX(v, EQUATOR_TILT), EQUATOR_NODE);

/**
 * Gravitational acceleration from Saturn at a point, km/s2, in the working
 * frame — point mass plus zonal harmonics.
 *
 * Written out in closed form rather than through a general harmonic recursion:
 * there are three terms, they never change, and this is called once per body
 * per force evaluation with the module's trajectory prediction calling it
 * hundreds of thousands of times per request.
 *
 * The bracketed polynomials are the gradients of the Legendre terms in the
 * potential U = (GM/r)[1 - sum J_n (Re/r)^n P_n(z/r)]; a test in
 * `saturn.test.ts` checks them against the classical secular node regression
 * rate, which is the cheapest available proof that no sign has slipped.
 */
export function saturnAcceleration(position: Vec3): Vec3 {
  const { x, y, z } = position;
  const r2 = x * x + y * y + z * z;
  const r = Math.sqrt(r2);
  if (r === 0) return vec3(0, 0, 0);

  const inverseR3 = 1 / (r2 * r);
  let ax = -SATURN_GM * x * inverseR3;
  let ay = -SATURN_GM * y * inverseR3;
  let az = -SATURN_GM * z * inverseR3;

  const u2 = (z * z) / r2;
  const u4 = u2 * u2;
  const u6 = u4 * u2;
  const ratio2 = (SATURN_GRAVITY_RADIUS * SATURN_GRAVITY_RADIUS) / r2;
  const ratio4 = ratio2 * ratio2;
  const ratio6 = ratio4 * ratio2;
  const gmOverR3 = SATURN_GM * inverseR3;

  // J2.
  const j2 = 1.5 * SATURN_J2 * gmOverR3 * ratio2;
  ax -= j2 * x * (1 - 5 * u2);
  ay -= j2 * y * (1 - 5 * u2);
  az -= j2 * z * (3 - 5 * u2);

  // J4.
  const j4 = 0.625 * SATURN_J4 * gmOverR3 * ratio4;
  ax += j4 * x * (3 - 42 * u2 + 63 * u4);
  ay += j4 * y * (3 - 42 * u2 + 63 * u4);
  az += j4 * z * (15 - 70 * u2 + 63 * u4);

  // J6.
  const j6 = 0.0625 * SATURN_J6 * gmOverR3 * ratio6;
  ax -= j6 * x * (35 - 945 * u2 + 3465 * u4 - 3003 * u6);
  ay -= j6 * y * (35 - 945 * u2 + 3465 * u4 - 3003 * u6);
  az -= j6 * z * (245 - 2205 * u2 + 4851 * u4 - 3003 * u6);

  return vec3(ax, ay, az);
}

/**
 * Gravitational potential of Saturn per unit mass, km2/s2, at a point in the
 * working frame.
 *
 * Written separately from `saturnAcceleration` rather than sharing code with
 * it, and deliberately so: the acceleration is a set of gradients worked out by
 * hand, and the only cheap way to know they are right is to differentiate this
 * — which is obviously correct, being a direct transcription of the Legendre
 * series — and compare. `saturn.test.ts` does exactly that, and it is the test
 * that would catch a dropped sign in any of the three harmonics.
 *
 * It also earns its keep at runtime: the energy check in `system.ts` needs the
 * oblate terms, and without them the conserved quantity would appear to
 * oscillate by a part in 60 for the inner moons.
 */
export function saturnPotential(position: Vec3): number {
  const { x, y, z } = position;
  const r = Math.sqrt(x * x + y * y + z * z);
  if (r === 0) return -Infinity;

  const u = z / r;
  const u2 = u * u;
  const ratio = SATURN_GRAVITY_RADIUS / r;
  const ratio2 = ratio * ratio;

  const p2 = 1.5 * u2 - 0.5;
  const p4 = (35 * u2 * u2 - 30 * u2 + 3) / 8;
  const p6 = (231 * u2 * u2 * u2 - 315 * u2 * u2 + 105 * u2 - 5) / 16;

  const series =
    SATURN_J2 * ratio2 * p2 +
    SATURN_J4 * ratio2 * ratio2 * p4 +
    SATURN_J6 * ratio2 * ratio2 * ratio2 * p6;

  return -(SATURN_GM / r) * (1 - series);
}

/**
 * Distance from Saturn's centre to its surface along a direction, km.
 *
 * The oblateness is large enough to matter for a collision test: a polar
 * approach hits the atmosphere 5 900 km sooner than an equatorial one, which
 * is more than the whole depth of the visible atmosphere.
 */
export function saturnSurfaceRadius(direction: Vec3): number {
  const r2 = direction.x ** 2 + direction.y ** 2 + direction.z ** 2;
  if (r2 === 0) return SATURN_POLAR_RADIUS;
  const sinLatitude2 = (direction.z * direction.z) / r2;
  const a2 = SATURN_EQUATORIAL_RADIUS * SATURN_EQUATORIAL_RADIUS;
  const b2 = SATURN_POLAR_RADIUS * SATURN_POLAR_RADIUS;
  return Math.sqrt((a2 * b2) / (b2 * (1 - sinLatitude2) + a2 * sinLatitude2));
}

export interface RingBand {
  id: string;
  /** Inner and outer radius from Saturn's centre, km. */
  inner: number;
  outer: number;
  /**
   * Representative normal optical depth. Drives how opaque the band is drawn
   * and how much of the Sun it blocks; it is a mean, and the real B ring runs
   * from 0.4 to over 5 across its width.
   */
  opticalDepth: number;
  /** True for a division or gap — drawn as a subtraction, not a band. */
  gap?: boolean;
}

/**
 * The ring system, by radius.
 *
 * Radii are from Cassini occultation profiles. The bands are listed
 * outward-going and non-overlapping so a renderer can simply walk the list, and
 * the narrow gaps are included as bands of their own rather than as holes,
 * because the two shepherded ones each contain a moon the player can visit —
 * Pan in the Encke gap, Daphnis in the Keeler.
 *
 * The E ring overlaps everything from Mimas to Rhea and is listed last for that
 * reason: it is a torus of ice from Enceladus's plumes, not a disc, and any
 * renderer has to treat it separately anyway.
 */
export const RING_BANDS: readonly RingBand[] = [
  { id: 'D', inner: 66_900, outer: 74_510, opticalDepth: 0.001 },
  { id: 'C', inner: 74_658, outer: 92_000, opticalDepth: 0.1 },
  { id: 'B', inner: 92_000, outer: 117_580, opticalDepth: 1.5 },
  { id: 'cassini', inner: 117_580, outer: 122_170, opticalDepth: 0.1, gap: true },
  { id: 'A-inner', inner: 122_170, outer: 133_410, opticalDepth: 0.6 },
  { id: 'encke', inner: 133_410, outer: 133_740, opticalDepth: 0.005, gap: true },
  { id: 'A-outer', inner: 133_740, outer: 136_505, opticalDepth: 0.5 },
  { id: 'keeler', inner: 136_505, outer: 136_547, opticalDepth: 0.005, gap: true },
  { id: 'A-edge', inner: 136_547, outer: 136_775, opticalDepth: 0.4 },
  { id: 'roche', inner: 136_775, outer: 139_380, opticalDepth: 0.002, gap: true },
  { id: 'F', inner: 140_100, outer: 140_600, opticalDepth: 0.1 },
  { id: 'G', inner: 166_000, outer: 175_000, opticalDepth: 1e-6 },
  { id: 'E', inner: 180_000, outer: 480_000, opticalDepth: 1e-5 },
];

/** Outer edge of the main rings, km — where the disc stops being a disc. */
export const MAIN_RING_OUTER = 140_600;

/**
 * GM of the whole ring system, km3/s2.
 *
 * From the Grand Finale mass determination: 1.54e19 kg, about four tenths of
 * Mimas. It is in the model for completeness and because players ask, but it
 * is 3e-11 of Saturn's own pull and changes no trajectory anyone will fly.
 */
export const RING_GM = 1.028e-3;

/** Is this radius inside a band dense enough to be a hazard? */
export function ringOpticalDepthAt(radiusKm: number): number {
  for (const band of RING_BANDS) {
    if (band.id === 'E' || band.id === 'G') continue;
    if (radiusKm >= band.inner && radiusKm < band.outer) return band.opticalDepth;
  }
  return 0;
}
