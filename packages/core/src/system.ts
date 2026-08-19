/**
 * The simulation: state, seeding, and the integrator that moves it.
 *
 * ## Why a symplectic scheme
 *
 * The game runs at time warps of up to a million, so a session can cover years
 * of simulated time in an afternoon. Any integrator that leaks energy shows it:
 * moons spiral, orbits open out, and the system the player learned stops being
 * the system they are flying in. A symplectic composition does not conserve
 * energy exactly either, but its error *oscillates* instead of accumulating —
 * bounded forever, at the cost of three force evaluations per step instead of
 * one.
 *
 * The composition is Yoshida's fourth order: three velocity-Verlet sub-steps
 * whose lengths are tuned so the leading error term cancels. The middle one runs
 * backwards, which is what makes the cancellation work. Against plain Verlet at
 * the same step it costs about 1.5x and buys four orders of magnitude.
 *
 * ## Why the module is not in the state array
 *
 * The module is massless — a tonne against Mimas's 3.7e19 kg is 26 orders of
 * magnitude down — so it does not perturb anything. Keeping it out of the
 * mutual-gravity arrays means the moons' motion is completely independent of
 * what the player does, and *that* is what makes the trajectory predictor
 * possible: fork the state once, then fly as many candidate courses through it
 * as you like without any of them disturbing the others.
 */

import {
  osculatingElements,
  stateFromElements,
  type OrbitSummary,
} from './elements.js';
import { computeAccelerations, gravityAt } from './forces.js';
import { MOONS, type Moon } from './moons.js';
import { SATURN_GM, eclipticToSaturn, saturnPotential } from './saturn.js';
import { sub, vec3, type Vec3 } from './vec.js';

/**
 * Default integration step, seconds.
 *
 * Set by Pan, the innermost moon, whose period is 49 680 s: 60 s gives it 828
 * steps per orbit, which is far more than a fourth-order scheme needs and
 * leaves room for the module to fly a low pass over the rings without the step
 * having to change underneath it. The cost is 1 440 steps per simulated day,
 * which at 4 500 pair evaluations each is comfortably inside a frame budget
 * even at high warp.
 */
export const DEFAULT_STEP = 60;

const CUBE_ROOT_TWO = Math.cbrt(2);
const OUTER_WEIGHT = 1 / (2 - CUBE_ROOT_TWO);
const INNER_WEIGHT = -CUBE_ROOT_TWO / (2 - CUBE_ROOT_TWO);

/** Index 0 is Saturn; moon `k` of the catalogue is index `k + 1`. */
export const SATURN_INDEX = 0;
export const indexOfMoon = (moonIndex: number): number => moonIndex + 1;

export interface Probe {
  /** Position and velocity in the barycentric frame, km and km/s. */
  position: Vec3;
  velocity: Vec3;
  /**
   * Thrust acceleration, km/s2, in the barycentric frame. Held constant across
   * a step; the game re-resolves it from the player's controls each frame.
   */
  thrust: Vec3;
}

export interface SystemSnapshot {
  time: number;
  positions: Float64Array;
  velocities: Float64Array;
}

/**
 * Saturn and its moons, integrated together, plus any number of massless
 * probes riding in the field.
 */
export class SaturnSystem {
  readonly count: number;
  readonly gm: Float64Array;
  /** Catalogue entry for each index; null at index 0, which is Saturn. */
  readonly bodies: readonly (Moon | null)[];

  positions: Float64Array;
  velocities: Float64Array;
  private accelerations: Float64Array;

  /** Massless riders. Index 0 is the player's module by convention. */
  probes: Probe[] = [];

  time: number;
  readonly step: number;

  constructor(time = 0, step: number = DEFAULT_STEP, moons: readonly Moon[] = MOONS) {
    this.count = moons.length + 1;
    this.step = step;
    this.time = time;

    this.gm = new Float64Array(this.count);
    this.gm[0] = SATURN_GM;

    const bodies: (Moon | null)[] = [null];
    for (let k = 0; k < moons.length; k++) {
      this.gm[k + 1] = moons[k]!.gm;
      bodies.push(moons[k]!);
    }
    this.bodies = bodies;

    this.positions = new Float64Array(this.count * 3);
    this.velocities = new Float64Array(this.count * 3);
    this.accelerations = new Float64Array(this.count * 3);

    this.seed(moons);
    computeAccelerations(this.positions, this.gm, this.count, this.accelerations);
  }

