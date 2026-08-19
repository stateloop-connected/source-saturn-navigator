/**
 * Keplerian elements and state vectors, each way.
 *
 * Two conversions that look like inverses but answer opposite questions.
 *
 * `stateFromElements` runs once, at start-up, to turn the catalogue into
 * something the integrator can hold. After that the elements are gone: the
 * simulation's state is positions and velocities, and nothing consults the
 * table again.
 *
 * `osculatingElements` runs constantly, and reads the other way — given where
 * the module *is* and how fast it is going, what ellipse is it on? That ellipse
 * is a fiction, true only for as long as no other force acts, which around
 * Saturn is not long. But it is the fiction every navigator works in, because
 * "periapsis 62 000 km in 2h 14m" is a thing a person can fly on and a state
 * vector is not.
 */

import {
  DEG,
  RAD,
  TAU,
  cross,
  dot,
  length,
  scale,
  sub,
  vec3,
  wrapRad,
  type Vec3,
} from './vec.js';

export interface StateVector {
  position: Vec3;
  velocity: Vec3;
}

export interface KeplerianElements {
  /** Semi-major axis, km. Negative on a hyperbolic orbit. */
  a: number;
  e: number;
  /** Inclination, radians. */
  i: number;
  /** Longitude of the ascending node, radians. */
  node: number;
  /** Argument of periapsis, radians. */
  peri: number;
  /** True anomaly, radians. */
  trueAnomaly: number;
}

/** Solve Kepler's equation for the elliptic case. */
export function eccentricAnomaly(meanAnomaly: number, e: number): number {
  // Starting guess: mean anomaly for near-circular orbits, pi for very eccentric
  // ones, where the plain guess converges slowly near periapsis.
  let anomaly = e < 0.8 ? meanAnomaly : Math.PI;
  for (let i = 0; i < 40; i++) {
    const delta =
      (anomaly - e * Math.sin(anomaly) - meanAnomaly) / (1 - e * Math.cos(anomaly));
    anomaly -= delta;
    if (Math.abs(delta) < 1e-14) break;
  }
  return anomaly;
}

/** Rotate from the perifocal frame out into the reference frame. */
function perifocalToReference(
  xPlane: number,
  yPlane: number,
  node: number,
  peri: number,
  inclination: number,
): Vec3 {
  const cosW = Math.cos(peri);
  const sinW = Math.sin(peri);
  const cosN = Math.cos(node);
  const sinN = Math.sin(node);
  const cosI = Math.cos(inclination);
  const sinI = Math.sin(inclination);

  return vec3(
    (cosW * cosN - sinW * sinN * cosI) * xPlane +
      (-sinW * cosN - cosW * sinN * cosI) * yPlane,
    (cosW * sinN + sinW * cosN * cosI) * xPlane +
      (-sinW * sinN + cosW * cosN * cosI) * yPlane,
    sinW * sinI * xPlane + cosW * sinI * yPlane,
  );
}

export interface ElementSeed {
  /** Semi-major axis, km. */
  a: number;
  e: number;
  /** Inclination, degrees. */
  i: number;
  /** Longitude of the ascending node, degrees. */
  node: number;
  /** Argument of periapsis, degrees. */
  peri: number;
  /** Mean longitude at epoch, degrees — node + peri + mean anomaly. */
  meanLongitude: number;
}

/**
 * Position and velocity from elements, for a body orbiting a primary of `gm`.
 *
 * Takes mean *longitude* rather than mean anomaly because that is the quantity
 * that stays meaningful as e and i approach zero, which for most of these moons
 * they do. With a near-circular equatorial orbit the node and the periapsis are
 * both nearly undefined and their individual values are noise; their sum with
 * the anomaly is not.
 */
