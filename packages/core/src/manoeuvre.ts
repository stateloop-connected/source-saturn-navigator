/**
 * Manoeuvre nodes: planning a burn, and flying it.
 *
 * ## Impulsive to plan, finite to fly
 *
 * A node is stated as a velocity change delivered instantaneously — that is how
 * orbital mechanics is done, and it is the only form in which "circularise at
 * apoapsis" has a closed-form answer. But an engine does not work that way: a
 * 3 km/s burn at 1.7 m/s2 takes half an hour, during which the module has moved
 * a long way round its orbit and *prograde has rotated underneath it*.
 *
 * So the node is impulsive and the execution is not. The autopilot spreads the
 * burn symmetrically about the node's time, and re-resolves the direction
 * against the current velocity at every step, which is what a real spacecraft
 * does and what makes a long burn end up roughly where the impulsive plan said
 * it would. Roughly, not exactly — finite-burn losses are real, and the game
 * shows them rather than hiding them, because the way to learn that a burn
 * should be split is to watch a long one miss.
 *
 * ## Why the burn window is a pure function of time
 *
 * `autopilotThrust` takes no accumulated state — no "Δv delivered so far"
 * counter. The window is derived from the node's time and the burn duration,
 * both known in advance, so the same call at the same simulated instant gives
 * the same answer whether it comes from the live simulation or from a forked
 * copy running an hour ahead.
 *
 * That is not tidiness. It is the thing that keeps the predictor honest: a
 * counter would live in the live module and be absent from the fork, and the
 * predicted path would quietly diverge from the flown one exactly when a burn
 * was involved — which is precisely when the player is relying on it.
 */

import { osculatingElements, type OrbitSummary } from './elements.js';
import { orbitalBasis, totalMass, type ModuleState } from './module.js';
import {
  ZERO,
  add,
  length,
  normalize,
  scale,
  sub,
  vec3,
  type Vec3,
} from './vec.js';

/**
 * A planned velocity change.
 *
 * Components are in the orbital frame of `referenceIndex` and in **m/s**, which
 * is the unit every manoeuvre is quoted in and the unit the interface shows.
 * Everything else in this package works in km/s; the conversion happens here
 * and nowhere else.
 */
export interface ManoeuvreNode {
  /** Absolute simulation time of the (impulsive) burn, seconds from J2000. */
  at: number;
  /** Along the velocity vector, m/s. Positive raises the far side of the orbit. */
  prograde: number;
  /** Along the orbit normal, m/s. Changes inclination. */
  normal: number;
  /** Away from the reference body, m/s. Rotates the line of apsides. */
  radial: number;
  /** The body the frame is measured against. */
  referenceIndex: number;
}

export const emptyNode = (at: number, referenceIndex = 0): ManoeuvreNode => ({
  at,
  prograde: 0,
  normal: 0,
  radial: 0,
  referenceIndex,
});

/** Total velocity change a node asks for, m/s. */
export const nodeMagnitude = (node: ManoeuvreNode): number =>
  Math.hypot(node.prograde, node.normal, node.radial);

/**
 * The node's direction as a vector in the simulation frame.
 *
 * Built from the *current* relative position and velocity, so a node planned an
 * hour ago still means "prograde" when the moment arrives rather than meaning
 * whatever direction prograde happened to be when it was planned.
 *
 * Returns zero where the frame is undefined — a radial fall has no orbit
 * normal — which the caller must treat as "do not thrust" rather than as a
 * direction.
 */
export function nodeDirection(
  node: ManoeuvreNode,
  relativePosition: Vec3,
  relativeVelocity: Vec3,
): Vec3 {
  const basis = orbitalBasis(relativePosition, relativeVelocity);
  if (!basis) return ZERO;

  const direction = add(
    add(scale(basis.prograde, node.prograde), scale(basis.normal, node.normal)),
    scale(basis.radial, node.radial),
  );
  return length(direction) === 0 ? ZERO : normalize(direction);
}

