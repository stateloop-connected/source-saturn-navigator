import { describe, expect, it } from 'vitest';
import { osculatingElements } from './elements.js';
import {
  autopilotThrust,
  burnDuration,
  burnWindow,
  circulariseAtApoapsis,
  emptyNode,
  hohmannTransfer,
  nodeDirection,
  nodeMagnitude,
  orbitAfter,
  raiseToRadius,
  schedulable,
  timeToApoapsis,
} from './manoeuvre.js';
import { PARKING_RADIUS, START_RADIUS, evaluateMission, motherShipAt, newMission } from './mission.js';
import { createModule } from './module.js';
import { predict } from './predict.js';
import { moonById, type Moon } from './moons.js';
import { SATURN_GM } from './saturn.js';
import { SaturnSystem, SATURN_INDEX, type Probe } from './system.js';
import { SECONDS_PER_DAY, circularSpeed } from './units.js';
import { ZERO, add, dot, length, normalize, sub, vec3 } from './vec.js';

const subset = (...ids: string[]): Moon[] => ids.map((id) => moonById(id)!);

function circularProbe(system: SaturnSystem, radius: number): Probe {
  const saturn = system.positionOf(SATURN_INDEX);
  return {
    position: add(saturn, vec3(radius, 0, 0)),
    velocity: add(
      system.velocityOf(SATURN_INDEX),
      vec3(0, circularSpeed(SATURN_GM, radius), 0),
    ),
    thrust: ZERO,
  };
}

describe('the node frame', () => {
  const position = vec3(300_000, 0, 0);
  const velocity = vec3(0, circularSpeed(SATURN_GM, 300_000), 0);

  it('points a pure prograde node along the velocity', () => {
    const node = { ...emptyNode(0), prograde: 100 };
    const direction = nodeDirection(node, position, velocity);
    expect(dot(direction, normalize(velocity))).toBeCloseTo(1, 9);
  });

  it('points a retrograde node against it', () => {
    const node = { ...emptyNode(0), prograde: -100 };
    expect(dot(nodeDirection(node, position, velocity), normalize(velocity))).toBeCloseTo(-1, 9);
  });

  it('points a normal node along the orbit normal', () => {
    const node = { ...emptyNode(0), normal: 100 };
    // Prograde equatorial orbit: the normal is Saturn's north pole.
    expect(nodeDirection(node, position, velocity).z).toBeCloseTo(1, 9);
  });

  it('points a radial node away from the primary', () => {
    const node = { ...emptyNode(0), radial: 100 };
    expect(dot(nodeDirection(node, position, velocity), normalize(position))).toBeCloseTo(1, 9);
  });

  it('gives no direction where the frame is undefined', () => {
    // A radial fall has no orbit normal, and inventing one from rounding error
    // would send the autopilot somewhere arbitrary.
    const node = { ...emptyNode(0), normal: 100 };
    expect(length(nodeDirection(node, position, vec3(1, 0, 0)))).toBe(0);
  });
});

describe('the burn window', () => {
  const module = createModule();

  it('is centred on the node', () => {
    const node = { ...emptyNode(1_000), prograde: 500 };
    const window = burnWindow(node, module);
    expect((window.start + window.end) / 2).toBeCloseTo(1_000, 6);
  });

  it('lasts delta-v over acceleration when the tanks are unlimited', () => {
    const node = { ...emptyNode(0), prograde: 500 };
    const acceleration = module.spec.maxThrust / (module.spec.dryMass + module.propellant);
    expect(burnDuration(node, module)).toBeCloseTo(500 / acceleration, 6);
  });

  it('is empty for a node that asks for nothing', () => {
    expect(burnDuration(emptyNode(0), module)).toBe(0);
  });

  it('commands no thrust outside the window', () => {
    const node = { ...emptyNode(10_000), prograde: 200 };
    const position = vec3(300_000, 0, 0);
    const velocity = vec3(0, 10, 0);
    expect(length(autopilotThrust(node, module, 0, 0, position, velocity))).toBe(0);
    expect(length(autopilotThrust(node, module, 20_000, 0, position, velocity))).toBe(0);
    expect(length(autopilotThrust(node, module, 10_000, 0, position, velocity))).toBeGreaterThan(0);
  });

  it('depends on nothing but its arguments', () => {
    // The property the predictor rests on: no accumulated state, so a forked
    // copy running ahead gets the same answer as the live simulation would.
    const node = { ...emptyNode(500), prograde: 300 };
    const position = vec3(300_000, 0, 0);
    const velocity = vec3(0, 10, 0);
    const first = autopilotThrust(node, module, 500, 60, position, velocity);
    const second = autopilotThrust(node, module, 500, 60, position, velocity);
    expect(first).toEqual(second);
  });
});