  /**
   * Turn the catalogue into state vectors.
   *
   * Three things happen that the catalogue cannot express on its own.
   *
   * Elements quoted against the ecliptic — every irregular moon — are rotated
   * into the working frame. Do this wrong and Phoebe's orbit sits 28 degrees
   * out of place, which is the single largest error the seeding could make.
   *
   * Co-orbitals are resolved against their anchor, in a second pass so that the
   * anchor's own longitude is already known. Where `matchAxis` is set the
   * trojan takes its parent's semi-major axis exactly: two bodies at a Lagrange
   * point must share a period, and 40 km of difference in `a` is enough to
   * unstick them within a few years.
   *
   * Finally the whole system is shifted into its barycentre. Seeding with
   * Saturn at rest would leave the system carrying Titan's momentum, and the
   * entire thing would drift off the map over a long session.
   */
  private seed(moons: readonly Moon[]): void {
    const longitudes = new Map<string, number>();
    for (const moon of moons) longitudes.set(moon.id, moon.elements.meanLongitude);

    for (const moon of moons) {
      if (!moon.coorbital) continue;
      const anchor = longitudes.get(moon.coorbital.with);
      if (anchor === undefined) continue;
      longitudes.set(moon.id, anchor + moon.coorbital.offsetDeg);
    }

    for (let k = 0; k < moons.length; k++) {
      const moon = moons[k]!;
      const elements = moon.elements;

      let a = elements.a;
      if (moon.coorbital?.matchAxis) {
        const parent = moons.find((other) => other.id === moon.coorbital!.with);
        if (parent) a = parent.elements.a;
      }

      const state = stateFromElements(
        {
          a,
          e: elements.e,
          i: elements.i,
          node: elements.node,
          peri: elements.peri,
          meanLongitude: longitudes.get(moon.id) ?? elements.meanLongitude,
        },
        SATURN_GM + moon.gm,
      );

      const position =
        elements.frame === 'ecliptic' ? eclipticToSaturn(state.position) : state.position;
      const velocity =
        elements.frame === 'ecliptic' ? eclipticToSaturn(state.velocity) : state.velocity;

      const base = (k + 1) * 3;
      this.positions[base] = position.x;
      this.positions[base + 1] = position.y;
      this.positions[base + 2] = position.z;
      this.velocities[base] = velocity.x;
      this.velocities[base + 1] = velocity.y;
      this.velocities[base + 2] = velocity.z;
    }

    this.shiftToBarycentre();
  }

  private shiftToBarycentre(): void {
    let totalGm = 0;
    let cx = 0, cy = 0, cz = 0;
    let vx = 0, vy = 0, vz = 0;

    for (let i = 0; i < this.count; i++) {
      const base = i * 3;
      const weight = this.gm[i]!;
      totalGm += weight;
      cx += weight * this.positions[base]!;
      cy += weight * this.positions[base + 1]!;
      cz += weight * this.positions[base + 2]!;
      vx += weight * this.velocities[base]!;
      vy += weight * this.velocities[base + 1]!;
      vz += weight * this.velocities[base + 2]!;
    }

    cx /= totalGm; cy /= totalGm; cz /= totalGm;
    vx /= totalGm; vy /= totalGm; vz /= totalGm;

    for (let i = 0; i < this.count; i++) {
      const base = i * 3;
      this.positions[base] = this.positions[base]! - cx;
      this.positions[base + 1] = this.positions[base + 1]! - cy;
      this.positions[base + 2] = this.positions[base + 2]! - cz;
      this.velocities[base] = this.velocities[base]! - vx;
      this.velocities[base + 1] = this.velocities[base + 1]! - vy;
      this.velocities[base + 2] = this.velocities[base + 2]! - vz;
    }
  }