/**
 * A node's components re-expressed as a magnitude and two angles.
 *
 * The same burn, said the other way round. Components suit trimming — "another
 * ten metres per second prograde" — while magnitude-and-heading suits aiming,
 * and a plane change is far easier to think about as 30 degrees out of the
 * plane than as a pair of numbers whose ratio has to come out right.
 *
 * The interface offers both and converts between them here, so neither is the
 * stored form and there is nothing to keep in step.
 */
export function nodeToAngles(node: ManoeuvreNode): {
  magnitude: number;
  yaw: number;
  pitch: number;
} {
  const magnitude = nodeMagnitude(node);
  if (magnitude === 0) return { magnitude: 0, yaw: 0, pitch: 0 };

  return {
    magnitude,
    pitch: Math.asin(Math.max(-1, Math.min(1, node.normal / magnitude))),
    yaw: Math.atan2(node.radial, node.prograde),
  };
}

/** The inverse: components from a magnitude and two angles. */
export function nodeFromAngles(
  base: ManoeuvreNode,
  magnitude: number,
  yaw: number,
  pitch: number,
): ManoeuvreNode {
  const inPlane = magnitude * Math.cos(pitch);
  return {
    ...base,
    prograde: inPlane * Math.cos(yaw),
    radial: inPlane * Math.sin(yaw),
    normal: magnitude * Math.sin(pitch),
  };
}

/**
 * How long the engine must run to deliver a node, seconds.
 *
 * With propellant unlimited the mass is constant and this is Δv divided by
 * acceleration. With a finite tank it would be the rocket equation, and the
 * burn would accelerate as the tanks emptied; that is a change to make when
 * module properties become configurable, and the shape of the call is already
 * right for it.
 */
export function burnDuration(node: ManoeuvreNode, module: ModuleState): number {
  const magnitude = nodeMagnitude(node);
  if (magnitude === 0) return 0;

  const acceleration = module.spec.maxThrust / totalMass(module); // m/s2
  if (acceleration <= 0) return Infinity;

  if (module.infinitePropellant) return magnitude / acceleration;

  // Finite tank: the achievable Δv is capped, and the burn is longer than the
  // constant-mass estimate because the first part of it is pushing more mass.
  const exhaustSpeed = module.spec.specificImpulse * 9.806_65;
  const massRatio = Math.exp(magnitude / exhaustSpeed);
  const propellantNeeded = totalMass(module) * (1 - 1 / massRatio);
  const flowRate = module.spec.maxThrust / exhaustSpeed;
  return Math.min(propellantNeeded, module.propellant) / flowRate;
}

export interface BurnWindow {
  start: number;
  end: number;
  duration: number;
}

/**
 * When the engine runs, given a node.
 *
 * Centred on the node's time rather than started at it. An impulsive plan says
 * "change velocity by this much *at this instant*"; the closest a finite engine
 * can come is to deliver half before and half after, and centring roughly
 * halves the error against burning entirely after the node.
 */
export function burnWindow(node: ManoeuvreNode, module: ModuleState): BurnWindow {
  const duration = burnDuration(node, module);
  return { start: node.at - duration / 2, end: node.at + duration / 2, duration };
}

