/**
 * Where the module will be, and where everything else will be when it gets
 * there.
 *
 * The method is the honest one: **fork the simulation and fly it.** No
 * Keplerian shortcut, no patched conics, no analytic ephemeris consulted on the
 * side. The predictor takes the exact state the live system is in, hands the
 * copy the same force law and the same integrator, and runs it forward. What
 * comes back is therefore not an estimate of what the simulation will do — it
 * is what the simulation *will* do, to within the difference in step size.
 *
 * That property is the reason the feature is worth having. A prediction the
 * player cannot trust is worse than none, because they will plan a capture burn
 * on it. Here, if the predicted path grazes Mimas, the real one will too.
 *
 * The cost is that the moons must be integrated as well as the module, which is
 * exactly the work the live simulation is already doing — so a prediction of a
 * month costs about what a month of play costs, a few seconds, and belongs in a
 * worker rather than on the frame thread.
 */

import { SATURN_EQUATORIAL_RADIUS, saturnSurfaceRadius } from './saturn.js';
import { SaturnSystem, SATURN_INDEX, type Probe } from './system.js';
import {
  thrustAcceleration,
  totalMass,
  type ModuleState,
  type ThrustMode,
} from './module.js';
import { autopilotThrust, type ManoeuvreNode } from './manoeuvre.js';
import { ZERO, length, sub, vec3, type Vec3 } from './vec.js';

/** A burn scheduled for the prediction to fly. */
export interface PlannedBurn {
  /** When it starts, in seconds from the prediction's own start. */
  offset: number;
  /** How long it lasts, seconds. */
  duration: number;
  mode: ThrustMode;
  /** 0 to 1. */
  throttle: number;
  /** Aim for `inertial` mode. */
  inertialAim?: Vec3;
}

export interface PredictionRequest {
  /** How far ahead to look, seconds. */
  duration: number;
  /** How many points to return along the path. */
  samples: number;
  /**
   * Integration step, seconds. Defaults to the live system's.
   *
   * Raising it is the main lever on how long a prediction takes, and it is a
   * real trade: at 300 s the path is still good to a few kilometres over a
   * week, and a month-long look-ahead comes back in under a second.
   */
  step?: number;
  /**
   * Record the position of every body at this many evenly spaced instants,
   * for drawing the moons where they *will* be when the module arrives.
   *
   * This is the part that makes a prediction legible. A curve through empty
   * space says nothing about whether the encounter happens; the same curve with
   * Titan drawn at the moment of closest approach says everything.
   */
  ghosts?: number;
  burns?: readonly PlannedBurn[];
  /**
   * A planned manoeuvre for the prediction to fly.
   *
   * Flown through `autopilotThrust`, which is the same function the live
   * simulation uses — so the predicted path through a burn is the path that
   * will actually be flown, finite-burn losses and all. Predicting the burn as
   * an instantaneous kick instead would be easier and would quietly disagree
   * with the ship for exactly the manoeuvres the player cares most about.
   */
  node?: ManoeuvreNode | null;
}

export interface Ghost {
  time: number;
  /** Saturn-centred positions of every body, flat, km. */
  positions: Float64Array;
}

export interface Approach {
  bodyIndex: number;
  /** Time of closest approach, seconds from the prediction's start. */
  time: number;
  /** Centre-to-centre distance, km. */
  distance: number;
  /** Relative speed at that moment, km/s. */
  speed: number;
}

export interface Impact {
  bodyIndex: number;
  time: number;
  /** Saturn-centred position of the module at impact, km. */
  position: Vec3;
  /** Speed relative to the body struck, km/s. */
  speed: number;
}

export interface Prediction {
  /** Time of each path point, seconds from the prediction's start. */
  times: Float64Array;
  /** The module's path, Saturn-centred, km. Flat: x, y, z per sample. */
  path: Float64Array;
  /** How many samples were actually written — short if the flight ended early. */
  sampleCount: number;
  ghosts: Ghost[];
  /** Closest approach to each massive body, nearest first. */
  approaches: Approach[];
  impact: Impact | null;
  /** Propellant left at the end, kg. */
  propellantRemaining: number;
  /** Wall-clock cost of producing this, ms. Shown so the player can tune it. */
  elapsedMs: number;
}

