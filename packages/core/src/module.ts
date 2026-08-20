/**
 * The module: the one thing in the system the player controls.
 *
 * It is a point with a rocket on it. No attitude dynamics, no reaction wheels,
 * no time spent turning — a thrust command takes effect at once. That is a
 * deliberate simplification and not a small one, but the game this is is about
 * *where to burn and how much*, and slewing a spacecraft is a different game
 * that would sit on top of this one rather than inside it.
 *
 * The rocket equation is implemented in full — thrust costs mass, and the mass
 * loss feeds back into the acceleration within the same burn — but it is
 * currently switched off: `infinitePropellant` defaults to true while the
 * module's properties are not yet configurable. The machinery stays in place
 * rather than being deleted and rebuilt later, and the flag suppresses only the
 * consumption, never the physics.
 */

import { SATURN_GM } from './saturn.js';
import {
  ZERO,
  add,
  cross,
  dot,
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
  | 'aimed'
  | 'inertial';

/**
 * The orbital frame a thrust command is resolved in.
 *
 * Prograde along the velocity, normal along the angular momentum, radial
 * outward and completing the right-handed set. Shared by the six cardinal
 * thrust modes, by free aiming, and by manoeuvre nodes, so that "prograde"
 * means one thing everywhere in the package.
 *
 * Returns null where the frame is undefined — a radial fall has no orbit
 * normal — which callers must read as "do not thrust" rather than inventing a
 * direction out of rounding error.
 */
export function orbitalBasis(
  relativePosition: Vec3,
  relativeVelocity: Vec3,
): { prograde: Vec3; normal: Vec3; radial: Vec3 } | null {
  const speed = length(relativeVelocity);
  if (speed === 0 || length(relativePosition) === 0) return null;

  const prograde = scale(relativeVelocity, 1 / speed);
  const angularMomentum = cross(relativePosition, relativeVelocity);
  const h = length(angularMomentum);
  if (h === 0) return null;

  const normal = scale(angularMomentum, 1 / h);
  // Points away from the primary for a prograde orbit; checked by a test,
  // because a radial-out burn that fires inward still looks like an orbit.
  const radial = cross(prograde, normal);

  return { prograde, normal, radial };
}

/**
 * A thrust direction given as two angles in the orbital frame.
 *
 * `yaw` swings within the orbital plane, measured from prograde toward radial
 * out; `pitch` lifts out of the plane toward the normal. Both in radians.
 *
 * This is what lets the engine be pointed anywhere rather than at one of six
 * cardinal directions. The six remain because they are what a pilot wants
 * ninety per cent of the time and hitting exactly 0.000 degrees on a dial is
 * needless work — but a plane change at an arbitrary node, or a trim during a
 * rendezvous, needs the whole sphere.
 */
export function directionFromAngles(
  basis: { prograde: Vec3; normal: Vec3; radial: Vec3 },
  yaw: number,
  pitch: number,
): Vec3 {
  const inPlane = add(
    scale(basis.prograde, Math.cos(yaw)),
    scale(basis.radial, Math.sin(yaw)),
  );
  return add(scale(inPlane, Math.cos(pitch)), scale(basis.normal, Math.sin(pitch)));
}

/** The angles that would reproduce a direction in a given orbital frame. */
export function anglesFromDirection(
  basis: { prograde: Vec3; normal: Vec3; radial: Vec3 },
  direction: Vec3,
): { yaw: number; pitch: number } {
  const unit = normalize(direction);
  const alongNormal = Math.max(-1, Math.min(1, dot(unit, basis.normal)));
  return {
    pitch: Math.asin(alongNormal),
    yaw: Math.atan2(dot(unit, basis.radial), dot(unit, basis.prograde)),
  };
}

export interface ModuleSpec {
  /** Structure and payload, kg — everything that is not propellant. */
  dryMass: number;
  /** Maximum thrust, newtons. */
  maxThrust: number;
  /** Specific impulse, seconds. */
  specificImpulse: number;
}

/**
 * The stage, sized by the departure burn.
 *
 * Thrust is set by one requirement: a burn must be short against the orbit it
 * is made from. Leaving the starting orbit costs 9.8 km/s, and the orbit itself
 * lasts 4.25 hours. At 2 kN — the obvious "small module" figure, and what this
 * was first built with — that burn takes 2.9 hours, so the thrust vector swings
 * through most of a revolution and the majority of the velocity change is spent
 * pushing sideways. Apoapsis came out at 380 000 km instead of two million, and
 * nothing on screen explained why.
 *
 * 15 kN gives 7.1 m/s2 and brings the same burn down to 23 minutes, about a
 * twelfth of an orbit. That is short enough for the manoeuvre to behave roughly
 * as the impulsive plan says, and still long enough that the losses are visible
 * and that splitting a big burn across two periapsis passes measurably helps —
 * which is the lesson worth keeping.
 */
export const DEFAULT_SPEC: ModuleSpec = {
  dryMass: 1_200,
  maxThrust: 15_000,
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
  /** Aim for `aimed` mode: swing within the orbital plane, radians from prograde. */
  aimYaw: number;
  /** Aim for `aimed` mode: lift out of the plane toward the normal, radians. */
  aimPitch: number;
  /** Index of the body the thrust modes are resolved against. */
  referenceIndex: number;
  /**
   * Ignore the tanks entirely.
   *
   * On while the module's properties are not yet configurable, so that flying
   * the system can be learned without the rocket equation also being in the
   * way. Everything downstream still goes through the same code paths — the
   * flag suppresses the *consumption*, not the physics — so switching it off
   * later changes one boolean rather than a dozen call sites.
   */
  infinitePropellant: boolean;
}

export const createModule = (
  spec: ModuleSpec = DEFAULT_SPEC,
  propellant: number = DEFAULT_PROPELLANT,
  infinitePropellant = true,
): ModuleState => ({
  spec,
  propellant,
  throttle: 0,
  mode: 'prograde',
  inertialAim: vec3(1, 0, 0),
  aimYaw: 0,
  aimPitch: 0,
  referenceIndex: 0,
  infinitePropellant,
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
  state.infinitePropellant
    ? Infinity
    : state.spec.specificImpulse * G0 * Math.log(totalMass(state) / state.spec.dryMass);

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
  state: Pick<ModuleState, 'inertialAim' | 'aimYaw' | 'aimPitch'>,
  relativePosition: Vec3,
  relativeVelocity: Vec3,
): Vec3 {
  if (mode === 'inertial') return normalize(state.inertialAim);

  const basis = orbitalBasis(relativePosition, relativeVelocity);
  if (!basis) return ZERO;

  switch (mode) {
    case 'prograde':
      return basis.prograde;
    case 'retrograde':
      return scale(basis.prograde, -1);
    case 'radial-out':
      return basis.radial;
    case 'radial-in':
      return scale(basis.radial, -1);
    case 'normal':
      return basis.normal;
    case 'anti-normal':
      return scale(basis.normal, -1);
    case 'aimed':
      return directionFromAngles(basis, state.aimYaw, state.aimPitch);
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
  if (state.throttle <= 0) return ZERO;
  if (!state.infinitePropellant && state.propellant <= 0) return ZERO;

  const direction = thrustDirection(
    state.mode,
    state,
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
  if (state.infinitePropellant) return { state, spent: 0 };

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