/**
 * Thrust acceleration the autopilot commands over the next step, km/s2.
 *
 * The single source of truth for how a node is flown. The live simulation and
 * the trajectory predictor both call this, with the same arguments, and get the
 * same answer — which is what makes a predicted burn match the flown one.
 *
 * ## Why the step length is an argument
 *
 * Callers hold the thrust constant across a step, so asking "is the clock
 * inside the burn window?" at the *start* of each step over-runs the end of it
 * by up to a full step. That sounds negligible and is not: at a 60 s step a
 * 1 330 s burn was flown for 1 380 s, delivering 3.8% more velocity change than
 * planned — and because a departure burn happens at periapsis deep in Saturn's
 * well, 3.8% of 9.5 km/s put apoapsis 68% past the target. The manoeuvre looked
 * like it had worked and the orbit was simply wrong.
 *
 * So instead of a yes-or-no test, the thrust is scaled by the fraction of the
 * coming step that actually falls inside the window. The delivered velocity
 * change is then exactly what the node asked for, at any step size, which also
 * means the predictor may use a coarser step than the live simulation without
 * the two disagreeing about how much the burn was worth.
 *
 * Pass a step of zero for a point sample — used by the interface to ask whether
 * the engine is lit right now.
 */
export function autopilotThrust(
  node: ManoeuvreNode | null,
  module: ModuleState,
  time: number,
  stepSeconds: number,
  relativePosition: Vec3,
  relativeVelocity: Vec3,
): Vec3 {
  if (!node) return ZERO;
  if (!module.infinitePropellant && module.propellant <= 0) return ZERO;

  const window = burnWindow(node, module);
  const step = Math.max(0, stepSeconds);

  let duty: number;
  if (step === 0) {
    duty = time >= window.start && time < window.end ? 1 : 0;
  } else {
    const overlap =
      Math.min(window.end, time + step) - Math.max(window.start, time);
    duty = overlap <= 0 ? 0 : overlap / step;
  }
  if (duty <= 0) return ZERO;

  const direction = nodeDirection(node, relativePosition, relativeVelocity);
  if (length(direction) === 0) return ZERO;

  // N / kg gives m/s2; the simulation works in km.
  const acceleration = module.spec.maxThrust / totalMass(module) / 1000;
  return scale(direction, acceleration * duty);
}

/**
 * Push a node far enough into the future that its whole burn can still be flown.
 *
 * The window is centred on the node's time, so a node scheduled *at* the
 * present instant has half its burn in the past — and the autopilot, which asks
 * only whether the clock is inside the window, will fly the second half and
 * silently deliver half the velocity change.
 *
 * That is not a hypothetical. Every solver that schedules "at the next
 * periapsis" produces exactly this on a circular orbit, because a circular
 * orbit has no periapsis and the solver's answer is therefore *now*. The result
 * looks like a burn that worked and an orbit that came out wrong, which is the
 * worst failure a planning aid can have.
 *
 * Shifting is the right repair rather than refusing: on a circular orbit the
 * apsis is arbitrary and a moment later is as good, and on an elliptical one
 * burning slightly off-apsis costs a little efficiency where the alternative
 * costs half the manoeuvre.
 */
export function schedulable(
  node: ManoeuvreNode,
  module: ModuleState,
  now: number,
): ManoeuvreNode {
  const half = burnDuration(node, module) / 2;
  if (!Number.isFinite(half)) return node;
  const earliest = now + half;
  return node.at >= earliest ? node : { ...node, at: earliest };
}

/** Has the node's burn finished by this time? */
export const nodeComplete = (
  node: ManoeuvreNode,
  module: ModuleState,
  time: number,
): boolean => time >= burnWindow(node, module).end;

// ---------------------------------------------------------------- solutions

/**
 * The orbit that results from applying a node impulsively.
 *
 * Used to show the player what a burn will do *before* the predictor has
 * finished — the full prediction takes a second in a worker, and a slider that
 * only updates once a second is unusable. This is the two-body answer, so it
 * disagrees slightly with the prediction, and where they disagree the
 * prediction is right.
 */
export function orbitAfter(
  node: ManoeuvreNode,
  relativePosition: Vec3,
  relativeVelocity: Vec3,
  gm: number,
): OrbitSummary {
  const direction = nodeDirection(node, relativePosition, relativeVelocity);
  const deltaV = scale(direction, nodeMagnitude(node) / 1000); // m/s to km/s
  return osculatingElements(relativePosition, add(relativeVelocity, deltaV), gm);
}