  /**
   * One velocity-Verlet sub-step, over bodies and probes alike.
   *
   * The probes are advanced inside the same sub-step rather than in a pass of
   * their own, so a probe always sees the field at the position the bodies
   * actually occupy at that instant. Advancing them afterwards against the
   * final positions would drop the scheme to first order for the one trajectory
   * the player most cares about.
   */
  private verletSubStep(dt: number): void {
    const half = 0.5 * dt;
    const { positions, velocities, accelerations, probes } = this;

    /*
     * A probe's acceleration has to be sampled at the *old* body positions,
     * before the loop below moves them. Sampling it afterwards would mix states
     * from either side of the step and quietly drop the scheme to first order
     * for the one trajectory the player cares most about — and it would do so
     * invisibly, since the path would still look like an orbit.
     */
    const probeAccelerations = probes.map((probe) => {
      const g = gravityAt(probe.position, positions, this.gm, this.count);
      return vec3(g.x + probe.thrust.x, g.y + probe.thrust.y, g.z + probe.thrust.z);
    });

    for (let k = 0; k < positions.length; k++) {
      positions[k] = positions[k]! + velocities[k]! * dt + accelerations[k]! * half * dt;
      velocities[k] = velocities[k]! + accelerations[k]! * half;
    }

    for (let p = 0; p < probes.length; p++) {
      const probe = probes[p]!;
      const a = probeAccelerations[p]!;
      probe.position = vec3(
        probe.position.x + probe.velocity.x * dt + a.x * half * dt,
        probe.position.y + probe.velocity.y * dt + a.y * half * dt,
        probe.position.z + probe.velocity.z * dt + a.z * half * dt,
      );
      probe.velocity = vec3(
        probe.velocity.x + a.x * half,
        probe.velocity.y + a.y * half,
        probe.velocity.z + a.z * half,
      );
    }

    computeAccelerations(positions, this.gm, this.count, accelerations);

    for (let k = 0; k < velocities.length; k++) {
      velocities[k] = velocities[k]! + accelerations[k]! * half;
    }

    for (const probe of probes) {
      const g = gravityAt(probe.position, positions, this.gm, this.count);
      probe.velocity = vec3(
        probe.velocity.x + (g.x + probe.thrust.x) * half,
        probe.velocity.y + (g.y + probe.thrust.y) * half,
        probe.velocity.z + (g.z + probe.thrust.z) * half,
      );
    }
  }

  /** Advance by one full step of the configured size, or by `dt` if given. */
  stepOnce(dt: number = this.step): void {
    this.verletSubStep(OUTER_WEIGHT * dt);
    this.verletSubStep(INNER_WEIGHT * dt);
    this.verletSubStep(OUTER_WEIGHT * dt);
    this.time += dt;
  }

  /**
   * Advance by `seconds`, in whole steps plus a short remainder.
   *
   * Returns the number of steps taken, which the game uses to notice that a
   * warp setting is costing more than a frame can afford. Verlet is
   * time-reversible, so a negative duration simply runs the same machinery
   * backwards.
   */
  advance(seconds: number): number {
    if (seconds === 0) return 0;
    const direction = seconds < 0 ? -1 : 1;
    let remaining = Math.abs(seconds);
    let steps = 0;

    while (remaining > 1e-9) {
      const dt = Math.min(this.step, remaining);
      this.stepOnce(dt * direction);
      remaining -= dt;
      steps++;
    }
    return steps;
  }

  /** Position of a body in the barycentric frame, km. */
  positionOf(index: number): Vec3 {
    const base = index * 3;
    return vec3(this.positions[base]!, this.positions[base + 1]!, this.positions[base + 2]!);
  }

  velocityOf(index: number): Vec3 {
    const base = index * 3;
    return vec3(
      this.velocities[base]!,
      this.velocities[base + 1]!,
      this.velocities[base + 2]!,
    );
  }

  /** Position relative to Saturn — the frame everything is displayed in. */
  saturnCentred(index: number): Vec3 {
    return sub(this.positionOf(index), this.positionOf(SATURN_INDEX));
  }

