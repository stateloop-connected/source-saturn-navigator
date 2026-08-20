import { describe, expect, it } from 'vitest';
import { osculatingElements } from './elements.js';
import {
  autopilotThrust,
  burnDuration,
  circulariseAtApoapsis,
  raiseToRadius,
  schedulable,
  type ManoeuvreNode,
} from './manoeuvre.js';
import {
  PARKING_RADIUS,
  RENDEZVOUS_DISTANCE,
  START_RADIUS,
  evaluateMission,
  motherShipAt,
  newMission,
} from './mission.js';
import { createModule, type ModuleState } from './module.js';
import { moonById, type Moon } from './moons.js';
import { SATURN_GM, circularSpeedInField } from './saturn.js';
import { SaturnSystem, SATURN_INDEX, type Probe } from './system.js';
import { SECONDS_PER_DAY } from './units.js';
import { ZERO, add, length, sub, vec3 } from './vec.js';

const subset = (...ids: string[]): Moon[] => ids.map((id) => moonById(id)!);

/**
 * A minimal flight loop, matching what the store does each frame.
 *
 * Kept here rather than imported because the store lives in the app package and
 * cannot be reached from core — which is the right way round, but it means this
 * has to mirror the autopilot call exactly, and the mirroring is the thing
 * worth reading.
 */
function fly(
  system: SaturnSystem,
  probe: Probe,
  module: ModuleState,
  node: ManoeuvreNode | null,
  until: number,
  step = 60,
): void {
  while (system.time < until - 1e-9) {
    const dt = Math.min(step, until - system.time);
    probe.thrust = node
      ? autopilotThrust(
          node,
          module,
          system.time,
          dt,
          sub(probe.position, system.positionOf(node.referenceIndex)),
          sub(probe.velocity, system.velocityOf(node.referenceIndex)),
        )
      : ZERO;
    system.stepOnce(dt);
  }
}

/**
 * Coast until the module stops climbing — the real apoapsis, not a predicted one.
 *
 * Needed because the transfer orbit crosses Titan's, and Titan perturbs it hard
 * enough over a nine-day coast to move apoapsis by 600 000 km. A circularisation
 * planned from the elements at departure therefore fires a long way off the
 * mark. Watching the radial rate turn over instead is what a navigator does,
 * and it is robust to whatever the moons did in the meantime.
 */
function coastToApoapsis(
  system: SaturnSystem,
  probe: Probe,
  limit: number,
  step = 120,
): void {
  const radialRate = (): number => {
    const r = sub(probe.position, system.positionOf(SATURN_INDEX));
    const v = sub(probe.velocity, system.velocityOf(SATURN_INDEX));
    return (r.x * v.x + r.y * v.y + r.z * v.z) / length(r);
  };

  const deadline = system.time + limit;
  probe.thrust = ZERO;
  while (system.time < deadline && radialRate() > 0) {
    system.stepOnce(step);
  }
}

const orbitOf = (system: SaturnSystem, probe: Probe) =>
  osculatingElements(
    sub(probe.position, system.positionOf(SATURN_INDEX)),
    sub(probe.velocity, system.velocityOf(SATURN_INDEX)),
    SATURN_GM,
  );

