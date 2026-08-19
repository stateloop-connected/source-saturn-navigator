/**
 * The force law, and the only place it is written down.
 *
 * Everything that needs gravity comes through here: the integrator advancing
 * the moons, the module riding in their field, the predictor running a forked
 * copy forward, and the overlay that draws arrows on a patch of empty space.
 * One implementation means the arrows the player is shown are made of the same
 * arithmetic that will actually move the ship, which is the whole promise of
 * the overlay.
 *
 * ## Frame
 *
 * Barycentric, with Saturn as body 0 rather than as a fixed origin. A
 * Saturn-centred frame would be more convenient — the renderer wants Saturn at
 * the middle, and it gets that with one subtraction — but it is not inertial,
 * and paying for that with indirect terms would cost the integrator its
 * symplectic structure. Here the Hamiltonian stays separable, so the
 * composition scheme in `integrator.ts` conserves energy over long runs instead
 * of letting the moons spiral.
 *
 * Titan moves Saturn by about 400 km, so the offset is real but small.
 *
 * ## Oblateness
 *
 * Saturn's J2 is not a refinement to be added later; at 1.63e-2 it is fifteen
 * times the Earth's, and it is what holds the whole inner system in the ring
 * plane. It enters as an interaction between Saturn and each other body, with
 * the reaction applied back to Saturn so that momentum is still conserved
 * exactly. Saturn's pole is held fixed, which neglects the torque the moons
 * exert on the bulge — a real effect, but one that acts on a spin angular
 * momentum thousands of times larger than anything here, over timescales of
 * millions of years.
 */

import { SATURN_GM, saturnAcceleration } from './saturn.js';
import { vec3, type Vec3 } from './vec.js';

/**
 * Accelerations for every body, from every other body.
 *
 * Flat `Float64Array`s, not `Vec3`s. The inner loop runs 1 431 pairs per
 * evaluation, three evaluations per step, and up to a million steps per
 * prediction request; allocating three objects per body per pass would dominate
 * everything else in the file.
 *
 * `out` is written, never read, and must be the same length as `positions`.
 */
export function computeAccelerations(
  positions: Float64Array,
  gm: Float64Array,
  count: number,
  out: Float64Array,
): void {
  out.fill(0);

  // Point-mass term, each pair visited once.
  for (let i = 0; i < count; i++) {
    const bi = i * 3;
    const gmI = gm[i]!;
    for (let j = i + 1; j < count; j++) {
      const bj = j * 3;
      const dx = positions[bj]! - positions[bi]!;
      const dy = positions[bj + 1]! - positions[bi + 1]!;
      const dz = positions[bj + 2]! - positions[bi + 2]!;

      const distanceSquared = dx * dx + dy * dy + dz * dz;
      const inverseCube = 1 / (distanceSquared * Math.sqrt(distanceSquared));

      const pullOnI = gm[j]! * inverseCube;
      out[bi] = out[bi]! + dx * pullOnI;
      out[bi + 1] = out[bi + 1]! + dy * pullOnI;
      out[bi + 2] = out[bi + 2]! + dz * pullOnI;

      const pullOnJ = gmI * inverseCube;
      out[bj] = out[bj]! - dx * pullOnJ;
      out[bj + 1] = out[bj + 1]! - dy * pullOnJ;
      out[bj + 2] = out[bj + 2]! - dz * pullOnJ;
    }
  }

  // Oblateness of body 0, as a correction on top of the point mass already
  // applied above. `saturnAcceleration` returns the full field, so the
  // point-mass part is taken back out before the remainder is added.
  const inverseSaturnGm = 1 / SATURN_GM;
  for (let i = 1; i < count; i++) {
    const bi = i * 3;
    const dx = positions[bi]! - positions[0]!;
    const dy = positions[bi + 1]! - positions[1]!;
    const dz = positions[bi + 2]! - positions[2]!;

    const r2 = dx * dx + dy * dy + dz * dz;
    if (r2 === 0) continue;
    const inverseCube = 1 / (r2 * Math.sqrt(r2));

    const full = saturnAcceleration(vec3(dx, dy, dz));
    const cx = full.x + SATURN_GM * dx * inverseCube;
    const cy = full.y + SATURN_GM * dy * inverseCube;
    const cz = full.z + SATURN_GM * dz * inverseCube;

    out[bi] = out[bi]! + cx;
    out[bi + 1] = out[bi + 1]! + cy;
    out[bi + 2] = out[bi + 2]! + cz;

    // Reaction on Saturn, scaled by the mass ratio.
    const ratio = gm[i]! * inverseSaturnGm;
    out[0] = out[0]! - cx * ratio;
    out[1] = out[1]! - cy * ratio;
    out[2] = out[2]! - cz * ratio;
  }
}