/**
 * Prograde burn that circularises at the current altitude, m/s.
 *
 * Only correct at an apsis, where the velocity is already perpendicular to the
 * radius; elsewhere circularising needs a radial component too and this
 * under-reports. The interface therefore offers it *at* an apsis rather than
 * anywhere, which is also where a player wants it.
 */
export function circulariseDeltaV(
  relativePosition: Vec3,
  relativeVelocity: Vec3,
  gm: number,
): number {
  const r = length(relativePosition);
  if (r === 0) return 0;
  return (Math.sqrt(gm / r) - length(relativeVelocity)) * 1000;
}

/**
 * Prograde burn at the current point that raises the opposite apsis to
 * `targetRadius`, m/s.
 *
 * The first half of a Hohmann transfer, and the burn that gets a module out of
 * low Saturn orbit and up to Titan. Assumes the burn happens at an apsis, which
 * for a near-circular starting orbit is true enough everywhere.
 */
export function raiseApsisDeltaV(
  relativePosition: Vec3,
  relativeVelocity: Vec3,
  gm: number,
  targetRadius: number,
): number {
  const r = length(relativePosition);
  if (r === 0 || targetRadius <= 0) return 0;

  // Vis-viva on the transfer ellipse whose apsides are r and targetRadius.
  const transferAxis = (r + targetRadius) / 2;
  const speedNeeded = Math.sqrt(gm * (2 / r - 1 / transferAxis));
  return (speedNeeded - length(relativeVelocity)) * 1000;
}

export interface TransferPlan {
  /** Burn at the current position, m/s prograde. */
  departure: number;
  /** Burn on arrival to circularise, m/s prograde. Negative means retrograde. */
  arrival: number;
  /** Time from departure to arrival, seconds. */
  flightTime: number;
  /** Sum of the two burns, m/s. */
  total: number;
}

/**
 * A Hohmann transfer from here to a circular orbit of `targetRadius`.
 *
 * The cheapest two-burn transfer between circular coplanar orbits, and the
 * backbone of the mission: low Saturn orbit to a parking orbit beyond Titan is
 * one of these, costing about 13 km/s and taking six days.
 *
 * It assumes the starting orbit is circular and coplanar with the target, which
 * a player's rarely quite is. The figures are therefore a plan rather than a
 * solution, which is the right level for a planning aid — the predictor tells
 * the truth afterwards.
 */
export function hohmannTransfer(
  relativePosition: Vec3,
  relativeVelocity: Vec3,
  gm: number,
  targetRadius: number,
): TransferPlan {
  const r = length(relativePosition);
  if (r === 0 || targetRadius <= 0) {
    return { departure: 0, arrival: 0, flightTime: 0, total: 0 };
  }

  const transferAxis = (r + targetRadius) / 2;
  const departureSpeed = Math.sqrt(gm * (2 / r - 1 / transferAxis));
  const arrivalSpeed = Math.sqrt(gm * (2 / targetRadius - 1 / transferAxis));
  const circularAtTarget = Math.sqrt(gm / targetRadius);

  return {
    departure: (departureSpeed - length(relativeVelocity)) * 1000,
    arrival: (circularAtTarget - arrivalSpeed) * 1000,
    flightTime: Math.PI * Math.sqrt(transferAxis ** 3 / gm),
    total:
      Math.abs((departureSpeed - length(relativeVelocity)) * 1000) +
      Math.abs((circularAtTarget - arrivalSpeed) * 1000),
  };
}

/**
 * Time until the next apoapsis, seconds. Infinity on an unbound orbit.
 *
 * Both apsis times come from the orbit summary's time-to-periapsis, offset by
 * half a period for the far side, which keeps this consistent with whatever the
 * navigation readout is showing.
 */
export function timeToApoapsis(orbit: OrbitSummary): number {
  if (!orbit.bound) return Infinity;
  const half = orbit.period / 2;
  const value = orbit.timeToPeriapsis - half;
  return value < 0 ? value + orbit.period : value;
}

