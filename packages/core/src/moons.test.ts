import { describe, expect, it } from 'vitest';
import {
  MASSIVE_MOON_IDS,
  MOONS,
  MOONS_BY_DISTANCE,
  moonById,
  moonHillRadius,
  orbitalPeriod,
  syntheticPhase,
} from './moons.js';
import { SATURN_GM, MAIN_RING_OUTER } from './saturn.js';
import { SECONDS_PER_DAY } from './units.js';

describe('the catalogue is well formed', () => {
  it('has no duplicate ids', () => {
    expect(new Set(MOONS.map((moon) => moon.id)).size).toBe(MOONS.length);
  });

  it('gives every moon a positive size and mass', () => {
    for (const moon of MOONS) {
      expect(moon.radius).toBeGreaterThan(0);
      expect(moon.gm).toBeGreaterThan(0);
      expect(moon.albedo).toBeGreaterThan(0);
    }
  });

  it('clears the 100-metre threshold everywhere, with room to spare', () => {
    // The brief asked for every moon over 100 m. The smallest confirmed moon of
    // Saturn is Aegaeon at 330 m mean radius, so the whole catalogue qualifies
    // and nothing had to be filtered out.
    for (const moon of MOONS) {
      expect(moon.radius * 1000).toBeGreaterThan(100);
    }
    expect(Math.min(...MOONS.map((moon) => moon.radius))).toBeLessThan(0.5);
  });

  it('resolves every co-orbital anchor', () => {
    for (const moon of MOONS) {
      if (!moon.coorbital) continue;
      expect(moonById(moon.coorbital.with)).toBeDefined();
      expect(Math.abs(moon.coorbital.offsetDeg)).toBeGreaterThan(0);
    }
  });

  it('keeps every orbit outside the main rings', () => {
    // Except the two gap moons, which is the entire point of them.
    for (const moon of MOONS) {
      if (moon.id === 'pan' || moon.id === 'daphnis') continue;
      expect(moon.elements.a).toBeGreaterThan(MAIN_RING_OUTER * 0.97);
    }
    expect(moonById('pan')!.elements.a).toBeLessThan(MAIN_RING_OUTER);
    expect(moonById('daphnis')!.elements.a).toBeLessThan(MAIN_RING_OUTER);
  });

  it('sorts by distance without ties out of order', () => {
    for (let k = 1; k < MOONS_BY_DISTANCE.length; k++) {
      expect(MOONS_BY_DISTANCE[k]!.elements.a).toBeGreaterThanOrEqual(
        MOONS_BY_DISTANCE[k - 1]!.elements.a,
      );
    }
  });

  it('marks retrograde irregulars as such and refers them to the ecliptic', () => {
    const phoebe = moonById('phoebe')!;
    expect(phoebe.elements.i).toBeGreaterThan(90);
    expect(phoebe.elements.frame).toBe('ecliptic');

    for (const moon of MOONS) {
      if (moon.group === 'norse') expect(moon.elements.i).toBeGreaterThan(90);
      if (moon.group === 'inuit' || moon.group === 'gallic') {
        expect(moon.elements.i).toBeLessThan(90);
      }
      if (moon.elements.a > 8_000_000) expect(moon.elements.frame).toBe('ecliptic');
    }
  });
});

describe('the derived figures', () => {
  it('reproduces the published periods', () => {
    const expected: Record<string, number> = {
      pan: 0.575,
      mimas: 0.942,
      enceladus: 1.370,
      tethys: 1.888,
      dione: 2.737,
      rhea: 4.518,
      titan: 15.945,
      hyperion: 21.28,
      kiviuq: 448.2,
      phoebe: 550.1,
      siarnaq: 885.0,
      iapetus: 79.32,
    };
    for (const [id, days] of Object.entries(expected)) {
      const period = orbitalPeriod(moonById(id)!, SATURN_GM) / SECONDS_PER_DAY;
      expect(period).toBeCloseTo(days, 1);
    }
  });

  it('gives Titan a comfortable Hill sphere and Mimas almost none', () => {
    // The number that decides whether a capture is possible at all. Mimas's is
    // barely twice its own radius, so there is essentially no orbit around it
    // that Saturn does not take away.
    const titan = moonHillRadius(moonById('titan')!, SATURN_GM);
    expect(titan).toBeGreaterThan(40_000);
    expect(titan).toBeLessThan(65_000);

    const mimas = moonById('mimas')!;
    const mimasHill = moonHillRadius(mimas, SATURN_GM);
    expect(mimasHill).toBeLessThan(mimas.radius * 4);
  });

  it('selects the massive moons for the mutual-gravity set', () => {
    expect(MASSIVE_MOON_IDS).toContain('titan');
    expect(MASSIVE_MOON_IDS).toContain('mimas');
    expect(MASSIVE_MOON_IDS).toContain('prometheus');
    expect(MASSIVE_MOON_IDS).not.toContain('daphnis');
    expect(MASSIVE_MOON_IDS.length).toBeLessThan(MOONS.length / 2);
  });

  it('estimates a mass only where none was measured', () => {
    expect(moonById('titan')!.gmMeasured).toBe(true);
    expect(moonById('mimas')!.gmMeasured).toBe(true);
    expect(moonById('daphnis')!.gmMeasured).toBe(false);
    expect(moonById('ymir')!.gmMeasured).toBe(false);
  });
});

describe('synthetic phases', () => {
  it('are deterministic, which is what makes a session reproducible', () => {
    expect(syntheticPhase('titan')).toBe(syntheticPhase('titan'));
    expect(syntheticPhase('titan')).not.toBe(syntheticPhase('rhea'));
  });

  it('stay inside one turn', () => {
    for (const moon of MOONS) {
      expect(moon.elements.meanLongitude).toBeGreaterThanOrEqual(0);
      expect(moon.elements.meanLongitude).toBeLessThan(360);
    }
  });

  it('spread the moons around rather than clumping them', () => {
    // Four quadrants, 53 moons: a hash that clumped would leave one empty.
    const quadrants = [0, 0, 0, 0];
    for (const moon of MOONS) quadrants[Math.floor(moon.elements.meanLongitude / 90)]!++;
    for (const count of quadrants) expect(count).toBeGreaterThan(4);
  });
});