describe('scheduling a node that is already due', () => {
  const module = createModule();

  it('pushes it forward so the whole burn can still be flown', () => {
    // The failure this exists to stop: a solver asked for "the next periapsis"
    // of a circular orbit, which has none, and answered "now". The window is
    // centred on the node, so half the burn was already in the past and the
    // autopilot delivered half the velocity change into an orbit that then
    // looked simply wrong.
    const node = { ...emptyNode(1_000), prograde: 9_800 };
    const shifted = schedulable(node, module, 1_000);
    const window = burnWindow(shifted, module);
    expect(window.start).toBeGreaterThanOrEqual(1_000 - 1e-9);
    expect(window.duration).toBeCloseTo(burnDuration(node, module), 6);
  });

  it('leaves a node with room to spare alone', () => {
    const node = { ...emptyNode(100_000), prograde: 200 };
    expect(schedulable(node, module, 0)).toBe(node);
  });

  it('delivers more of the burn than the unshifted node would', () => {
    /*
     * Measured as a comparison rather than against an absolute apoapsis, and
     * deliberately: what `schedulable` fixes is that half the burn was being
     * thrown away, so the honest test is that the shifted node goes
     * measurably further than the same node left where the solver put it.
     *
     * An absolute figure would also have to encode how far a given burn climbs
     * in a given look-ahead, which is a fact about the look-ahead rather than
     * about the fix.
     */
    const module = createModule();
    const build = () => {
      const system = new SaturnSystem(0, 60, subset('mimas'));
      const probe = circularProbe(system, 60_800);
      const orbit = osculatingElements(
        sub(probe.position, system.positionOf(SATURN_INDEX)),
        sub(probe.velocity, system.velocityOf(SATURN_INDEX)),
        SATURN_GM,
      );
      return { system, probe, orbit };
    };

    const reach = (shift: boolean): number => {
      const { system, probe, orbit } = build();
      const raw = raiseToRadius(0, orbit, SATURN_GM, PARKING_RADIUS, SATURN_INDEX)!;
      const node = shift ? schedulable(raw, module, 0) : raw;

      const prediction = predict(system, module, probe, {
        duration: 6 * 3_600,
        samples: 300,
        step: 60,
        node,
      });

      let furthest = 0;
      for (let k = 0; k < prediction.sampleCount; k++) {
        furthest = Math.max(
          furthest,
          Math.hypot(
            prediction.path[k * 3]!,
            prediction.path[k * 3 + 1]!,
            prediction.path[k * 3 + 2]!,
          ),
        );
      }
      return furthest;
    };

    // Half a burn against a whole one: the difference is large and unambiguous.
    expect(reach(true)).toBeGreaterThan(reach(false) * 1.3);
  });

});