  indexOf(moonId: string): number {
    for (let i = 1; i < this.count; i++) {
      if (this.bodies[i]?.id === moonId) return i;
    }
    return -1;
  }

  /** The osculating orbit of a body about Saturn. */
  orbitOf(index: number): OrbitSummary {
    const moon = this.bodies[index];
    return osculatingElements(
      this.saturnCentred(index),
      sub(this.velocityOf(index), this.velocityOf(SATURN_INDEX)),
      SATURN_GM + (moon?.gm ?? 0),
    );
  }

  /** The osculating orbit of a probe about Saturn, or about any other body. */
  orbitOfProbe(probe: Probe, aboutIndex: number = SATURN_INDEX): OrbitSummary {
    const centreGm =
      aboutIndex === SATURN_INDEX ? SATURN_GM : this.bodies[aboutIndex]?.gm ?? SATURN_GM;
    return osculatingElements(
      sub(probe.position, this.positionOf(aboutIndex)),
      sub(probe.velocity, this.velocityOf(aboutIndex)),
      centreGm,
    );
  }

  /**
   * Total energy of the massive bodies, in GM units.
   *
   * Not a physical energy — the masses are GMs, so it is off by a factor of G —
   * but it is *constant*, and that is all it is for. Watching it stay put over a
   * long run is the cheapest available proof that a session has not gone
   * numerically bad, and the symplectic scheme's promise is precisely that this
   * number oscillates rather than drifts.
   *
   * Saturn's oblate terms are included. Leaving them out would be much simpler
   * and would ruin the diagnostic: the J2 term is a part in sixty of Mimas's
   * potential, so the quantity would appear to swing by far more than any
   * integration error, and the check would no longer be able to see anything.
   */
  totalEnergy(): number {
    let kinetic = 0;
    let potential = 0;

    for (let i = 0; i < this.count; i++) {
      const base = i * 3;
      const speedSquared =
        this.velocities[base]! ** 2 +
        this.velocities[base + 1]! ** 2 +
        this.velocities[base + 2]! ** 2;
      kinetic += 0.5 * this.gm[i]! * speedSquared;

      // Moon-moon pairs are plain point masses.
      for (let j = Math.max(i + 1, 1); j < this.count; j++) {
        if (i === SATURN_INDEX) continue;
        const other = j * 3;
        const dx = this.positions[other]! - this.positions[base]!;
        const dy = this.positions[other + 1]! - this.positions[base + 1]!;
        const dz = this.positions[other + 2]! - this.positions[base + 2]!;
        potential -= (this.gm[i]! * this.gm[j]!) / Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }

    // Saturn's pairs carry the harmonics, so they go through the full potential.
    for (let i = 1; i < this.count; i++) {
      potential += this.gm[i]! * saturnPotential(this.saturnCentred(i));
    }

    return kinetic + potential;
  }

  /** A copy of the body state, cheap enough to take every frame if needed. */
  snapshot(): SystemSnapshot {
    return {
      time: this.time,
      positions: this.positions.slice(),
      velocities: this.velocities.slice(),
    };
  }

  restore(snapshot: SystemSnapshot): void {
    this.positions.set(snapshot.positions);
    this.velocities.set(snapshot.velocities);
    this.time = snapshot.time;
    computeAccelerations(this.positions, this.gm, this.count, this.accelerations);
  }

  /**
   * An independent copy, for running ahead of the live simulation.
   *
   * The predictor's whole method: take the state as it stands, hand it to a
   * worker, and let the worker fly it forward without touching what the player
   * is looking at. Probes are not copied — the caller adds the ones it wants to
   * fly.
   */
  fork(step: number = this.step): SaturnSystem {
    const copy = new SaturnSystem(this.time, step, this.bodies.slice(1) as Moon[]);
    copy.positions.set(this.positions);
    copy.velocities.set(this.velocities);
    copy.time = this.time;
    computeAccelerations(copy.positions, copy.gm, copy.count, copy.accelerations);
    return copy;
  }
}
