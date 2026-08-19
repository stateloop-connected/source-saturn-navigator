/**
 * The gravity field, sampled over a patch of space so it can be drawn.
 *
 * The overlay exists because the field is the thing the game is actually about
 * and it is completely invisible. A player can see Titan and can see their own
 * orbit, but the reason the orbit bends the way it does is a vector field they
 * have no access to. Drawing it turns "the trajectory did something strange"
 * into "of course it did, look".
 *
 * Three ways of showing it, because the raw field is nearly useless close up.
 *
 * **Absolute** is the honest one: the acceleration a free particle feels. Its
 * problem is that Saturn dominates everywhere the player can reach — at Titan's
 * distance Saturn still out-pulls Titan by 25 to 1 until you are within 50 000
 * km of it — so an absolute field around any moon is a set of parallel arrows
 * pointing at Saturn, and shows nothing.
 *
 * **Relative** subtracts the acceleration of the reference body itself. What is
 * left is the tidal field — the part that actually does something *to* an orbit
 * around that body, since the rest of it moves body and module alike. This is
 * the one that makes a Hill sphere visible as a region rather than a number.
 *
 * **Rotating** adds the centrifugal term of a frame turning with the reference
 * body. Its stationary points are the Lagrange points, so this is the view in
 * which Telesto and Calypso stop looking like a coincidence and Janus and
 * Epimetheus stop looking like an accident waiting to happen.
 */

import { contributionsAt, gravityAt, potentialAt } from './forces.js';
import { SATURN_INDEX, type SaturnSystem } from './system.js';
import {
  add,
  basisFrom,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
  type Vec3,
} from './vec.js';

export type FieldMode = 'absolute' | 'relative' | 'rotating';

export interface FieldRegion {
  /** Centre of the sampled patch, in the Saturn-centred display frame, km. */
  centre: Vec3;
  /** Half-width of the patch, km. The patch is square. */
  halfWidth: number;
  /** Samples per side. The grid is `resolution` x `resolution`. */
  resolution: number;
  /**
   * In-plane axes. Default to the ring plane, which is where nearly everything
   * happens; a player who tilts the camera can ask for the view plane instead.
   */
  u?: Vec3;
  v?: Vec3;
  mode: FieldMode;
  /** Body the relative and rotating modes are measured against. */
  referenceIndex: number;
}

export interface FieldSample {
  /** Position in the display frame, km. */
  position: Vec3;
  /** Acceleration in the chosen mode, km/s2. */
  acceleration: Vec3;
  /** Its magnitude, m/s2 — the unit the readout uses. */
  magnitude: number;
  /** Effective potential, km2/s2. Includes the centrifugal term when rotating. */
  potential: number;
  /** True where the sample fell inside a body, and the value is meaningless. */
  inside: boolean;
}

export interface FieldGrid {
  region: FieldRegion;
  resolution: number;
  samples: FieldSample[];
  /** Smallest and largest finite magnitude in the grid, m/s2, for scaling. */
  minMagnitude: number;
  maxMagnitude: number;
  /** Unit axes actually used, so the renderer can lay the grid out. */
  u: Vec3;
  v: Vec3;
}

/**
 * Angular velocity of the reference body about Saturn, rad/s, as a vector along
 * the orbit normal.
 *
 * Zero for Saturn itself, which has nothing to orbit — asking for a rotating
 * frame centred on Saturn is a reasonable thing to do by accident, and the
 * right answer is simply to give back the absolute field rather than divide by
 * zero.
 */
function angularVelocity(system: SaturnSystem, index: number): Vec3 {
  if (index === SATURN_INDEX) return vec3(0, 0, 0);
  const r = system.saturnCentred(index);
  const v = sub(system.velocityOf(index), system.velocityOf(SATURN_INDEX));
  const r2 = dot(r, r);
  if (r2 === 0) return vec3(0, 0, 0);
  return scale(cross(r, v), 1 / r2);
}

/**
 * Is this point inside a body? Used to blank samples rather than draw an arrow
 * of 10^6 m/s2 that swamps the colour scale for everything else.
 */
function insideBody(system: SaturnSystem, displayPoint: Vec3): boolean {
  for (let i = 0; i < system.count; i++) {
    const radius = i === SATURN_INDEX ? 60_268 : system.bodies[i]?.radius ?? 0;
    if (length(sub(displayPoint, system.saturnCentred(i))) < radius) return true;
  }
  return false;
}

/**
 * Sample the field over a square patch.
 *
 * Positions come in and go out in the Saturn-centred display frame, because
 * that is the frame the player picked the patch in; internally everything is
 * shifted into the barycentric frame the forces are defined in.
 */
