import { describe, expect, it } from 'vitest';
import { osculatingElements, sampleOrbit, stateFromElements } from './elements.js';
import { SATURN_GM } from './saturn.js';
import { circularSpeed, escapeSpeed } from './units.js';
import { DEG, RAD, length, sub, vec3, wrapDeg } from './vec.js';

describe('elements round-trip through state vectors', () => {
  const cases = [
    { name: 'near-circular equatorial', a: 300_000, e: 0.001, i: 0.05, node: 30, peri: 40, meanLongitude: 100 },
    { name: 'inclined', a: 1_200_000, e: 0.03, i: 15.5, node: 210, peri: 95, meanLongitude: 300 },
    { name: 'eccentric', a: 900_000, e: 0.62, i: 8, node: 12, peri: 250, meanLongitude: 33 },
    { name: 'retrograde', a: 12_900_000, e: 0.16, i: 175.2, node: 88, peri: 120, meanLongitude: 200 },
    { name: 'polar', a: 500_000, e: 0.2, i: 90, node: 0, peri: 0, meanLongitude: 45 },
  ];

  for (const seed of cases) {
    it(seed.name, () => {
      const state = stateFromElements(seed, SATURN_GM);
      const orbit = osculatingElements(state.position, state.velocity, SATURN_GM);

      expect(orbit.a).toBeCloseTo(seed.a, 3);
      expect(orbit.e).toBeCloseTo(seed.e, 9);
      expect(orbit.i * RAD).toBeCloseTo(seed.i, 8);

      // The recovered longitude is what must match; node and periapsis are
      // individually ill-conditioned when e or i approach zero, and splitting
      // the same total between them differently is not an error.
      const recovered = wrapDeg(
        (orbit.node + orbit.peri) * RAD +
          (orbit.meanAnomaly * RAD),
      );
      expect(recovered).toBeCloseTo(wrapDeg(seed.meanLongitude), 5);
    });
  }
});

describe('degenerate orbits do not produce NaN', () => {
  it('handles an exactly circular equatorial orbit', () => {
    // What a player has the instant after a successful circularisation, and the
    // classic way to get junk on a navigation display.
    const r = 250_000;
    const orbit = osculatingElements(
      vec3(r, 0, 0),
      vec3(0, circularSpeed(SATURN_GM, r), 0),
      SATURN_GM,
    );
    expect(Number.isFinite(orbit.a)).toBe(true);
    expect(Number.isFinite(orbit.trueAnomaly)).toBe(true);
    expect(Number.isFinite(orbit.timeToPeriapsis)).toBe(true);
    expect(orbit.e).toBeLessThan(1e-12);
    expect(orbit.periapsis).toBeCloseTo(r, 6);
    expect(orbit.apoapsis).toBeCloseTo(r, 6);
  });

  it('handles a radial fall, which has no orbital plane at all', () => {
    const orbit = osculatingElements(vec3(200_000, 0, 0), vec3(-1, 0, 0), SATURN_GM);
    expect(Number.isNaN(orbit.a)).toBe(false);
    expect(Number.isNaN(orbit.i)).toBe(false);
  });
});

describe('bound and unbound', () => {
  it('calls a sub-escape orbit bound', () => {
    const r = 400_000;
    const orbit = osculatingElements(
      vec3(r, 0, 0),
      vec3(0, circularSpeed(SATURN_GM, r), 0),
      SATURN_GM,
    );
    expect(orbit.bound).toBe(true);
    expect(orbit.energy).toBeLessThan(0);
    expect(Number.isFinite(orbit.period)).toBe(true);
  });

  it('calls an escape trajectory unbound, with infinite period', () => {
    const r = 400_000;
    const orbit = osculatingElements(
      vec3(r, 0, 0),
      vec3(0, escapeSpeed(SATURN_GM, r) * 1.1, 0),
      SATURN_GM,
    );
    expect(orbit.bound).toBe(false);
    expect(orbit.e).toBeGreaterThan(1);
    expect(orbit.period).toBe(Infinity);
    expect(orbit.apoapsis).toBe(Infinity);
    expect(Number.isFinite(orbit.periapsis)).toBe(true);
  });
});