/** Which burn, if any, is active at an offset. */
function burnAt(burns: readonly PlannedBurn[], offset: number): PlannedBurn | null {
  for (const burn of burns) {
    if (offset >= burn.offset && offset < burn.offset + burn.duration) return burn;
  }
  return null;
}

/**
 * How close a body has to be approached before it counts as hit.
 *
 * Saturn's is direction-dependent because it is visibly not a sphere — a polar
 * approach reaches the atmosphere 5 900 km sooner than an equatorial one, which
 * is more than the whole depth of the visible atmosphere and quite enough to
 * turn a survivable pass into a fatal one.
 */
function collisionRadius(system: SaturnSystem, index: number, toward: Vec3): number {
  if (index === SATURN_INDEX) return saturnSurfaceRadius(toward);
  return system.bodies[index]?.radius ?? 0;
}

/**
 * Fly a forked copy of the system forward and report what happens.
 *
 * `system` is not modified: the first thing this does is take a copy.
 */
export function predict(
  system: SaturnSystem,
  module: ModuleState,
  probe: Probe,
  request: PredictionRequest,
): Prediction {
  const startedAt = Date.now();

  const step = request.step ?? system.step;
  const duration = request.duration;
  const samples = Math.max(2, request.samples);
  const burns = request.burns ?? [];

  const copy = system.fork(step);
  const flown: Probe = {
    position: probe.position,
    velocity: probe.velocity,
    thrust: ZERO,
  };
  copy.probes = [flown];

  const times = new Float64Array(samples);
  const path = new Float64Array(samples * 3);

  const ghostCount = request.ghosts ?? 0;
  const ghosts: Ghost[] = [];
  const ghostInterval = ghostCount > 0 ? duration / ghostCount : Infinity;
  let nextGhost = ghostInterval;

  // Closest approach is tracked for everything with a measured mass; the
  // estimated-mass moons are kilometre-scale rocks that nobody is aiming at.
  const tracked: number[] = [];
  for (let i = 0; i < copy.count; i++) {
    if (i === SATURN_INDEX || (copy.bodies[i]?.gmMeasured ?? false)) tracked.push(i);
  }
  const closest = new Map<number, Approach>();

  const sampleInterval = duration / (samples - 1);
  let nextSample = 0;
  let written = 0;
  let impact: Impact | null = null;
  let propellant = module.propellant;

  const start = copy.time;
  const recordSample = (offset: number): void => {
    if (written >= samples) return;
    const relative = sub(flown.position, copy.positionOf(SATURN_INDEX));
    times[written] = offset;
    path[written * 3] = relative.x;
    path[written * 3 + 1] = relative.y;
    path[written * 3 + 2] = relative.z;
    written++;
    nextSample = written * sampleInterval;
  };

  const recordGhost = (offset: number): void => {
    const saturn = copy.positionOf(SATURN_INDEX);
    const positions = new Float64Array(copy.count * 3);
    for (let i = 0; i < copy.count; i++) {
      positions[i * 3] = copy.positions[i * 3]! - saturn.x;
      positions[i * 3 + 1] = copy.positions[i * 3 + 1]! - saturn.y;
      positions[i * 3 + 2] = copy.positions[i * 3 + 2]! - saturn.z;
    }
    ghosts.push({ time: offset, positions });
  };

  const checkProximity = (offset: number): boolean => {
    for (const index of tracked) {
      const bodyPosition = copy.positionOf(index);
      const toward = sub(flown.position, bodyPosition);
      const distance = length(toward);

      const previous = closest.get(index);
      if (!previous || distance < previous.distance) {
        closest.set(index, {
          bodyIndex: index,
          time: offset,
          distance,
          speed: length(sub(flown.velocity, copy.velocityOf(index))),
        });
      }

      if (distance <= collisionRadius(copy, index, toward)) {
        impact = {
          bodyIndex: index,
          time: offset,
          position: sub(flown.position, copy.positionOf(SATURN_INDEX)),
          speed: length(sub(flown.velocity, copy.velocityOf(index))),
        };
        return true;
      }
    }
    return false;
  };

  recordSample(0);
  if (ghostCount > 0) recordGhost(0);
  checkProximity(0);

  let offset = 0;
  while (offset < duration && !impact) {
    const dt = Math.min(step, duration - offset);

    /*
     * A manoeuvre node takes precedence over the burn list.
     *
     * The two mechanisms exist for different things — the node is what the
     * player plans in the interface, the burn list is for scripted profiles —
     * and letting both fire at once would silently double a burn.
     */
    const node = request.node;
    if (node) {
      const reference = node.referenceIndex;
      flown.thrust = autopilotThrust(
        node,
        { ...module, propellant },
        copy.time,
        dt,
        sub(flown.position, copy.positionOf(reference)),
        sub(flown.velocity, copy.velocityOf(reference)),
      );
      if (length(flown.thrust) > 0 && !module.infinitePropellant) {
        propellant = Math.max(
          0,
          propellant -
            (module.spec.maxThrust / (module.spec.specificImpulse * 9.806_65)) * dt,
        );
      }
      copy.stepOnce(dt);
      offset = copy.time - start;

      if (checkProximity(offset)) break;
      if (offset >= nextSample) recordSample(offset);
      if (offset >= nextGhost && ghosts.length < ghostCount) {
        recordGhost(offset);
        nextGhost += ghostInterval;
      }
      continue;
    }

    // Resolve thrust for this step from the plan, against the same reference
    // body the live module is using — so a plan made while targeting Titan
    // means the same thing when it is flown.
    const burn = burnAt(burns, offset);
    if (burn && (module.infinitePropellant || propellant > 0)) {
      const reference = module.referenceIndex;
      const flying: ModuleState = {
        ...module,
        propellant,
        throttle: burn.throttle,
        mode: burn.mode,
        inertialAim: burn.inertialAim ?? module.inertialAim,
      };
      flown.thrust = thrustAcceleration(
        flying,
        sub(flown.position, copy.positionOf(reference)),
        sub(flown.velocity, copy.velocityOf(reference)),
      );
      if (!module.infinitePropellant) {
        const spent =
          ((burn.throttle * module.spec.maxThrust) /
            (module.spec.specificImpulse * 9.806_65)) *
          dt;
        propellant = Math.max(0, propellant - spent);
      }
    } else {
      flown.thrust = ZERO;
    }

    copy.stepOnce(dt);
    offset = copy.time - start;

    if (checkProximity(offset)) break;

    if (offset >= nextSample) recordSample(offset);
    if (offset >= nextGhost && ghosts.length < ghostCount) {
      recordGhost(offset);
      nextGhost += ghostInterval;
    }
  }

  // Always finish on the true end state, so the last drawn point is where the
  // module actually is rather than one step short of it.
  if (written < samples) recordSample(offset);

  const approaches = [...closest.values()]
    .filter((approach) => approach.bodyIndex !== SATURN_INDEX || approach.distance < SATURN_EQUATORIAL_RADIUS * 6)
    .sort((a, b) => a.distance - b.distance);

  return {
    times,
    path,
    sampleCount: written,
    ghosts,
    approaches,
    impact,
    propellantRemaining: propellant,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * A rough cost estimate, in force evaluations, for a prediction request.
 *
 * The interface uses it to warn before the player asks for something that will
 * take a quarter of a minute, which at high warp and a long look-ahead is
 * easily done by accident.
 */
export function predictionCost(
  system: SaturnSystem,
  request: PredictionRequest,
): { steps: number; pairEvaluations: number } {
  const step = request.step ?? system.step;
  const steps = Math.ceil(request.duration / step);
  const pairs = (system.count * (system.count - 1)) / 2;
  return { steps, pairEvaluations: steps * 3 * pairs };
}

/**
 * The module's mass at the end of a plan, kg — for sizing a burn before flying
 * it. Kept here rather than in `module.ts` because it is a property of a plan,
 * not of the ship.
 */
export function massAfterPlan(module: ModuleState, burns: readonly PlannedBurn[]): number {
  let propellant = module.propellant;
  for (const burn of burns) {
    const spent =
      ((burn.throttle * module.spec.maxThrust) /
        (module.spec.specificImpulse * 9.806_65)) *
      burn.duration;
    propellant = Math.max(0, propellant - spent);
  }
  return totalMass({ ...module, propellant });
}

/** A path point as a vector, for callers that would rather not index by hand. */
export const pathPoint = (prediction: Prediction, index: number): Vec3 =>
  vec3(
    prediction.path[index * 3]!,
    prediction.path[index * 3 + 1]!,
    prediction.path[index * 3 + 2]!,
  );