export function sampleField(system: SaturnSystem, region: FieldRegion): FieldGrid {
  const resolution = Math.max(2, Math.floor(region.resolution));

  // Default to the ring plane. `basisFrom` is only reached if the caller asks
  // for a plane by giving one axis and not the other.
  let u = region.u ? normalize(region.u) : vec3(1, 0, 0);
  let v = region.v ? normalize(region.v) : vec3(0, 1, 0);
  if (region.u && !region.v) {
    const [, second, third] = basisFrom(region.u);
    u = second;
    v = third;
  }

  const saturn = system.positionOf(SATURN_INDEX);
  const referenceIndex = region.referenceIndex;

  // The acceleration of the reference body itself, which `relative` removes.
  const referenceAcceleration =
    region.mode === 'absolute'
      ? vec3(0, 0, 0)
      : gravityAt(
          system.positionOf(referenceIndex),
          system.positions,
          system.gm,
          system.count,
        );

  const omega = region.mode === 'rotating' ? angularVelocity(system, referenceIndex) : vec3(0, 0, 0);
  const omegaSquared = dot(omega, omega);

  // Softening at one metre: only ever reached inside a body, where the sample
  // is blanked anyway, and it keeps the arithmetic finite in the meantime.
  const SOFTENING = 1e-3;

  const samples: FieldSample[] = [];
  let minMagnitude = Infinity;
  let maxMagnitude = 0;

  for (let row = 0; row < resolution; row++) {
    for (let column = 0; column < resolution; column++) {
      const su = ((column / (resolution - 1)) * 2 - 1) * region.halfWidth;
      const sv = ((row / (resolution - 1)) * 2 - 1) * region.halfWidth;

      const displayPoint = add(region.centre, add(scale(u, su), scale(v, sv)));
      const worldPoint = add(displayPoint, saturn);

      let acceleration = gravityAt(
        worldPoint,
        system.positions,
        system.gm,
        system.count,
        SOFTENING,
      );
      let potential = potentialAt(
        worldPoint,
        system.positions,
        system.gm,
        system.count,
        SOFTENING,
      );

      if (region.mode !== 'absolute') {
        acceleration = sub(acceleration, referenceAcceleration);
      }

      if (region.mode === 'rotating' && omegaSquared > 0) {
        // Centrifugal: -omega x (omega x r), with r measured from the axis
        // through Saturn. Adding it is what makes the Lagrange points appear as
        // stationary points of the potential.
        const r = sub(worldPoint, saturn);
        const centrifugal = scale(sub(r, scale(omega, dot(r, omega) / omegaSquared)), omegaSquared);
        acceleration = add(acceleration, centrifugal);

        const perpendicular = length(sub(r, scale(omega, dot(r, omega) / omegaSquared)));
        potential -= 0.5 * omegaSquared * perpendicular * perpendicular;
      }

      const inside = insideBody(system, displayPoint);
      const magnitude = length(acceleration) * 1000;
      if (!inside) {
        if (magnitude < minMagnitude) minMagnitude = magnitude;
        if (magnitude > maxMagnitude) maxMagnitude = magnitude;
      }

      samples.push({ position: displayPoint, acceleration, magnitude, potential, inside });
    }
  }

  return {
    region,
    resolution,
    samples,
    minMagnitude: Number.isFinite(minMagnitude) ? minMagnitude : 0,
    maxMagnitude,
    u,
    v,
  };
}

export interface FieldProbe {
  /** Acceleration at the point, m/s2. */
  magnitude: number;
  direction: Vec3;
  /** Which bodies are responsible, strongest first. */
  contributions: { id: string; magnitude: number; share: number }[];
  /** The body whose pull is strongest here. */
  dominant: string;
}

/**
 * The field at a single point, with an account of what makes it.
 *
 * The readout behind the overlay: hovering anywhere should answer "how hard,
 * which way, and whose". The last part is the one that teaches — the moment
 * the dominant name flips from Saturn to Titan is the moment the module has
 * entered Titan's sphere of influence, and seeing that happen is worth more
 * than being told the radius.
 */
export function probeField(system: SaturnSystem, displayPoint: Vec3): FieldProbe {
  const worldPoint = add(displayPoint, system.positionOf(SATURN_INDEX));
  const contributions = contributionsAt(
    worldPoint,
    system.positions,
    system.gm,
    system.count,
  );
  const total = gravityAt(worldPoint, system.positions, system.gm, system.count, 1e-3);

  const named = contributions.slice(0, 6).map((entry) => ({
    id: entry.index === SATURN_INDEX ? 'saturn' : system.bodies[entry.index]?.id ?? '?',
    magnitude: entry.magnitude * 1000,
    share: entry.share,
  }));

  return {
    magnitude: length(total) * 1000,
    direction: normalize(total),
    contributions: named,
    dominant: named[0]?.id ?? 'saturn',
  };
}