describe('a predicted burn is the burn that gets flown', () => {
  /*
   * The same guarantee the ballistic predictor already makes, extended to
   * manoeuvres — and this is the harder half, because a burn is where an
   * implementation is most tempted to take a shortcut and treat the node as an
   * instantaneous kick. If it did, this would fail by kilometres.
   */
  it('agrees with running the live simulation through the same node', () => {
    const moons = subset('mimas', 'titan');
    const module = createModule();
    const node = { ...emptyNode(1_800, SATURN_INDEX), prograde: 400 };
    const duration = 6 * 3_600;

    const system = new SaturnSystem(0, 60, moons);
    const probe = circularProbe(system, 300_000);
    const prediction = predict(system, module, probe, {
      duration,
      samples: 64,
      step: 60,
      node,
    });

    // Fly it live, applying the autopilot the same way the store does.
    const live = new SaturnSystem(0, 60, moons);
    const flown = circularProbe(live, 300_000);
    live.probes = [flown];

    while (live.time < duration - 1e-9) {
      const dt = Math.min(60, duration - live.time);
      flown.thrust = autopilotThrust(
        node,
        module,
        live.time,
        dt,
        sub(flown.position, live.positionOf(SATURN_INDEX)),
        sub(flown.velocity, live.velocityOf(SATURN_INDEX)),
      );
      live.stepOnce(dt);
    }

    const predicted = vec3(
      prediction.path[(prediction.sampleCount - 1) * 3]!,
      prediction.path[(prediction.sampleCount - 1) * 3 + 1]!,
      prediction.path[(prediction.sampleCount - 1) * 3 + 2]!,
    );
    const actual = sub(flown.position, live.positionOf(SATURN_INDEX));

    expect(length(sub(predicted, actual))).toBeLessThan(1e-6);
  });

  it('raises the orbit by roughly what the impulsive plan said', () => {
    const system = new SaturnSystem(0, 60, subset('mimas'));
    const probe = circularProbe(system, 300_000);
    const module = createModule();

    const relative = sub(probe.position, system.positionOf(SATURN_INDEX));
    const relativeVelocity = sub(probe.velocity, system.velocityOf(SATURN_INDEX));
    const node = { ...emptyNode(600, SATURN_INDEX), prograde: 300 };

    const planned = orbitAfter(node, relative, relativeVelocity, SATURN_GM);
    const prediction = predict(system, module, probe, {
      duration: SECONDS_PER_DAY,
      samples: 300,
      node,
    });

    let flownApoapsis = 0;
    for (let k = 0; k < prediction.sampleCount; k++) {
      flownApoapsis = Math.max(
        flownApoapsis,
        Math.hypot(
          prediction.path[k * 3]!,
          prediction.path[k * 3 + 1]!,
          prediction.path[k * 3 + 2]!,
        ),
      );
    }

    // Finite-burn losses mean the flown result falls a little short of the
    // impulsive plan. That gap is real physics and the game shows it; what the
    // test holds is that it stays small for a burn this size.
    expect(flownApoapsis).toBeGreaterThan(planned.apoapsis * 0.97);
    expect(flownApoapsis).toBeLessThan(planned.apoapsis * 1.01);
  });
});

describe('manoeuvre solutions', () => {
  it('circularises an elliptical orbit at apoapsis', () => {
    const position = vec3(300_000, 0, 0);
    const velocity = vec3(0, circularSpeed(SATURN_GM, 300_000) * 1.2, 0);
    const orbit = osculatingElements(position, velocity, SATURN_GM);

    const node = circulariseAtApoapsis(0, orbit, SATURN_GM, SATURN_INDEX);
    expect(node).not.toBeNull();
    // Starting at periapsis, so apoapsis is half a period away.
    expect(node!.at).toBeCloseTo(orbit.period / 2, 0);
    // Speeding up at apoapsis is what raises periapsis to meet it.
    expect(node!.prograde).toBeGreaterThan(0);
    expect(nodeMagnitude(node!)).toBe(Math.abs(node!.prograde));
  });

  it('finds apoapsis half a period from periapsis', () => {
    const orbit = osculatingElements(
      vec3(300_000, 0, 0),
      vec3(0, circularSpeed(SATURN_GM, 300_000) * 1.15, 0),
      SATURN_GM,
    );
    expect(timeToApoapsis(orbit)).toBeCloseTo(orbit.period / 2, 0);
  });

  it('plans a transfer from the starting orbit to the parking orbit', () => {
    const position = vec3(START_RADIUS, 0, 0);
    const velocity = vec3(0, circularSpeed(SATURN_GM, START_RADIUS), 0);
    const plan = hohmannTransfer(position, velocity, SATURN_GM, PARKING_RADIUS);

    // The mission's headline numbers: about 13 km/s, about six days.
    expect(plan.total / 1000).toBeGreaterThan(11);
    expect(plan.total / 1000).toBeLessThan(15);
    expect(plan.flightTime / SECONDS_PER_DAY).toBeGreaterThan(4);
    expect(plan.flightTime / SECONDS_PER_DAY).toBeLessThan(9);
    expect(plan.departure).toBeGreaterThan(0);
    expect(plan.arrival).toBeGreaterThan(0);
  });

  it('raises apoapsis to a requested radius', () => {
    const position = vec3(START_RADIUS, 0, 0);
    const velocity = vec3(0, circularSpeed(SATURN_GM, START_RADIUS), 0);
    const orbit = osculatingElements(position, velocity, SATURN_GM);

    const node = raiseToRadius(0, orbit, SATURN_GM, 1_221_870, SATURN_INDEX);
    expect(node).not.toBeNull();

    const after = orbitAfter(node!, position, velocity, SATURN_GM);
    expect(after.apoapsis).toBeCloseTo(1_221_870, -2);
  });
});