export function stateFromElements(seed: ElementSeed, gm: number): StateVector {
  const { a, e } = seed;
  const i = seed.i * DEG;
  const node = seed.node * DEG;
  const peri = seed.peri * DEG;
  const meanAnomaly = wrapRad((seed.meanLongitude - seed.node - seed.peri) * DEG);

  const E = eccentricAnomaly(meanAnomaly, e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const beta = Math.sqrt(1 - e * e);

  const xPlane = a * (cosE - e);
  const yPlane = a * beta * sinE;

  // Radial distance is what scales the velocity, and it comes free from E.
  const r = a * (1 - e * cosE);
  const meanMotion = Math.sqrt(gm / (a * a * a));
  const factor = (a * a * meanMotion) / r;
  const vxPlane = -factor * sinE;
  const vyPlane = factor * beta * cosE;

  return {
    position: perifocalToReference(xPlane, yPlane, node, peri, i),
    velocity: perifocalToReference(vxPlane, vyPlane, node, peri, i),
  };
}

export interface OrbitSummary extends KeplerianElements {
  /** Periapsis and apoapsis distance from the centre, km. Apoapsis is Infinity if unbound. */
  periapsis: number;
  apoapsis: number;
  /** Orbital period, seconds. Infinity if unbound. */
  period: number;
  /** Specific orbital energy, km2/s2. Negative means bound. */
  energy: number;
  bound: boolean;
  /** Mean anomaly, radians. Meaningless when unbound. */
  meanAnomaly: number;
  /** Time from now to the next periapsis passage, seconds. */
  timeToPeriapsis: number;
}

/**
 * The osculating orbit through a state vector.
 *
 * Standard construction from the angular momentum and eccentricity vectors,
 * with the usual degenerate cases handled rather than left to produce NaN —
 * which matters here more than usual, because a game hands this function
 * genuinely equatorial and genuinely circular orbits all the time. A player who
 * has just circularised gets e = 3e-17, and an implementation that divides by
 * it puts junk on the navigation readout at the exact moment the player is
 * looking at it.
 */
export function osculatingElements(
  position: Vec3,
  velocity: Vec3,
  gm: number,
): OrbitSummary {
  const r = length(position);
  const v2 = dot(velocity, velocity);

  const angularMomentum = cross(position, velocity);
  const h = length(angularMomentum);

  const energy = v2 / 2 - gm / r;
  const a = -gm / (2 * energy);

  // e-vector: (v x h)/mu - r/|r|.
  const eVector = sub(
    scale(cross(velocity, angularMomentum), 1 / gm),
    scale(position, 1 / r),
  );
  const e = length(eVector);

  const inclination = h === 0 ? 0 : Math.acos(Math.min(1, Math.max(-1, angularMomentum.z / h)));

  // Node vector: z x h. Zero for an exactly equatorial orbit.
  const nodeVector = vec3(-angularMomentum.y, angularMomentum.x, 0);
  const nodeLength = length(nodeVector);

  let node: number;
  let peri: number;
  let trueAnomaly: number;

  const EQUATORIAL = 1e-11;
  const CIRCULAR = 1e-11;

  if (nodeLength < EQUATORIAL) {
    // Equatorial: no node to measure from, so measure from the x-axis.
    node = 0;
    if (e < CIRCULAR) {
      peri = 0;
      trueAnomaly = wrapRad(Math.atan2(position.y, position.x));
    } else {
      peri = wrapRad(Math.atan2(eVector.y, eVector.x));
      trueAnomaly = wrapRad(
        Math.atan2(position.y, position.x) - peri,
      );
    }
    // A retrograde equatorial orbit runs the other way round.
    if (angularMomentum.z < 0) {
      peri = wrapRad(-peri);
      trueAnomaly = wrapRad(-trueAnomaly);
    }
  } else {
    node = wrapRad(Math.atan2(nodeVector.y, nodeVector.x));
    if (e < CIRCULAR) {
      peri = 0;
      const u = Math.atan2(
        dot(position, cross(angularMomentum, nodeVector)) / (h * nodeLength),
        dot(position, nodeVector) / nodeLength,
      );
      trueAnomaly = wrapRad(u);
    } else {
      peri = wrapRad(
        Math.atan2(
          dot(eVector, cross(angularMomentum, nodeVector)) / (h * nodeLength),
          dot(eVector, nodeVector) / nodeLength,
        ),
      );
      trueAnomaly = wrapRad(
        Math.atan2(dot(position, cross(angularMomentum, eVector)) / (h * e), dot(position, eVector) / e),
      );
    }
  }

  const bound = energy < 0 && e < 1;
  const periapsis = bound ? a * (1 - e) : (h * h) / gm / (1 + e);
  const apoapsis = bound ? a * (1 + e) : Infinity;
  const period = bound ? TAU * Math.sqrt(a ** 3 / gm) : Infinity;

  // Mean anomaly from true, via eccentric — needed for time-to-periapsis.
  let meanAnomaly = 0;
  let timeToPeriapsis = Infinity;
  if (bound) {
    const cosNu = Math.cos(trueAnomaly);
    const E = Math.atan2(
      Math.sqrt(1 - e * e) * Math.sin(trueAnomaly),
      e + cosNu,
    );
    meanAnomaly = wrapRad(E - e * Math.sin(E));
    timeToPeriapsis = ((TAU - meanAnomaly) % TAU) * (period / TAU);
  }

  return {
    a,
    e,
    i: inclination,
    node,
    peri,
    trueAnomaly,
    periapsis,
    apoapsis,
    period,
    energy,
    bound,
    meanAnomaly,
    timeToPeriapsis,
  };
}

/**
 * Points along an osculating orbit, for drawing it.
 *
 * Sampled in *eccentric* anomaly rather than true anomaly, which spaces the
 * points evenly along the path instead of bunching them all at periapsis. On an
 * eccentric transfer that is the difference between a smooth ellipse and a
 * polygon with a blob at one end.
 *
 * An unbound orbit is sampled over the true-anomaly range that stays inside
 * `maxRadius`, so a hyperbolic escape draws as an arc leaving the map rather
 * than as a line to infinity.
 */
export function sampleOrbit(
  orbit: KeplerianElements,
  samples = 180,
  maxRadius = Infinity,
): Vec3[] {
  const { a, e, i, node, peri } = orbit;
  const points: Vec3[] = [];

  if (e < 1) {
    for (let k = 0; k <= samples; k++) {
      const E = (k / samples) * TAU;
      const xPlane = a * (Math.cos(E) - e);
      const yPlane = a * Math.sqrt(1 - e * e) * Math.sin(E);
      points.push(perifocalToReference(xPlane, yPlane, node, peri, i));
    }
    return points;
  }

  // Hyperbolic: a is negative, and the true anomaly is bounded by the asymptote.
  const semiLatus = a * (1 - e * e);
  const limit = Math.acos(-1 / e);
  const reach = Number.isFinite(maxRadius)
    ? Math.min(limit * 0.999, Math.acos(Math.min(1, Math.max(-1, (semiLatus / maxRadius - 1) / e))))
    : limit * 0.999;

  for (let k = 0; k <= samples; k++) {
    const nu = -reach + (2 * reach * k) / samples;
    const r = semiLatus / (1 + e * Math.cos(nu));
    points.push(
      perifocalToReference(r * Math.cos(nu), r * Math.sin(nu), node, peri, i),
    );
  }
  return points;
}

/** Elements in degrees, for display. */
export const inDegrees = (orbit: KeplerianElements) => ({
  inclination: orbit.i * RAD,
  node: orbit.node * RAD,
  peri: orbit.peri * RAD,
  trueAnomaly: orbit.trueAnomaly * RAD,
});