export const timeToPeriapsis = (orbit: OrbitSummary): number =>
  orbit.bound ? orbit.timeToPeriapsis : Infinity;

/**
 * A node placed at the next apoapsis that circularises there.
 *
 * The single most common manoeuvre in the game — it is how a transfer is
 * finished — so it is offered as one action rather than as a time field and a
 * Δv field the player has to fill in themselves.
 */
export function circulariseAtApoapsis(
  now: number,
  orbit: OrbitSummary,
  gm: number,
  referenceIndex: number,
): ManoeuvreNode | null {
  if (!orbit.bound || !Number.isFinite(orbit.apoapsis)) return null;

  const wait = timeToApoapsis(orbit);
  if (!Number.isFinite(wait)) return null;

  // Speed at apoapsis on the current orbit, and the circular speed there.
  const speedAtApoapsis = Math.sqrt(gm * (2 / orbit.apoapsis - 1 / orbit.a));
  const circular = Math.sqrt(gm / orbit.apoapsis);

  return {
    at: now + wait,
    prograde: (circular - speedAtApoapsis) * 1000,
    normal: 0,
    radial: 0,
    referenceIndex,
  };
}

/** The same at periapsis, which lowers the far side instead of raising it. */
export function circulariseAtPeriapsis(
  now: number,
  orbit: OrbitSummary,
  gm: number,
  referenceIndex: number,
): ManoeuvreNode | null {
  if (!orbit.bound) return null;

  const speedAtPeriapsis = Math.sqrt(gm * (2 / orbit.periapsis - 1 / orbit.a));
  const circular = Math.sqrt(gm / orbit.periapsis);

  return {
    at: now + orbit.timeToPeriapsis,
    prograde: (circular - speedAtPeriapsis) * 1000,
    normal: 0,
    radial: 0,
    referenceIndex,
  };
}

/**
 * A node at the next periapsis that raises apoapsis to `targetRadius`.
 *
 * Burning at periapsis rather than anywhere is the Oberth effect, and it is
 * worth a great deal here: the same propellant spent at 62 000 km buys far more
 * apoapsis than it does higher up, which is why the mission starts with a low
 * orbit rather than climbing steadily.
 */
export function raiseToRadius(
  now: number,
  orbit: OrbitSummary,
  gm: number,
  targetRadius: number,
  referenceIndex: number,
): ManoeuvreNode | null {
  if (!orbit.bound) return null;

  const r = orbit.periapsis;
  const speedNow = Math.sqrt(gm * (2 / r - 1 / orbit.a));
  const transferAxis = (r + targetRadius) / 2;
  const speedNeeded = Math.sqrt(gm * (2 / r - 1 / transferAxis));

  return {
    at: now + orbit.timeToPeriapsis,
    prograde: (speedNeeded - speedNow) * 1000,
    normal: 0,
    radial: 0,
    referenceIndex,
  };
}

/** Node velocity change as a vector in the simulation frame, km/s. */
export const nodeVector = (
  node: ManoeuvreNode,
  relativePosition: Vec3,
  relativeVelocity: Vec3,
): Vec3 =>
  scale(nodeDirection(node, relativePosition, relativeVelocity), nodeMagnitude(node) / 1000);

/** Distance and relative speed between two states — a rendezvous, in two numbers. */
export function rendezvousGap(
  position: Vec3,
  velocity: Vec3,
  targetPosition: Vec3,
  targetVelocity: Vec3,
): { distance: number; relativeSpeed: number } {
  return {
    distance: length(sub(position, targetPosition)),
    relativeSpeed: length(sub(velocity, targetVelocity)),
  };
}

/** A zero vector of the right shape, for callers assembling a thrust command. */
export const noThrust = (): Vec3 => vec3(0, 0, 0);