describe('spheres of influence', () => {
  const system = new SaturnSystem();

  it('puts a point near Titan inside Titan', () => {
    const titan = system.indexOf('titan');
    const near = add(system.positionOf(titan), vec3(20_000, 0, 0));
    expect(system.influenceAt(near)).toBe(titan);
  });

  it('puts a point far from Titan back with Saturn', () => {
    const titan = system.indexOf('titan');
    const far = add(system.positionOf(titan), vec3(200_000, 0, 0));
    expect(system.influenceAt(far)).toBe(SATURN_INDEX);
  });

  it('gives Titan a usable sphere and Mimas almost none', () => {
    // Mimas's sphere of influence is 249 km against a body of radius 198 — a
    // shell fifty kilometres thick, and below it is the ground.
    expect(system.influenceRadius(system.indexOf('titan'))).toBeGreaterThan(40_000);
    const mimas = system.influenceRadius(system.indexOf('mimas'));
    expect(mimas).toBeGreaterThan(200);
    expect(mimas).toBeLessThan(300);
  });

  it('reports Saturn everywhere in open space', () => {
    expect(system.influenceAt(add(system.positionOf(SATURN_INDEX), vec3(700_000, 0, 0))))
      .toBe(SATURN_INDEX);
  });
});

describe('the mission', () => {
  it('parks the mother ship in genuinely empty space', () => {
    // Outside Hyperion at 1 481 010 and far inside Iapetus at 3 560 840.
    expect(PARKING_RADIUS).toBeGreaterThan(1_481_010);
    expect(PARKING_RADIUS).toBeLessThan(3_560_840);
  });

  it('keeps the mother ship on its circular orbit', () => {
    for (const time of [0, 1e6, 5e6, 2e7]) {
      const state = motherShipAt(time);
      expect(length(state.position)).toBeCloseTo(PARKING_RADIUS, 3);
      expect(length(state.velocity)).toBeCloseTo(circularSpeed(SATURN_GM, PARKING_RADIUS), 6);
    }
  });

  it('starts with nothing achieved and finishes with everything', () => {
    const achieved = newMission();
    const start = evaluateMission(
      {
        time: 0,
        position: vec3(START_RADIUS, 0, 0),
        velocity: vec3(0, circularSpeed(SATURN_GM, START_RADIUS), 0),
        periapsis: START_RADIUS,
        apoapsis: START_RADIUS,
        bound: true,
      },
      achieved,
    );
    expect(start.complete).toBe(false);
    expect(start.current).toBe('leave-atmosphere');

    const ship = motherShipAt(1_000);
    const done = evaluateMission(
      {
        time: 1_000,
        position: ship.position,
        velocity: ship.velocity,
        periapsis: PARKING_RADIUS,
        apoapsis: PARKING_RADIUS,
        bound: true,
      },
      achieved,
    );
    expect(done.complete).toBe(true);
    expect(done.current).toBeNull();
    expect(done.distance).toBeLessThan(1);
  });

  it('latches objectives so the checklist never un-ticks mid-transfer', () => {
    const achieved = newMission();
    const base = {
      time: 0,
      position: vec3(START_RADIUS, 0, 0),
      velocity: vec3(0, 10, 0),
      bound: true,
    };
    evaluateMission({ ...base, periapsis: 200_000, apoapsis: 1_500_000 }, achieved);
    expect(achieved.has('reach-titan')).toBe(true);

    // A later burn drops the apoapsis back; the record of the journey stands.
    const after = evaluateMission({ ...base, periapsis: 200_000, apoapsis: 400_000 }, achieved);
    expect(after.achieved.has('reach-titan')).toBe(true);
  });
});
