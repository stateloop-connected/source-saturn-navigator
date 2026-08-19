import { describe, expect, it } from 'vitest';
import { moonById, type Moon } from './moons.js';
import { createModule } from './module.js';
import { predict } from './predict.js';
import { SATURN_GM } from './saturn.js';
import { SaturnSystem, SATURN_INDEX, type Probe } from './system.js';
import { SECONDS_PER_DAY, circularSpeed } from './units.js';
import { ZERO, add, length, sub, vec3 } from './vec.js';

const subset = (...ids: string[]): Moon[] => ids.map((id) => moonById(id)!);

/** A probe on a circular equatorial orbit at `radius`, in the barycentric frame. */
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

describe('the prediction is the simulation', () => {
  /*
   * The promise the feature rests on. A predicted path that merely resembles
   * what will happen is worse than none, because the player will plan a capture
   * burn on it. So the predictor forks the real system and flies it with the
   * real force law, and this test holds it to that: run the prediction, then
   * run the live simulation the same distance, and the two must agree to
   * floating-point noise.
   */
  it('lands the module exactly where flying it live does', () => {
    const moons = subset('mimas', 'enceladus', 'tethys', 'dione', 'titan');
    const duration = 2 * SECONDS_PER_DAY;

    const system = new SaturnSystem(0, 60, moons);
    const probe = circularProbe(system, 300_000);
    const module = createModule();

    const prediction = predict(system, module, probe, {
      duration,
      samples: 64,
      ghosts: 4,
    });

    const live = new SaturnSystem(0, 60, moons);
    const flown = circularProbe(live, 300_000);
    live.probes = [flown];
    live.advance(duration);

    const predicted = vec3(
      prediction.path[(prediction.sampleCount - 1) * 3]!,
      prediction.path[(prediction.sampleCount - 1) * 3 + 1]!,
      prediction.path[(prediction.sampleCount - 1) * 3 + 2]!,
    );
    const actual = sub(flown.position, live.positionOf(SATURN_INDEX));

    expect(length(sub(predicted, actual))).toBeLessThan(1e-6);
  });

  it('leaves the live system untouched', () => {
    const system = new SaturnSystem(0, 60, subset('titan'));
    const before = system.snapshot();
    predict(system, createModule(), circularProbe(system, 400_000), {
      duration: SECONDS_PER_DAY,
      samples: 16,
    });
    expect(system.time).toBe(before.time);
    for (let i = 0; i < system.positions.length; i++) {
      expect(system.positions[i]).toBe(before.positions[i]);
    }
  });
});

describe('what a prediction reports', () => {
  it('returns ghosts of every body, at the times it says', () => {
    const system = new SaturnSystem(0, 60, subset('mimas', 'titan'));
    const prediction = predict(system, createModule(), circularProbe(system, 250_000), {
      duration: SECONDS_PER_DAY,
      samples: 32,
      ghosts: 5,
    });

    expect(prediction.ghosts).toHaveLength(5);
    for (const ghost of prediction.ghosts) {
      expect(ghost.positions).toHaveLength(system.count * 3);
      // Ghost positions are Saturn-centred, so Saturn's own is at the origin.
      expect(Math.hypot(ghost.positions[0]!, ghost.positions[1]!, ghost.positions[2]!)).toBeLessThan(1e-6);
    }
    expect(prediction.ghosts[0]!.time).toBeLessThan(prediction.ghosts[4]!.time);
  });

  it('keeps a circular orbit circular', () => {
    const system = new SaturnSystem(0, 60, subset('mimas'));
    const prediction = predict(system, createModule(), circularProbe(system, 400_000), {
      duration: SECONDS_PER_DAY,
      samples: 200,
    });

    for (let k = 0; k < prediction.sampleCount; k++) {
      const radius = Math.hypot(
        prediction.path[k * 3]!,
        prediction.path[k * 3 + 1]!,
        prediction.path[k * 3 + 2]!,
      );
      // J2 makes a "circular" orbit breathe slightly; 1% is generous room.
      expect(Math.abs(radius - 400_000) / 400_000).toBeLessThan(0.01);
    }
  });

  it('notices an impact and stops there', () => {
    // Dropped from rest well above the cloud tops: it can only fall in.
    const system = new SaturnSystem(0, 30, subset('mimas'));
    const saturn = system.positionOf(SATURN_INDEX);
    const probe: Probe = {
      position: add(saturn, vec3(120_000, 0, 0)),
      velocity: system.velocityOf(SATURN_INDEX),
      thrust: ZERO,
    };

    const prediction = predict(system, createModule(), probe, {
      duration: SECONDS_PER_DAY,
      samples: 100,
    });

    expect(prediction.impact).not.toBeNull();
    expect(prediction.impact!.bodyIndex).toBe(SATURN_INDEX);
    expect(prediction.impact!.speed).toBeGreaterThan(20); // km/s
  });

  it('ranks closest approaches', () => {
    const system = new SaturnSystem(0, 60, subset('mimas', 'enceladus', 'titan'));
    const prediction = predict(system, createModule(), circularProbe(system, 238_040), {
      duration: 3 * SECONDS_PER_DAY,
      samples: 64,
    });

    expect(prediction.approaches.length).toBeGreaterThan(0);
    for (let k = 1; k < prediction.approaches.length; k++) {
      expect(prediction.approaches[k]!.distance).toBeGreaterThanOrEqual(
        prediction.approaches[k - 1]!.distance,
      );
    }
  });
});

describe('flying a planned burn', () => {
  it('raises the orbit and spends propellant doing it', () => {
    const system = new SaturnSystem(0, 60, subset('mimas'));
    const module = createModule();
    const probe = circularProbe(system, 300_000);

    const ballistic = predict(system, module, probe, {
      duration: SECONDS_PER_DAY,
      samples: 64,
    });
    const burned = predict(system, module, probe, {
      duration: SECONDS_PER_DAY,
      samples: 64,
      burns: [{ offset: 0, duration: 300, mode: 'prograde', throttle: 1 }],
    });

    const apoapsisOf = (prediction: typeof ballistic): number => {
      let maximum = 0;
      for (let k = 0; k < prediction.sampleCount; k++) {
        maximum = Math.max(
          maximum,
          Math.hypot(
            prediction.path[k * 3]!,
            prediction.path[k * 3 + 1]!,
            prediction.path[k * 3 + 2]!,
          ),
        );
      }
      return maximum;
    };

    expect(apoapsisOf(burned)).toBeGreaterThan(apoapsisOf(ballistic) * 1.05);
    expect(burned.propellantRemaining).toBeLessThan(module.propellant);
    expect(ballistic.propellantRemaining).toBe(module.propellant);
  });

  it('will not burn propellant it does not have', () => {
    const system = new SaturnSystem(0, 60, subset('mimas'));
    const module = { ...createModule(), propellant: 5 };
    const prediction = predict(system, module, circularProbe(system, 300_000), {
      duration: 3_600,
      samples: 16,
      burns: [{ offset: 0, duration: 3_000, mode: 'prograde', throttle: 1 }],
    });
    expect(prediction.propellantRemaining).toBe(0);
  });
});
