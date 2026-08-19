import { describe, expect, it } from 'vitest';
import { MOONS, moonById, type Moon } from './moons.js';
import { SATURN_GM } from './saturn.js';
import { SaturnSystem, SATURN_INDEX } from './system.js';
import { SECONDS_PER_DAY } from './units.js';
import { RAD, length, sub, wrapDeg } from './vec.js';

/** A cut-down system, so a test can run for months without taking minutes. */
const subset = (...ids: string[]): Moon[] =>
  ids.map((id) => {
    const moon = moonById(id);
    if (!moon) throw new Error(`no such moon: ${id}`);
    return moon;
  });

/** Mean longitude of a body about Saturn, degrees — the angle a trojan holds. */
function meanLongitude(system: SaturnSystem, index: number): number {
  const r = system.saturnCentred(index);
  return wrapDeg(Math.atan2(r.y, r.x) * RAD);
}

describe('seeding', () => {
  const system = new SaturnSystem();

  it('places every moon on the orbit the catalogue asked for', () => {
    for (let i = 1; i < system.count; i++) {
      const moon = system.bodies[i]!;
      const orbit = system.orbitOf(i);
      // Co-orbitals are deliberately moved onto their parent's axis.
      const expected = moon.coorbital?.matchAxis
        ? moonById(moon.coorbital.with)!.elements.a
        : moon.elements.a;
      expect(Math.abs(orbit.a - expected) / expected).toBeLessThan(2e-3);
      expect(Math.abs(orbit.e - moon.elements.e)).toBeLessThan(5e-3);
    }
  });

  it('gets the inclinations right, including the retrograde ones', () => {
    // Phoebe goes round backwards. Its elements are quoted against the ecliptic,
    // so if the frame rotation were skipped it would come out near 175 - 28
    // degrees instead, and this is the test that would notice.
    const phoebe = system.orbitOf(system.indexOf('phoebe'));
    expect(phoebe.i * RAD).toBeGreaterThan(90);
    expect(phoebe.i * RAD).toBeGreaterThan(145);

    const iapetus = system.orbitOf(system.indexOf('iapetus'));
    expect(iapetus.i * RAD).toBeGreaterThan(14);
    expect(iapetus.i * RAD).toBeLessThan(17);
  });

  it('puts the system in its barycentre, so nothing drifts off the map', () => {
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i < system.count; i++) {
      const base = i * 3;
      px += system.gm[i]! * system.velocities[base]!;
      py += system.gm[i]! * system.velocities[base + 1]!;
      pz += system.gm[i]! * system.velocities[base + 2]!;
    }
    expect(Math.hypot(px, py, pz) / SATURN_GM).toBeLessThan(1e-12);
  });

  it('gives Titan the period it actually has', () => {
    const titan = system.orbitOf(system.indexOf('titan'));
    expect(titan.period / SECONDS_PER_DAY).toBeCloseTo(15.945, 1);
  });

  it('gives Mimas the period it actually has', () => {
    const mimas = system.orbitOf(system.indexOf('mimas'));
    expect(mimas.period / SECONDS_PER_DAY).toBeCloseTo(0.942, 2);
  });
});

describe('the integrator', () => {
  it('conserves energy over a long run', () => {
    const system = new SaturnSystem();
    const before = system.totalEnergy();
    system.advance(3 * SECONDS_PER_DAY);
    const after = system.totalEnergy();
    // Symplectic: the error oscillates rather than accumulating, so even a
    // loose bound here is meaningful — a leaking integrator blows through it.
    expect(Math.abs((after - before) / before)).toBeLessThan(1e-10);
  });

  it('is time-reversible', () => {
    const system = new SaturnSystem(0, 60, subset('mimas', 'enceladus', 'titan'));
    const start = system.snapshot();
    system.advance(2 * SECONDS_PER_DAY);
    system.advance(-2 * SECONDS_PER_DAY);

    for (let i = 0; i < system.positions.length; i++) {
      const drift = Math.abs(system.positions[i]! - start.positions[i]!);
      expect(drift).toBeLessThan(1e-3); // metres, over two days out and back
    }
    expect(system.time).toBeCloseTo(0, 6);
  });

  it('keeps Mimas on a closed orbit rather than letting it spiral', () => {
    /*
     * The osculating semi-major axis is *supposed* to wobble here. Saturn's
     * bulge is not a central force, so the ellipse Mimas is instantaneously on
     * breathes twice per orbit — that is a real effect worth some six parts in
     * a hundred thousand, not integration error.
     *
     * What must not happen is a trend. So the test compares an average early in
     * the run against an average late in it, which cancels the oscillation and
     * leaves only the drift a leaking integrator would produce.
     */
    const system = new SaturnSystem(0, 60, subset('mimas'));
    const index = system.indexOf('mimas');
    const period = system.orbitOf(index).period;

    // Averaged over a whole number of periods, so the breathing cancels and
    // only a trend survives. Sampling on any other interval aliases against the
    // 0.94-day orbit and reads the oscillation as drift.
    const orbitAverage = (): number => {
      const steps = 200;
      let total = 0;
      for (let k = 0; k < steps; k++) {
        system.advance(period / steps);
        total += system.orbitOf(index).a;
      }
      return total / steps;
    };

    const early = orbitAverage();
    system.advance(120 * SECONDS_PER_DAY);
    const late = orbitAverage();

    // The instantaneous value swings by 2.1e-4; the average holds to 1e-6.
    expect(Math.abs(late - early) / early).toBeLessThan(1e-6);
  });
});