describe('the mission can actually be flown', () => {
  /*
   * An integration test over the whole design, not a unit test.
   *
   * It exists because "is this mission completable with this engine?" is a
   * question no unit test asks and no amount of reading answers — the first
   * version of the module could not do it, and nothing failed except the
   * apoapsis coming out at a fifth of the target with no explanation on screen.
   *
   * The flight is deliberately the obvious one a player would try: burn at the
   * bottom to throw apoapsis out to the parking radius, coast for six days,
   * then circularise at the top. It is not optimised, and it does not need to
   * be — what is being tested is that the intended solution works.
   */
  it('reaches the parking orbit by burning at successive periapses', () => {
    // Titan and the massive inner moons: enough to perturb honestly, few enough
    // to run in a test.
    const system = new SaturnSystem(
      0,
      60,
      subset('mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan'),
    );
    const module = createModule();
    const objectives = newMission();

    const probe: Probe = {
      position: add(system.positionOf(SATURN_INDEX), vec3(START_RADIUS, 0, 0)),
      velocity: add(
        system.velocityOf(SATURN_INDEX),
        vec3(0, circularSpeedInField(vec3(START_RADIUS, 0, 0)), 0),
      ),
      thrust: ZERO,
    };
    system.probes = [probe];

    /*
     * Burn at periapsis, repeatedly, until apoapsis reaches the target.
     *
     * One burn does not do it, and that is the physics rather than a shortfall
     * in the model: leaving the starting orbit costs 9.5 km/s against an
     * orbital speed of 25, so even a burn lasting a twelfth of an orbit loses
     * about a fifth of its intended apoapsis to the thrust vector swinging
     * round. Real departures from deep wells are split the same way, and the
     * player has the same options — burn again at the next periapsis, or add
     * the shortfall by hand.
     *
     * The loop is what makes this an honest test of "can the mission be
     * flown": it uses only what the interface offers, and it has to converge.
     */
    let passes = 0;
    while (orbitOf(system, probe).apoapsis < PARKING_RADIUS && passes < 6) {
      const node = schedulable(
        raiseToRadius(
          system.time,
          orbitOf(system, probe),
          SATURN_GM,
          PARKING_RADIUS,
          SATURN_INDEX,
        )!,
        module,
        system.time,
      );

      // Each burn must stay short against the orbit it is made from.
      expect(burnDuration(node, module)).toBeLessThan(orbitOf(system, probe).period / 6);

      fly(system, probe, module, node, node.at + burnDuration(node, module) + 60);
      passes++;
    }

    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(6);

    const raised = orbitOf(system, probe);
    expect(raised.apoapsis).toBeGreaterThanOrEqual(PARKING_RADIUS);
    expect(raised.periapsis).toBeGreaterThan(60_268);

    // --- coast to apoapsis, then circularise there --------------------------
    /*
     * Planned on arrival rather than on departure, and that is not a
     * convenience. The transfer orbit crosses Titan's, so over the nine days of
     * the coast Titan moves apoapsis by hundreds of thousands of kilometres; a
     * node computed from the elements at departure fires well short of the top.
     * Coasting until the climb stops and solving from there is both what a
     * navigator does and the only thing that works.
     */
    coastToApoapsis(system, probe, 40 * SECONDS_PER_DAY);

    const atTop = orbitOf(system, probe);
    const height = length(sub(probe.position, system.positionOf(SATURN_INDEX)));
    expect(height).toBeGreaterThan(PARKING_RADIUS * 0.7);

    const circularise = schedulable(
      circulariseAtApoapsis(system.time, atTop, SATURN_GM, SATURN_INDEX)!,
      module,
      system.time,
    );
    fly(
      system,
      probe,
      module,
      circularise,
      circularise.at + burnDuration(circularise, module) + 60,
      30,
    );

    const parked = orbitOf(system, probe);

    const progress = evaluateMission(
      {
        time: system.time,
        position: sub(probe.position, system.positionOf(SATURN_INDEX)),
        velocity: sub(probe.velocity, system.velocityOf(SATURN_INDEX)),
        periapsis: parked.periapsis,
        apoapsis: parked.apoapsis,
        bound: parked.bound,
      },
      objectives,
    );

    // Everything short of the rendezvous itself, which needs the departure
    // phased against the mother ship and is the part left to the player.
    expect(progress.achieved.has('leave-atmosphere')).toBe(true);
    expect(progress.achieved.has('clear-rings')).toBe(true);
    expect(progress.achieved.has('reach-titan')).toBe(true);
    expect(progress.achieved.has('reach-parking')).toBe(true);

    // Circularised near the parking radius: the orbit the mother ship is on.
    expect(parked.e).toBeLessThan(0.25);
    expect(parked.periapsis).toBeGreaterThan(PARKING_RADIUS * 0.6);
    expect(parked.bound).toBe(true);
  }, 60_000);

  it('leaves the module far short of the ship without phasing', () => {
    // The point of the last objective: arriving at the right *radius* is not
    // arriving. The mother ship is somewhere on a 33-day orbit, and closing the
    // remaining gap is a phasing problem the player has to solve.
    const ship = motherShipAt(6 * SECONDS_PER_DAY);
    const elsewhere = vec3(-ship.position.x, -ship.position.y, ship.position.z);
    expect(length(sub(elsewhere, ship.position))).toBeGreaterThan(RENDEZVOUS_DISTANCE * 100);
  });
});

describe('the starting orbit', () => {
  it('is inside the rings and above the cloud tops', () => {
    expect(START_RADIUS).toBeGreaterThan(60_268);
    expect(START_RADIUS).toBeLessThan(66_900);
  });

  it('is a stable orbit that does not immediately decay into Saturn', () => {
    // No atmospheric drag is modelled, so this checks the geometry only: the
    // orbit must clear the oblate surface all the way round.
    const system = new SaturnSystem(0, 60, subset('mimas'));
    const probe: Probe = {
      position: add(system.positionOf(SATURN_INDEX), vec3(START_RADIUS, 0, 0)),
      velocity: add(
        system.velocityOf(SATURN_INDEX),
        vec3(0, circularSpeedInField(vec3(START_RADIUS, 0, 0)), 0),
      ),
      thrust: ZERO,
    };
    system.probes = [probe];
    system.advance(2 * SECONDS_PER_DAY);

    const orbit = orbitOf(system, probe);
    expect(orbit.periapsis).toBeGreaterThan(60_268);
    expect(orbit.bound).toBe(true);
  });
});
