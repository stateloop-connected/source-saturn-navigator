/**
 * The mission: out of Saturn's atmosphere, up past Titan, home to the ship.
 *
 * ## Why this trip
 *
 * It is the one that teaches the system. Leaving from the cloud tops means the
 * departure burn happens deep in Saturn's well, where the Oberth effect is
 * enormous and a player discovers that *where* you burn matters more than how
 * much. The rings sit directly in the way, so the climb has to be planned
 * rather than simply thrusted through. And the destination is beyond Titan, so
 * the arrival is a rendezvous with a moving target rather than a circularisation
 * at a radius — which is the point at which the ghost moons in the trajectory
 * overlay stop being decoration and start being the only way to aim.
 *
 * The whole thing costs about 13 km/s and takes six days of simulated time.
 *
 * ## Where the mother ship is, and why it is not in the simulation
 *
 * It sits in a circular equatorial orbit at 2 000 000 km — outside Hyperion at
 * 1 481 010 and far inside Iapetus at 3 560 840, which is genuinely empty space
 * and the reason a ship would park there.
 *
 * Its position is evaluated analytically from Keplerian elements rather than
 * integrated with everything else. It is a spacecraft holding station, not a
 * moon: giving it to the n-body integrator would let it drift under Titan's
 * perturbations over a long session, and a parking orbit that wanders is a
 * worse model of a parked ship than a circle is.
 */

import { stateFromElements, type StateVector } from './elements.js';
import { SATURN_GM } from './saturn.js';
import { length, sub, type Vec3 } from './vec.js';

/** Radius of the mother ship's parking orbit, km. */
export const PARKING_RADIUS = 2_000_000;

/**
 * Where the module starts: a circular orbit 530 km above the 1-bar level.
 *
 * Genuinely skimming the upper atmosphere, and below the inner edge of the D
 * ring at 66 900 km, so the rings are overhead from the first frame.
 *
 * Atmospheric drag is not modelled. At this altitude the real thing would decay
 * over months, which is far longer than the mission, but it is an omission
 * rather than a claim.
 */
export const START_RADIUS = 60_800;

/** Elements of the parking orbit. Circular, equatorial, prograde. */
const PARKING_ORBIT = {
  a: PARKING_RADIUS,
  e: 0,
  i: 0,
  node: 0,
  peri: 0,
  meanLongitude: 140,
} as const;

/**
 * The mother ship's state at a given time, Saturn-centred.
 *
 * Returned in the same frame the renderer draws in; the caller adds Saturn's
 * barycentric position where an absolute one is needed.
 */
export function motherShipAt(time: number): StateVector {
  const period = 2 * Math.PI * Math.sqrt(PARKING_RADIUS ** 3 / SATURN_GM);
  const advanced = (360 * time) / period;
  return stateFromElements(
    { ...PARKING_ORBIT, meanLongitude: PARKING_ORBIT.meanLongitude + advanced },
    SATURN_GM,
  );
}

/** Orbital period of the parking orbit, seconds — about 33 days. */
export const parkingPeriod = (): number =>
  2 * Math.PI * Math.sqrt(PARKING_RADIUS ** 3 / SATURN_GM);

export type ObjectiveId =
  | 'leave-atmosphere'
  | 'clear-rings'
  | 'reach-titan'
  | 'reach-parking'
  | 'rendezvous';

export interface Objective {
  id: ObjectiveId;
  /** Order in which they are expected to fall. */
  step: number;
}

export const OBJECTIVES: readonly Objective[] = [
  { id: 'leave-atmosphere', step: 1 },
  { id: 'clear-rings', step: 2 },
  { id: 'reach-titan', step: 3 },
  { id: 'reach-parking', step: 4 },
  { id: 'rendezvous', step: 5 },
];

/** How close counts as arrived, km, and how slowly, km/s. */
export const RENDEZVOUS_DISTANCE = 500;
export const RENDEZVOUS_SPEED = 0.05;

/** Periapsis that counts as out of the atmosphere, km. */
const ATMOSPHERE_TOP = 62_000;

/** Periapsis that counts as clear of the rings, km — outside the F ring. */
const RING_TOP = 140_600;

export interface MissionProgress {
  /** Objectives achieved at some point, in order. Latching: never un-ticks. */
  achieved: Set<ObjectiveId>;
  /** The next one to work on, or null when the mission is complete. */
  current: ObjectiveId | null;
  complete: boolean;
  /** Distance to the mother ship, km. */
  distance: number;
  /** Speed relative to the mother ship, km/s. */
  relativeSpeed: number;
}

export interface MissionInputs {
  time: number;
  /** Module state, Saturn-centred. */
  position: Vec3;
  velocity: Vec3;
  /** Osculating orbit about Saturn. */
  periapsis: number;
  apoapsis: number;
  bound: boolean;
}

/**
 * Evaluate the mission against the module's current state.
 *
 * Objectives **latch**. Once the apoapsis has touched Titan's orbit the
 * objective stays ticked even after the next burn changes the orbit, because
 * the list is a record of the journey rather than a description of the present
 * — and a checklist that un-ticks itself while the player is mid-transfer reads
 * as a bug however defensible it is.
 *
 * `achieved` is mutated rather than rebuilt, which is what makes the latching
 * work across calls; the caller owns the set and it lives in the store.
 */
export function evaluateMission(
  inputs: MissionInputs,
  achieved: Set<ObjectiveId>,
): MissionProgress {
  const ship = motherShipAt(inputs.time);
  const distance = length(sub(inputs.position, ship.position));
  const relativeSpeed = length(sub(inputs.velocity, ship.velocity));

  if (inputs.periapsis > ATMOSPHERE_TOP) achieved.add('leave-atmosphere');
  if (inputs.periapsis > RING_TOP) achieved.add('clear-rings');

  // An unbound trajectory has passed every radius it will ever reach, so the
  // reach objectives take the apoapsis only where there is one.
  const reach = inputs.bound ? inputs.apoapsis : Infinity;
  if (reach >= 1_221_870) achieved.add('reach-titan');
  if (reach >= PARKING_RADIUS) achieved.add('reach-parking');

  if (distance <= RENDEZVOUS_DISTANCE && relativeSpeed <= RENDEZVOUS_SPEED) {
    achieved.add('rendezvous');
  }

  const current = OBJECTIVES.find((objective) => !achieved.has(objective.id))?.id ?? null;

  return {
    achieved,
    current,
    complete: achieved.has('rendezvous'),
    distance,
    relativeSpeed,
  };
}

/**
 * A fresh mission.
 *
 * The set is empty rather than pre-seeded even though the starting orbit fails
 * every objective, because the first evaluation runs before the first frame is
 * drawn and will fill it in correctly.
 */
export const newMission = (): Set<ObjectiveId> => new Set<ObjectiveId>();