describe('the co-orbital moons', () => {
  it('holds Telesto and Calypso at the Tethys Lagrange points', () => {
    const system = new SaturnSystem(0, 60, subset('tethys', 'telesto', 'calypso'));
    const tethys = system.indexOf('tethys');
    const telesto = system.indexOf('telesto');
    const calypso = system.indexOf('calypso');

    // Tadpole orbits librate, so this is a bound rather than a fixed angle. A
    // trojan that has come unstuck circulates instead, and leaves the range
    // within a few orbits.
    for (let day = 0; day < 60; day += 4) {
      system.advance(4 * SECONDS_PER_DAY);
      const lead = wrapDeg(meanLongitude(system, telesto) - meanLongitude(system, tethys));
      const trail = wrapDeg(meanLongitude(system, calypso) - meanLongitude(system, tethys));
      expect(lead).toBeGreaterThan(25);
      expect(lead).toBeLessThan(95);
      expect(trail).toBeGreaterThan(265);
      expect(trail).toBeLessThan(335);
    }
  });

  it('never lets Janus and Epimetheus collide', () => {
    // Their semi-major axes differ by 50 km, less than the sum of their radii.
    // They swap orbits every four years without ever coming within 15 000 km of
    // each other, and that only works from a wide starting separation.
    const system = new SaturnSystem(0, 30, subset('janus', 'epimetheus'));
    const janus = system.indexOf('janus');
    const epimetheus = system.indexOf('epimetheus');

    let closest = Infinity;
    for (let step = 0; step < 120; step++) {
      system.advance(SECONDS_PER_DAY);
      const separation = length(
        sub(system.saturnCentred(janus), system.saturnCentred(epimetheus)),
      );
      closest = Math.min(closest, separation);
    }
    expect(closest).toBeGreaterThan(15_000);
  });
});

describe('forking', () => {
  it('produces a system that runs identically to the original', () => {
    const original = new SaturnSystem(0, 60, subset('mimas', 'enceladus', 'dione'));
    original.advance(SECONDS_PER_DAY);

    const copy = original.fork();
    original.advance(SECONDS_PER_DAY);
    copy.advance(SECONDS_PER_DAY);

    for (let i = 0; i < original.positions.length; i++) {
      expect(copy.positions[i]).toBeCloseTo(original.positions[i]!, 9);
    }
  });

  it('does not disturb the original', () => {
    const original = new SaturnSystem(0, 60, subset('titan'));
    const before = original.snapshot();
    const copy = original.fork();
    copy.advance(10 * SECONDS_PER_DAY);

    for (let i = 0; i < original.positions.length; i++) {
      expect(original.positions[i]).toBe(before.positions[i]);
    }
  });
});

describe('the catalogue as loaded', () => {
  const system = new SaturnSystem();

  it('carries Saturn at index 0 and every moon after it', () => {
    expect(system.count).toBe(MOONS.length + 1);
    expect(system.bodies[SATURN_INDEX]).toBeNull();
    expect(system.indexOf('titan')).toBeGreaterThan(0);
  });

  it('has Titan dominating the moons by mass', () => {
    const titan = moonById('titan')!;
    const others = MOONS.filter((moon) => moon.id !== 'titan').reduce(
      (sum, moon) => sum + moon.gm,
      0,
    );
    expect(titan.gm).toBeGreaterThan(others * 20);
  });
});
