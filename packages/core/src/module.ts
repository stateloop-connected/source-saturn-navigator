/**
 * The module: the one thing in the system the player controls.
 *
 * It is a point with a rocket on it. No attitude dynamics, no reaction wheels,
 * no time spent turning — a thrust command takes effect at once. That is a
 * deliberate simplification and not a small one, but the game this is is about
 * *where to burn and how much*, and slewing a spacecraft is a different game
 * that would sit on top of this one rather than inside it.
 *
 * What is not simplified is the rocket equation. Propellant is finite, thrust
 * costs mass, and the mass loss feeds back into the acceleration within the
 * same burn. A player who spends their margin cannot get it back, which is what
 * makes a gravity assist worth planning instead of just thrusting harder.
 */

import { SATURN_GM } from './saturn.js';
import {
  ZERO,
  add,
  cross,
  length,
  normalize,
  scale,
  sub,
  vec3,
  type Vec3,
} from './vec.js';

/** Standard gravity, m/s2 — the constant in the definition of specific impulse. */
const G0 = 9.806_65;

/**
 * How a thrust command is aimed.
 *
 * All but `inertial` are resolved against a reference body, which is normally
 * whatever the player has selected. That matters: "prograde" near Titan means
 * something quite different depending on whether the frame is Titan's or
 * Saturn's, and the difference is the whole content of a capture burn.
 */
export type ThrustMode =
  | 'prograde'
  | 'retrograde'
  | 'radial-out'
  | 'radial-in'
  | 'normal'
  | 'anti-normal'
  | 'inertial';

export interface ModuleSpec {
  /** Structure and payload, kg — everything that is not propellant. */
  dryMass: number;
  /** Maximum thrust, newtons. */
  maxThrust: number;
  /** Specific impulse, seconds. */
  specificImpulse: number;
}

/**
 * A small chemical stage, sized so that the interesting manoeuvres are just
 * about affordable and the careless ones are not.
 *
 * 2 200 m/s of total budget is enough to leave a Titan orbit and reach
 * Enceladus with something in reserve, and nowhere near enough to fly the same
 * trip on brute force — which is the tension the game is made of. The thrust
 * figure gives about 0.9 m/s2 fully fuelled, so a large burn takes minutes and
 * cannot be treated as instantaneous.
 */
export const DEFAULT_SPEC: ModuleSpec = {
  dryMass: 1_200,
  maxThrust: 2_000,
  specificImpulse: 320,
};

export const DEFAULT_PROPELLANT = 900;

export interface ModuleState {
  spec: ModuleSpec;
  /** Remaining propellant, kg. */
  propellant: number;
  /** 0 to 1. */
  throttle: number;
  mode: ThrustMode;
  /** Aim for `inertial` mode; ignored otherwise. Need not be normalised. */
  inertialAim: Vec3;
  /** Index of the body the thrust modes are resolved against. */
  referenceIndex: number;
}

export const createModule = (
  spec: ModuleSpec = DEFAULT_SPEC,
  propellant: number = DEFAULT_PROPELLANT,
): ModuleState => ({
  spec,
  propellant,
  throttle: 0,
  mode: 'prograde',
  inertialAim: vec3(1, 0, 0),
  referenceIndex: 0,
});

export const totalMass = (state: ModuleState): number =>
  state.spec.dryMass + state.propellant;

/**
 * Remaining velocity budget, m/s — Tsiolkovsky.
 *
 * The single most important number on the display, and the one players learn to
 * read first: not how much fuel is left, but how much *change* is left, which
 * is what a trajectory is bought with.
 */
export const deltaVRemaining = (state: ModuleState): number =>
  state.spec.specificImpulse *
  G0 *
  Math.log(totalMass(state) / state.spec.dryMass);

/** Propellant burnt per second at the current throttle, kg/s. */
export const massFlowRate = (state: ModuleState): number =>
  (state.throttle * state.spec.maxThrust) / (state.spec.specificImpulse * G0);

/**
 * The direction a thrust command points, in the simulation frame.
 *
 * Returns a unit vector, or zero where the mode is undefined — `normal` has no
 * meaning on a perfectly radial trajectory, and a zero vector is a better
 * answer there than a direction invented from rounding error.
 */
