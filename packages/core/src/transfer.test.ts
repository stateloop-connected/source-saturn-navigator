import { describe, expect, it } from 'vitest';
import { moonById } from './moons.js';
import { planTransfer, windowIsMeaningful } from './transfer.js';
import { SATURN_GM } from './saturn.js';
import { SECONDS_PER_DAY } from './units.js';
import { DEG, TAU } from './vec.js';

const radiusOf = (id: string): number => moonById(id)!.elements.a;

describe('Hohmann figures', () => {
  it('costs what the textbook says for Rhea to Titan', () => {
    const solution = planTransfer({
      fromRadius: radiusOf('rhea'),
      toRadius: radiusOf('titan'),
      fromAngle: 0,
      toAngle: 0,
    });

    // Both burns prograde for an outward transfer.
    expect(solution.departureDeltaV).toBeGreaterThan(0);
    expect(solution.arrivalDeltaV).toBeGreaterThan(0);
    expect(solution.totalDeltaV / 1000).toBeGreaterThan(1.5);
    expect(solution.totalDeltaV / 1000).toBeLessThan(3.5);

    // Half the period of an ellipse spanning 527 000 to 1 222 000 km.
    expect(solution.flightTime / SECONDS_PER_DAY).toBeGreaterThan(4);
    expect(solution.flightTime / SECONDS_PER_DAY).toBeLessThan(9);
  });

  it('reverses cleanly: inward costs the same and burns the other way', () => {
    const out = planTransfer({
      fromRadius: radiusOf('rhea'),
      toRadius: radiusOf('titan'),
      fromAngle: 0,
      toAngle: 0,
    });
    const back = planTransfer({
      fromRadius: radiusOf('titan'),
      toRadius: radiusOf('rhea'),
      fromAngle: 0,
      toAngle: 0,
    });

    expect(back.departureDeltaV).toBeLessThan(0);
    expect(back.arrivalDeltaV).toBeLessThan(0);
    expect(back.totalDeltaV).toBeCloseTo(out.totalDeltaV, 6);
    expect(back.flightTime).toBeCloseTo(out.flightTime, 6);
  });

  it('puts the transfer ellipse between the two orbits', () => {
    const solution = planTransfer({
      fromRadius: 300_000,
      toRadius: 900_000,
      fromAngle: 0,
      toAngle: 0,
    });
    expect(solution.transferAxis).toBe(600_000);
  });
});

describe('the departure window', () => {
  /*
   * The half of the problem that makes a transfer a plan rather than a sum.
   * Arriving at Titan's *orbit* is easy; arriving at Titan requires leaving at
   * one moment per synodic period, and everything below is about that moment.
   */
  it('wants the target behind when transferring outward', () => {
    // The chaser sweeps half a turn while the slower target sweeps less, so
    // the target must start short of opposition — often behind.
    const solution = planTransfer({
      fromRadius: radiusOf('mimas'),
      toRadius: radiusOf('titan'),
      fromAngle: 0,
      toAngle: 0,
    });
    expect(solution.requiredPhase).toBeLessThan(Math.PI);
    expect(Math.abs(solution.requiredPhase)).toBeLessThanOrEqual(Math.PI);
  });

  it('reports no wait when the phase is already right', () => {
    const probe = planTransfer({
      fromRadius: radiusOf('rhea'),
      toRadius: radiusOf('titan'),
      fromAngle: 0,
      toAngle: 0,
    });
    // Re-ask with the target placed exactly where it needs to be.
    const aligned = planTransfer({
      fromRadius: radiusOf('rhea'),
      toRadius: radiusOf('titan'),
      fromAngle: 0,
      toAngle: probe.requiredPhase,
    });
    expect(aligned.timeToWindow).toBeLessThan(60);
  });

  it('never reports a window further off than one synodic period', () => {
    for (let k = 0; k < 24; k++) {
      const solution = planTransfer({
        fromRadius: radiusOf('rhea'),
        toRadius: radiusOf('titan'),
        fromAngle: 0,
        toAngle: (k / 24) * TAU,
      });
      expect(solution.timeToWindow).toBeGreaterThanOrEqual(0);
      expect(solution.timeToWindow).toBeLessThanOrEqual(solution.synodicPeriod + 1);
    }
  });

  it('waiting the reported time actually brings the phase to what was required', () => {
    // The check that the arithmetic closes: advance both bodies by the quoted
    // wait, and the target must land on the required lead.
    const from = radiusOf('dione');
    const to = radiusOf('titan');
    const solution = planTransfer({ fromRadius: from, toRadius: to, fromAngle: 0.7, toAngle: 2.3 });

    const n1 = Math.sqrt(SATURN_GM / from ** 3);
    const n2 = Math.sqrt(SATURN_GM / to ** 3);
    const later = planTransfer({
      fromRadius: from,
      toRadius: to,
      fromAngle: 0.7 + n1 * solution.timeToWindow,
      toAngle: 2.3 + n2 * solution.timeToWindow,
    });

    const gap = Math.abs(later.currentPhase - later.requiredPhase);
    expect(Math.min(gap, TAU - gap)).toBeLessThan(1e-6);
  });

  it('gives Rhea and Titan a synodic period of a couple of weeks', () => {
    const solution = planTransfer({
      fromRadius: radiusOf('rhea'),
      toRadius: radiusOf('titan'),
      fromAngle: 0,
      toAngle: 1,
    });
    expect(solution.synodicPeriod / SECONDS_PER_DAY).toBeGreaterThan(4);
    expect(solution.synodicPeriod / SECONDS_PER_DAY).toBeLessThan(12);
  });
});

describe('plane changes', () => {
  it('costs nothing when the orbits are coplanar', () => {
    expect(
      planTransfer({
        fromRadius: radiusOf('rhea'),
        toRadius: radiusOf('titan'),
        fromAngle: 0,
        toAngle: 0,
      }).planeChangeDeltaV,
    ).toBe(0);
  });

  it('costs real money to reach Iapetus, which is inclined 15 degrees', () => {
    const solution = planTransfer({
      fromRadius: radiusOf('titan'),
      toRadius: radiusOf('iapetus'),
      fromAngle: 0,
      toAngle: 0,
      fromInclination: 0.3 * DEG,
      toInclination: 15.47 * DEG,
    });
    // Hundreds of m/s, even taken at the slow end of the transfer.
    expect(solution.planeChangeDeltaV).toBeGreaterThan(50);
    expect(solution.planeChangeDeltaV).toBeLessThan(700);
  });
});

describe('degenerate cases', () => {
  it('refuses to offer a window for two moons sharing an orbit', () => {
    // Telesto rides Tethys's orbit exactly; there is no synodic period.
    const solution = planTransfer({
      fromRadius: radiusOf('tethys'),
      toRadius: radiusOf('telesto'),
      fromAngle: 0,
      toAngle: 60 * DEG,
    });
    expect(windowIsMeaningful(solution)).toBe(false);
  });

  it('does offer one for orbits that are genuinely different', () => {
    const solution = planTransfer({
      fromRadius: radiusOf('mimas'),
      toRadius: radiusOf('enceladus'),
      fromAngle: 0,
      toAngle: 1,
    });
    expect(windowIsMeaningful(solution)).toBe(true);
  });
});