/**
 * Acceleration a massless particle would feel at a point, km/s2.
 *
 * The module's equation of motion, and the field overlay's arrow, are the same
 * call. The module is treated as massless — at a tonne against Mimas's 3.7e19
 * kg, its own pull on the system is 26 orders of magnitude down, and leaving it
 * out means the predictor can fork the moons once and fly any number of
 * candidate trajectories through them.
 *
 * `softening` is a floor on the distance, in km, and exists only to keep the
 * field overlay finite where a sample point lands inside a moon. Pass zero for
 * anything that is meant to be physics.
 */
export function gravityAt(
  point: Vec3,
  positions: Float64Array,
  gm: Float64Array,
  count: number,
  softening = 0,
): Vec3 {
  // Saturn's oblate field, relative to wherever Saturn currently is.
  const relative = vec3(
    point.x - positions[0]!,
    point.y - positions[1]!,
    point.z - positions[2]!,
  );
  let { x: ax, y: ay, z: az } = saturnAcceleration(relative);

  const softening2 = softening * softening;

  for (let i = 1; i < count; i++) {
    const bi = i * 3;
    const dx = positions[bi]! - point.x;
    const dy = positions[bi + 1]! - point.y;
    const dz = positions[bi + 2]! - point.z;

    const distanceSquared = dx * dx + dy * dy + dz * dz + softening2;
    if (distanceSquared === 0) continue;
    const pull = gm[i]! / (distanceSquared * Math.sqrt(distanceSquared));

    ax += dx * pull;
    ay += dy * pull;
    az += dz * pull;
  }

  return vec3(ax, ay, az);
}

/**
 * Gravitational potential at a point, km2/s2.
 *
 * Used for the field overlay's contour shading. Saturn's oblate terms are
 * included, because at the altitudes where the overlay is most useful — low
 * orbit, ring grazing — they are worth a tenth of a percent, which is enough to
 * bend the contours visibly out of round.
 */
export function potentialAt(
  point: Vec3,
  positions: Float64Array,
  gm: Float64Array,
  count: number,
  softening = 0,
): number {
  const dx0 = point.x - positions[0]!;
  const dy0 = point.y - positions[1]!;
  const dz0 = point.z - positions[2]!;
  const r0 = Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0 + softening * softening);
  if (r0 === 0) return -Infinity;

  // Point mass plus J2; the higher terms contribute less than the shading can
  // show and this is called once per pixel of the overlay.
  const u = dz0 / r0;
  const ratio2 = (60_330 * 60_330) / (r0 * r0);
  let potential = -(SATURN_GM / r0) * (1 - 1.629_056e-2 * ratio2 * (1.5 * u * u - 0.5));

  const softening2 = softening * softening;
  for (let i = 1; i < count; i++) {
    const bi = i * 3;
    const dx = point.x - positions[bi]!;
    const dy = point.y - positions[bi + 1]!;
    const dz = point.z - positions[bi + 2]!;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz + softening2);
    if (r > 0) potential -= gm[i]! / r;
  }

  return potential;
}

export interface Contribution {
  index: number;
  /** Acceleration this body alone imparts, km/s2. */
  magnitude: number;
  /** Unit vector from the point toward the body. */
  direction: Vec3;
  /** Share of the summed magnitudes, 0 to 1. */
  share: number;
}

/**
 * Every body's separate pull at a point, strongest first.
 *
 * The honest answer to "what is holding this ship up". Around Saturn it is
 * nearly always Saturn — but the interesting places are exactly the ones where
 * it is not, and the point of listing the pulls rather than the sum is to make
 * the crossing visible as the module approaches Titan.
 *
 * Saturn is reported at index 0 with its oblate field folded in, so its listed
 * pull is the real one rather than the point-mass idealisation.
 */
export function contributionsAt(
  point: Vec3,
  positions: Float64Array,
  gm: Float64Array,
  count: number,
): Contribution[] {
  const contributions: Contribution[] = [];

  const relative = vec3(
    point.x - positions[0]!,
    point.y - positions[1]!,
    point.z - positions[2]!,
  );
  const saturn = saturnAcceleration(relative);
  const saturnMagnitude = Math.hypot(saturn.x, saturn.y, saturn.z);
  if (saturnMagnitude > 0) {
    contributions.push({
      index: 0,
      magnitude: saturnMagnitude,
      direction: vec3(
        saturn.x / saturnMagnitude,
        saturn.y / saturnMagnitude,
        saturn.z / saturnMagnitude,
      ),
      share: 0,
    });
  }

  for (let i = 1; i < count; i++) {
    const bi = i * 3;
    const dx = positions[bi]! - point.x;
    const dy = positions[bi + 1]! - point.y;
    const dz = positions[bi + 2]! - point.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance === 0) continue;

    contributions.push({
      index: i,
      magnitude: gm[i]! / (distance * distance),
      direction: vec3(dx / distance, dy / distance, dz / distance),
      share: 0,
    });
  }

  contributions.sort((a, b) => b.magnitude - a.magnitude);

  const total = contributions.reduce((sum, entry) => sum + entry.magnitude, 0);
  for (const entry of contributions) entry.share = total === 0 ? 0 : entry.magnitude / total;

  return contributions;
}