export function thrustDirection(
  mode: ThrustMode,
  inertialAim: Vec3,
  relativePosition: Vec3,
  relativeVelocity: Vec3,
): Vec3 {
  switch (mode) {
    case 'prograde':
      return normalize(relativeVelocity);
    case 'retrograde':
      return scale(normalize(relativeVelocity), -1);
    case 'radial-out':
      return normalize(relativePosition);
    case 'radial-in':
      return scale(normalize(relativePosition), -1);
    case 'normal':
      return normalize(cross(relativePosition, relativeVelocity));
    case 'anti-normal':
      return scale(normalize(cross(relativePosition, relativeVelocity)), -1);
    case 'inertial':
      return normalize(inertialAim);
  }
}

/**
 * Thrust acceleration in the simulation frame, km/s2.
 *
 * Zero once the tanks are dry, whatever the throttle says — a detail worth
 * being strict about, because the alternative is a player coasting on a burn
 * that ran out three minutes ago and wondering why the prediction disagrees
 * with the ship.
 */
export function thrustAcceleration(
  state: ModuleState,
  relativePosition: Vec3,
  relativeVelocity: Vec3,
): Vec3 {
  if (state.propellant <= 0 || state.throttle <= 0) return ZERO;

  const direction = thrustDirection(
    state.mode,
    state.inertialAim,
    relativePosition,
    relativeVelocity,
  );
  if (length(direction) === 0) return ZERO;

  // N / kg gives m/s2; the simulation works in km.
  const acceleration =
    (state.throttle * state.spec.maxThrust) / totalMass(state) / 1000;
  return scale(direction, acceleration);
}

/**
 * Burn propellant for `seconds`, returning the updated state.
 *
 * Clamps at empty rather than going negative, and reports how much was actually
 * spent so that the caller can tell a burn was cut short.
 */
export function consumePropellant(
  state: ModuleState,
  seconds: number,
): { state: ModuleState; spent: number } {
  const wanted = massFlowRate(state) * seconds;
  const spent = Math.min(wanted, state.propellant);
  return { state: { ...state, propellant: state.propellant - spent }, spent };
}

export interface NavigationReadout {
  /** Speed relative to the reference body, km/s. */
  speed: number;
  /** Distance to the reference body's centre, km. */
  distance: number;
  /** Distance above the reference body's surface, km. */
  altitude: number;
  /** Rate of change of distance, km/s. Negative is closing. */
  radialRate: number;
  /** Magnitude of the local gravitational acceleration, m/s2. */
  gravity: number;
}

/**
 * The numbers a pilot flies on, relative to one body.
 *
 * Altitude rather than distance, because "62 000 km from Saturn" is a fact
 * about the map and "1 700 km above the cloud tops" is a fact about whether you
 * are about to die.
 */
export function navigationReadout(
  position: Vec3,
  velocity: Vec3,
  bodyPosition: Vec3,
  bodyVelocity: Vec3,
  bodyRadius: number,
  gravity: Vec3,
): NavigationReadout {
  const relativePosition = sub(position, bodyPosition);
  const relativeVelocity = sub(velocity, bodyVelocity);
  const distance = length(relativePosition);

  return {
    speed: length(relativeVelocity),
    distance,
    altitude: distance - bodyRadius,
    radialRate:
      distance === 0
        ? 0
        : (relativePosition.x * relativeVelocity.x +
            relativePosition.y * relativeVelocity.y +
            relativePosition.z * relativeVelocity.z) /
          distance,
    gravity: length(gravity) * 1000,
  };
}

/**
 * The velocity change needed to circularise at the current altitude, m/s.
 *
 * Offered as a hint rather than as an autopilot: it tells the player what the
 * manoeuvre costs, and leaves finding the right moment to them.
 */
export function circulariseCost(
  relativePosition: Vec3,
  relativeVelocity: Vec3,
  gm: number = SATURN_GM,
): number {
  const r = length(relativePosition);
  if (r === 0) return 0;
  const circular = scale(
    normalize(cross(cross(relativePosition, relativeVelocity), relativePosition)),
    Math.sqrt(gm / r),
  );
  return length(sub(circular, relativeVelocity)) * 1000;
}

/** Sum of two velocity changes, for showing a plan's total cost. */
export const combineBurns = (a: Vec3, b: Vec3): Vec3 => add(a, b);