describe('sampling an orbit for drawing', () => {
  it('closes an ellipse', () => {
    const orbit = osculatingElements(
      vec3(300_000, 0, 0),
      vec3(0, circularSpeed(SATURN_GM, 300_000) * 0.9, 0),
      SATURN_GM,
    );
    const points = sampleOrbit(orbit, 120);
    expect(points).toHaveLength(121);
    expect(length(sub(points[0]!, points[120]!))).toBeLessThan(1e-6);
  });

  it('spaces points evenly along the path, not bunched at periapsis', () => {
    // Sampling in true anomaly would put half the points in a tenth of the
    // path on an orbit this eccentric, and draw a polygon with a blob on it.
    const orbit = osculatingElements(
      vec3(300_000, 0, 0),
      vec3(0, circularSpeed(SATURN_GM, 300_000) * 0.55, 0),
      SATURN_GM,
    );
    const points = sampleOrbit(orbit, 180);

    let shortest = Infinity;
    let longest = 0;
    for (let k = 1; k < points.length; k++) {
      const segment = length(sub(points[k]!, points[k - 1]!));
      shortest = Math.min(shortest, segment);
      longest = Math.max(longest, segment);
    }
    expect(longest / shortest).toBeLessThan(4);
  });

  it('truncates a hyperbolic path at the requested radius', () => {
    const orbit = osculatingElements(
      vec3(400_000, 0, 0),
      vec3(0, escapeSpeed(SATURN_GM, 400_000) * 1.3, 0),
      SATURN_GM,
    );
    const limit = 5_000_000;
    for (const point of sampleOrbit(orbit, 90, limit)) {
      expect(length(point)).toBeLessThanOrEqual(limit * 1.001);
    }
  });
});

describe('inclination conventions', () => {
  it('treats over 90 degrees as retrograde', () => {
    const state = stateFromElements(
      { a: 500_000, e: 0.1, i: 160, node: 0, peri: 0, meanLongitude: 0 },
      SATURN_GM,
    );
    // A retrograde orbit's angular momentum points south.
    const hz = state.position.x * state.velocity.y - state.position.y * state.velocity.x;
    expect(hz).toBeLessThan(0);
    expect(osculatingElements(state.position, state.velocity, SATURN_GM).i * RAD).toBeCloseTo(160, 8);
  });

  it('puts a zero-inclination orbit in the ring plane', () => {
    const state = stateFromElements(
      { a: 300_000, e: 0.02, i: 0, node: 0, peri: 45, meanLongitude: 120 },
      SATURN_GM,
    );
    expect(Math.abs(state.position.z)).toBeLessThan(1e-9);
    expect(Math.abs(state.velocity.z)).toBeLessThan(1e-12);
  });

  it('tilts a 15-degree orbit by the right amount', () => {
    // Iapetus, whose inclination is the largest among the regular moons and the
    // reason it is the one moon that leaves the ring plane visibly.
    const state = stateFromElements(
      { a: 3_560_840, e: 0, i: 15.47, node: 0, peri: 0, meanLongitude: 90 },
      SATURN_GM,
    );
    const height = Math.asin(state.position.z / length(state.position)) * RAD;
    expect(Math.abs(height)).toBeCloseTo(15.47, 6);
  });

  it('agrees with a hand-built equatorial state', () => {
    const state = stateFromElements(
      { a: 200_000, e: 0, i: 0, node: 0, peri: 0, meanLongitude: 0 },
      SATURN_GM,
    );
    expect(state.position.x).toBeCloseTo(200_000, 6);
    expect(state.position.y).toBeCloseTo(0, 6);
    expect(state.velocity.y).toBeCloseTo(circularSpeed(SATURN_GM, 200_000), 9);
    expect(90 * DEG).toBeCloseTo(Math.PI / 2, 12);
  });
});
