/**
 * Transfers between two orbits, and — the part that actually matters — *when*.
 *
 * The Δv for a Hohmann transfer is textbook and takes four lines. The reason
 * this module exists is the other half of the problem: a transfer arrives at a
 * radius, and the thing you were aiming at has to be there when you turn up.
 *
 * Getting to Titan's orbit costs 3.6 km/s from Rhea and is easy. Getting to
 * *Titan* means leaving at the one moment in each synodic period when Titan is
 * far enough behind that it arrives at the meeting point exactly as you do —
 * and if you leave at the wrong time you spend the same 3.6 km/s and reach an
 * empty piece of space. That window is what a departure is planned around, and
 * it is the number this module is for.
 *
 * ## What is assumed
 *
 * Circular, coplanar orbits. Neither is quite true here: Titan's eccentricity
 * is 0.029 and Iapetus is inclined 15 degrees. So these figures are a *plan*,
 * accurate to a few per cent, and the trajectory predictor is what tells the
 * truth afterwards. That division is deliberate — a planner that took an hour
 * to answer would not be a planner, and one that pretended to be exact would
 * be worse than one that says what it is.
 *
 * The plane change is reported separately rather than folded in, because it is
 * the one term a player can often avoid entirely by burning at a node.
 */

import { SATURN_GM } from './saturn.js';
import { TAU, wrapRad } from './vec.js';

export interface TransferInputs {
  /** Radius of the departure orbit, km. */
  fromRadius: number;
  /** Radius of the arrival orbit, km. */
  toRadius: number;
  /**
   * Where each body is now, radians, measured the same way round the primary.
   * Only the difference matters, so any consistent origin will do.
   */
  fromAngle: number;
  toAngle: number;
  /** Inclinations, radians. Used only for the plane-change estimate. */
  fromInclination?: number;
  toInclination?: number;
  gm?: number;
}

export interface TransferSolution {
  fromRadius: number;
  toRadius: number;
  /** Semi-major axis of the transfer ellipse, km. */
  transferAxis: number;
  /** Burn at departure, m/s. Positive is prograde. */
  departureDeltaV: number;
  /** Burn on arrival, m/s. Positive is prograde. */
  arrivalDeltaV: number;
  /** Both burns added as magnitudes, m/s. Excludes any plane change. */
  totalDeltaV: number;
  /** Extra cost to match the target's plane, m/s. Zero when coplanar. */
  planeChangeDeltaV: number;
  /** Coast from departure to arrival, seconds. Half the transfer period. */
  flightTime: number;
  /**
   * How far ahead the target must be at departure, radians.
   *
   * Negative means it should be *behind* — which is the usual case when
   * transferring outward, because the target moves slower than the chaser and
   * the chaser spends the whole flight catching up in angle.
   */
  requiredPhase: number;
  /** How far ahead the target is now, radians, wrapped to (-pi, pi]. */
  currentPhase: number;
  /** Time until the phase condition is next met, seconds. */
  timeToWindow: number;
  /** How often the window comes round, seconds. */
  synodicPeriod: number;
  /** True when the two orbits are so close that no window is meaningful. */
  degenerate: boolean;
}

/** Mean motion of a circular orbit, rad/s. */
const meanMotion = (radius: number, gm: number): number =>
  Math.sqrt(gm / (radius * radius * radius));

/** Wrap an angle into (-pi, pi]. */
function wrapSigned(angle: number): number {
  const wrapped = wrapRad(angle);
  return wrapped > Math.PI ? wrapped - TAU : wrapped;
}

/**
 * Plan a Hohmann transfer, with its departure window.
 *
 * The phase condition is the classical one. Over the flight the target sweeps
 * `n2 * t` radians while the chaser sweeps exactly pi, so for the two to meet
 * the target must start `pi - n2 * t` ahead. The window then recurs at the
 * synodic period, which is how long the two take to gain a full turn on each
 * other.
 */
export function planTransfer(inputs: TransferInputs): TransferSolution {
  const gm = inputs.gm ?? SATURN_GM;
  const r1 = inputs.fromRadius;
  const r2 = inputs.toRadius;

  const transferAxis = (r1 + r2) / 2;
  const flightTime = Math.PI * Math.sqrt(transferAxis ** 3 / gm);

  const circular1 = Math.sqrt(gm / r1);
  const circular2 = Math.sqrt(gm / r2);
  const atDeparture = Math.sqrt(gm * (2 / r1 - 1 / transferAxis));
  const atArrival = Math.sqrt(gm * (2 / r2 - 1 / transferAxis));

  const departureDeltaV = (atDeparture - circular1) * 1000;
  const arrivalDeltaV = (circular2 - atArrival) * 1000;

  /*
   * Plane change, costed where it is cheapest: at the slow end.
   *
   * Turning a velocity vector by an angle costs 2 v sin(delta/2), so the same
   * turn is far cheaper at apoapsis of the transfer than at periapsis. For an
   * outward transfer that is the arrival, and combining it with the
   * circularisation burn there is what a real mission does.
   */
  const inclinationChange = Math.abs(
    (inputs.toInclination ?? 0) - (inputs.fromInclination ?? 0),
  );
  const slowest = Math.min(atArrival, atDeparture);
  const planeChangeDeltaV =
    inclinationChange === 0 ? 0 : 2 * slowest * Math.sin(inclinationChange / 2) * 1000;

  const n1 = meanMotion(r1, gm);
  const n2 = meanMotion(r2, gm);

  const requiredPhase = wrapSigned(Math.PI - n2 * flightTime);
  const currentPhase = wrapSigned(inputs.toAngle - inputs.fromAngle);

  /*
   * When the phase condition next holds.
   *
   * The target's lead changes at the relative rate n2 - n1, so the wait is the
   * angle still to be made up divided by that rate. Wrapping into a full turn
   * before dividing is what makes the answer the *next* window rather than a
   * negative time or one several periods away.
   */
  const relativeRate = n2 - n1;
  const degenerate = Math.abs(relativeRate) < 1e-12;

  let timeToWindow = 0;
  if (!degenerate) {
    const toMakeUp = wrapRad((requiredPhase - currentPhase) * Math.sign(relativeRate));
    timeToWindow = toMakeUp / Math.abs(relativeRate);
  }

  return {
    fromRadius: r1,
    toRadius: r2,
    transferAxis,
    departureDeltaV,
    arrivalDeltaV,
    totalDeltaV: Math.abs(departureDeltaV) + Math.abs(arrivalDeltaV),
    planeChangeDeltaV,
    flightTime,
    requiredPhase,
    currentPhase,
    timeToWindow,
    synodicPeriod: degenerate ? Infinity : TAU / Math.abs(relativeRate),
    degenerate,
  };
}

/**
 * Angle of a position around the primary, in the ring plane, radians.
 *
 * Both bodies in a transfer have to be measured the same way for the phase
 * difference to mean anything, so this is the one place it is defined.
 */
export const orbitalAngle = (x: number, y: number): number => Math.atan2(y, x);

/**
 * Whether a transfer is worth showing a window for.
 *
 * Two orbits of nearly the same radius have a synodic period running to years
 * and a phase condition that is met almost continuously; reporting "next window
 * in 1 400 days" for a transfer between Telesto and Tethys — which share an
 * orbit exactly — is noise rather than information.
 */
export const windowIsMeaningful = (solution: TransferSolution): boolean =>
  !solution.degenerate &&
  Number.isFinite(solution.synodicPeriod) &&
  Math.abs(solution.toRadius - solution.fromRadius) / solution.fromRadius > 0.02;
