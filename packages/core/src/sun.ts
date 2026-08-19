/**
 * Where the Sun is, and therefore which way everything is lit.
 *
 * The Sun is not in the simulation. At Saturn's distance its tidal pull across
 * the moon system is about 1e-7 of Saturn's own, which is smaller than the
 * error in the moon elements by several orders of magnitude, and integrating a
 * body 1.4e9 km away alongside moons 1.3e5 km away would cost the step size
 * dearly for nothing. So the Sun enters the model in exactly one way: as a
 * direction, for lighting.
 *
 * That direction is worth getting right, because it is not static. Saturn takes
 * 29.5 years to go round, so the sub-solar latitude swings between +26.7 and
 * -26.7 degrees over half that: the rings open, close to an edge-on line, and
 * open the other way. That cycle is the most visible slow thing in the game,
 * and it falls straight out of Saturn's own orbit.
 */

import {
  SATURN_EQUATOR_TILT,
  eclipticToSaturn,
} from './saturn.js';
import { julianCenturies } from './time.js';
import { AU_IN_KM } from './units.js';
import { DEG, length, normalize, scale, vec3, type Vec3 } from './vec.js';

/**
 * Saturn's heliocentric orbit — JPL's approximate elements, 3000 BC to 3000 AD.
 *
 * The same table the sibling Orrery uses, deliberately: the two projects should
 * not disagree about where Saturn is. Angles in degrees, rates per Julian
 * century, `a` in AU.
 */
const SATURN_ORBIT = {
  a: 9.541_498_83,
  e: 0.055_508_25,
  i: 2.494_241_02,
  L: 50.075_713_29,
  peri: 92.861_360_63,
  node: 113.639_987_02,
  rates: {
    a: -0.000_030_65,
    e: -0.000_320_44,
    i: 0.004_519_69,
    L: 1_222.114_947_24,
    peri: 0.541_794_78,
    node: -0.250_150_02,
  },
  /**
   * The extra terms JPL specifies for Jupiter through Pluto. They stand in for
   * the great inequality — the 900-year Jupiter-Saturn near-resonance that a
   * plain linear element set cannot express, and which is worth nearly a degree
   * of Saturn's longitude at the edges of the range.
   */
  correction: { b: 0.000_258_99, c: -0.134_344_69, s: 0.873_201_47, f: 38.351_25 },
} as const;

/** Newton-Raphson on Kepler's equation. Saturn's e is 0.055; this converges fast. */
function eccentricAnomaly(meanAnomalyRad: number, e: number): number {
  let anomaly = meanAnomalyRad;
  for (let i = 0; i < 16; i++) {
    const delta =
      (anomaly - e * Math.sin(anomaly) - meanAnomalyRad) / (1 - e * Math.cos(anomaly));
    anomaly -= delta;
    if (Math.abs(delta) < 1e-13) break;
  }
  return anomaly;
}

/**
 * Saturn's position relative to the Sun, in ecliptic coordinates, km.
 */
export function saturnHeliocentric(timeSeconds: number): Vec3 {
  const T = julianCenturies(timeSeconds);
  const o = SATURN_ORBIT;

  const a = o.a + o.rates.a * T;
  const e = o.e + o.rates.e * T;
  const i = (o.i + o.rates.i * T) * DEG;
  const L = o.L + o.rates.L * T;
  const peri = o.peri + o.rates.peri * T;
  const node = (o.node + o.rates.node * T) * DEG;

  const { b, c, s, f } = o.correction;
  const meanAnomalyDeg =
    L - peri + b * T * T + c * Math.cos(f * T * DEG) + s * Math.sin(f * T * DEG);
  const meanAnomaly = (((meanAnomalyDeg % 360) + 540) % 360 - 180) * DEG;

  const E = eccentricAnomaly(meanAnomaly, e);
  const xPlane = a * (Math.cos(E) - e);
  const yPlane = a * Math.sqrt(1 - e * e) * Math.sin(E);

  const argPeri = peri * DEG - node;
  const cosW = Math.cos(argPeri);
  const sinW = Math.sin(argPeri);
  const cosN = Math.cos(node);
  const sinN = Math.sin(node);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);

  return scale(
    vec3(
      (cosW * cosN - sinW * sinN * cosI) * xPlane +
        (-sinW * cosN - cosW * sinN * cosI) * yPlane,
      (cosW * sinN + sinW * cosN * cosI) * xPlane +
        (-sinW * sinN + cosW * cosN * cosI) * yPlane,
      sinW * sinI * xPlane + cosW * sinI * yPlane,
    ),
    AU_IN_KM,
  );
}

export interface SolarGeometry {
  /** Unit vector from Saturn toward the Sun, in the working frame. */
  direction: Vec3;
  /** Saturn-Sun distance, km. */
  distanceKm: number;
  /**
   * Latitude of the sub-solar point on Saturn, radians. Equivalently the
   * opening angle of the rings: zero at an equinox, +-0.466 at a solstice.
   */
  subSolarLatitude: number;
  /**
   * Solar irradiance at Saturn, W/m2. About 15 at mean distance, against 1361
   * at Earth — one percent, which is why every surface out here is dim and why
   * the module's power budget is a real constraint.
   */
  irradiance: number;
}

/** Solar constant at 1 AU, W/m2. */
const SOLAR_CONSTANT = 1_361;

/**
 * The Sun's direction and strength as seen from Saturn, in the working frame.
 *
 * Every moon is treated as lit from this same direction. The approximation is
 * exact to within the angle Saturn's system subtends at the Sun: 25 million km
 * at 1.4 billion is one degree at the very worst, out at the Norse group, and
 * a thousandth of that for anything the player will actually fly to.
 */
export function solarGeometry(timeSeconds: number): SolarGeometry {
  const heliocentric = saturnHeliocentric(timeSeconds);
  const distanceKm = length(heliocentric);

  // From Saturn toward the Sun is the reverse of Sun toward Saturn.
  const direction = eclipticToSaturn(normalize(scale(heliocentric, -1)));

  const distanceAu = distanceKm / AU_IN_KM;

  return {
    direction,
    distanceKm,
    subSolarLatitude: Math.asin(Math.min(1, Math.max(-1, direction.z))),
    irradiance: SOLAR_CONSTANT / (distanceAu * distanceAu),
  };
}

/**
 * How open the rings are to the Sun, 0 to 1.
 *
 * Sine of the sub-solar latitude: 1 at a solstice with the rings fully lit
 * face-on, 0 at an equinox when the Sun is in the ring plane and the rings all
 * but vanish. It also scales how much light the ring particles return, which is
 * why Saturn is visibly brighter in the sky at some oppositions than others.
 *
 * The maximum is the tilt of Saturn's equator, so this never quite reaches 1.
 */
export const ringOpening = (geometry: SolarGeometry): number =>
  Math.abs(Math.sin(geometry.subSolarLatitude)) / Math.sin(SATURN_EQUATOR_TILT);
