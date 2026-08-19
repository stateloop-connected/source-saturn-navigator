import { describe, expect, it } from 'vitest';
import {
  SATURN_EQUATORIAL_RADIUS,
  SATURN_EQUATOR_TILT,
  SATURN_GM,
  SATURN_POLAR_RADIUS,
  eclipticToSaturn,
  saturnAcceleration,
  saturnPotential,
  saturnSurfaceRadius,
  saturnToEcliptic,
} from './saturn.js';
import { DEG, RAD, length, scale, sub, vec3 } from './vec.js';

/**
 * The load-bearing test in the package.
 *
 * `saturnAcceleration` is three hand-differentiated Legendre terms, and a
 * dropped sign in any of them would produce a field that still looks like
 * gravity, still holds moons in orbits, and is quietly wrong — the kind of
 * error that surfaces months later as "the node precesses the wrong way".
 * Differentiating the potential numerically and comparing is the cheap way to
 * know, and it checks all three harmonics at once.
 */
describe('the oblate field is the gradient of the oblate potential', () => {
  const points = [
    vec3(70_000, 0, 0),
    vec3(0, 120_000, 0),
    vec3(0, 0, 90_000),
    vec3(60_000, 60_000, 30_000),
    vec3(-180_000, 40_000, -70_000),
    vec3(900_000, -300_000, 200_000),
  ];

  for (const point of points) {
    it(`agrees at (${point.x}, ${point.y}, ${point.z})`, () => {
      const h = 0.5; // km
      const numerical = vec3(
        (saturnPotential(vec3(point.x + h, point.y, point.z)) -
          saturnPotential(vec3(point.x - h, point.y, point.z))) /
          (2 * h),
        (saturnPotential(vec3(point.x, point.y + h, point.z)) -
          saturnPotential(vec3(point.x, point.y - h, point.z))) /
          (2 * h),
        (saturnPotential(vec3(point.x, point.y, point.z + h)) -
          saturnPotential(vec3(point.x, point.y, point.z - h))) /
          (2 * h),
      );

      // `saturnPotential` is the physics convention — potential energy per unit
      // mass, negative and going to zero at infinity — so the field is minus
      // its gradient. The hand-derived terms in `saturnAcceleration` were
      // worked out from the geodesy form, where U is positive and the sign is
      // the other way; the two conventions meet here.
      const analytic = saturnAcceleration(point);
      const error = length(sub(analytic, scale(numerical, -1))) / length(analytic);
      expect(error).toBeLessThan(1e-7);
    });
  }
});

describe('harmonics act in the right direction', () => {
  it('pulls harder at the equator than over the pole, at equal distance', () => {
    // An oblate body has extra mass around its waist, so the equatorial field
    // is the stronger one. If J2 had the wrong sign this would invert.
    const r = 100_000;
    const equatorial = length(saturnAcceleration(vec3(r, 0, 0)));
    const polar = length(saturnAcceleration(vec3(0, 0, r)));
    expect(equatorial).toBeGreaterThan(polar);
  });

  it('J2 is worth about a part in sixty at Mimas', () => {
    const r = 185_540;
    const withHarmonics = length(saturnAcceleration(vec3(r, 0, 0)));
    const pointMass = SATURN_GM / (r * r);
    const excess = (withHarmonics - pointMass) / pointMass;
    // (3/2) J2 (Re/r)^2 at Mimas is 2.6e-3.
    expect(excess).toBeGreaterThan(2.0e-3);
    expect(excess).toBeLessThan(3.2e-3);
  });

  it('reduces to a point mass far away', () => {
    const r = 12_000_000; // Phoebe's distance
    const withHarmonics = length(saturnAcceleration(vec3(r, 0, 0)));
    const pointMass = SATURN_GM / (r * r);
    // (3/2) J2 (Re/r)^2 is still 6.2e-7 out at Phoebe: small, but not zero.
    expect(Math.abs(withHarmonics - pointMass) / pointMass).toBeLessThan(1e-6);
  });
});

describe('the working frame', () => {
  it('is tilted about 28 degrees to the ecliptic, not 26.7', () => {
    // 26.73 degrees is Saturn's tilt against its *own orbit*, which is itself
    // inclined 2.49 degrees. Against the ecliptic the figure is larger, and
    // conflating the two is the classic way to get this frame wrong.
    expect(SATURN_EQUATOR_TILT * RAD).toBeGreaterThan(27.9);
    expect(SATURN_EQUATOR_TILT * RAD).toBeLessThan(28.2);
  });

  it('round-trips a vector', () => {
    const original = vec3(123_456, -78_901, 23_456);
    const returned = saturnToEcliptic(eclipticToSaturn(original));
    expect(length(sub(returned, original))).toBeLessThan(1e-6);
  });

  it('takes an ecliptic pole vector onto the tilt angle', () => {
    const eclipticPole = eclipticToSaturn(vec3(0, 0, 1));
    // The ecliptic pole, seen in Saturn's frame, sits at the tilt from Saturn's
    // own pole.
    expect(Math.acos(eclipticPole.z) * RAD).toBeCloseTo(SATURN_EQUATOR_TILT * RAD, 6);
  });
});

describe('the oblate surface', () => {
  it('matches the equatorial radius on the equator', () => {
    expect(saturnSurfaceRadius(vec3(1, 0, 0))).toBeCloseTo(SATURN_EQUATORIAL_RADIUS, 6);
  });

  it('matches the polar radius over the pole', () => {
    expect(saturnSurfaceRadius(vec3(0, 0, 1))).toBeCloseTo(SATURN_POLAR_RADIUS, 6);
  });

  it('is nearly six thousand km shallower over the pole', () => {
    const difference =
      saturnSurfaceRadius(vec3(1, 0, 0)) - saturnSurfaceRadius(vec3(0, 0, 1));
    expect(difference).toBeGreaterThan(5_800);
  });

  it('varies monotonically with latitude', () => {
    let previous = Infinity;
    for (let latitude = 0; latitude <= 90; latitude += 5) {
      const radius = saturnSurfaceRadius(
        vec3(Math.cos(latitude * DEG), 0, Math.sin(latitude * DEG)),
      );
      expect(radius).toBeLessThanOrEqual(previous + 1e-9);
      previous = radius;
    }
  });
});
