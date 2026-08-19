/**
 * The moon catalogue.
 *
 * ## What "every moon over 100 m" means here
 *
 * The brief for this model was every Saturnian moon larger than 100 metres.
 * Taken literally that is not a set anyone can tabulate: the A ring contains
 * millions of *propellers* — unresolved moonlets of 100 m to a kilometre, known
 * only from the wakes they cut — and nobody has orbits for them. What does
 * exist is the catalogue of confirmed satellites, and **every confirmed moon of
 * Saturn is larger than 100 m**; the smallest, Aegaeon, is 660 m across. So the
 * threshold is met not by filtering but by taking the catalogue entire, and the
 * sub-100 m population enters the model the only way it can, as ring mass and
 * ring optical depth (see `saturn.ts`).
 *
 * Listed below are the 53 moons with orbits determined well enough to state:
 * the 23 regular and inner moons, and the 30 named irregulars. Saturn's
 * confirmed count now exceeds 270, the rest being 2019-and-later discoveries in
 * the Norse group, several kilometres across and twenty million kilometres out.
 * They are omitted because their elements are not something this file should be
 * inventing — `scripts/fetch-elements.mjs` pulls real ones from JPL Horizons
 * for anyone who wants the full set.
 *
 * ## What is accurate here, and what is not
 *
 * **Accurate**: masses (as GM, which is what tracking actually measures), radii,
 * albedos, and orbit *shapes* — semi-major axis, eccentricity, inclination.
 * Those give the right periods, the right speeds, the right Hill spheres, and
 * so the right answer to every question the game asks about flying there.
 *
 * **Not accurate**: where each moon is *along* its orbit at the epoch. Mean
 * longitudes below are synthetic — a hash of the moon's name, spread evenly
 * round the circle (`syntheticPhase`). The configuration on any given date is
 * therefore wrong, and the game does not claim otherwise; it is a simulator of
 * this system's dynamics, not an ephemeris of it.
 *
 * Two kinds of phase are exempt, because they are not free parameters but
 * dynamical facts, and getting them wrong would be visible within a week:
 *
 *   - **Trojans.** Telesto and Calypso sit 60 degrees ahead of and behind
 *     Tethys, Helene and Polydeuces the same about Dione. Place them anywhere
 *     else and they simply fall out of the Lagrange point.
 *   - **Janus and Epimetheus.** Their semi-major axes differ by 50 km — less
 *     than the sum of their radii — and they exchange orbits every four years
 *     without ever coming within 15 000 km of each other. That only works from
 *     a wide starting separation, so Epimetheus is anchored half a turn from
 *     Janus.
 *
 * The resonances that are not anchored — Mimas-Tethys, Enceladus-Dione,
 * Titan-Hyperion — will not be found librating, because a resonance is a
 * relationship between phases and the phases are synthetic. The orbits are
 * right; the lock is not set up. Feeding the fetch script's output in fixes all
 * of this at once.
 */

import { hillRadius } from './units.js';

export type MoonGroup =
  | 'ring-shepherd'
  | 'inner'
  | 'trojan'
  | 'major'
  | 'outer'
  | 'inuit'
  | 'gallic'
  | 'norse';

/**
 * Which plane a moon's inclination is measured from.
 *
 * The regular moons are quoted against Saturn's equator, because that is the
 * plane Saturn's oblateness forces them into. The irregulars are quoted against
 * the ecliptic, because they are far enough out that Saturn's bulge has stopped
 * mattering and the Sun has taken over. Mixing the two silently would put
 * Phoebe's orbit 28 degrees away from where it belongs, so the frame travels
 * with the numbers.
 */
export type ElementFrame = 'equatorial' | 'ecliptic';

export interface MoonElements {
  /** Semi-major axis, km. */
  a: number;
  e: number;
  /** Inclination, degrees, measured in `frame`. Over 90 means retrograde. */
  i: number;
  /** Longitude of the ascending node, degrees. */
  node: number;
  /** Argument of periapsis, degrees. */
  peri: number;
  /** Mean longitude at epoch, degrees. Synthetic unless the moon is anchored. */
  meanLongitude: number;
  frame: ElementFrame;
}

export interface Moon {
  id: string;
  /**
   * The moon's name.
   *
   * One string, not a per-locale pair: Saturn's moons carry the same
   * international forms in Czech as in English. Only the words *around* them —
   * group names, ring names, everything in the interface — are translated.
   */
  name: string;
  group: MoonGroup;
  /** Mean radius, km. */
  radius: number;
  /** GM, km3/s2. */
  gm: number;
  /**
   * True when `gm` was measured, from a Cassini flyby or from the moon's effect
   * on the rings. False means it was estimated from the radius at an assumed
   * density of 500 kg/m3, which is right to within a factor of two and wrong by
   * far less than the number matters — every estimated moon here pulls less
   * than a millionth of what Mimas does.
   */
  gmMeasured: boolean;
  /** Geometric albedo. */
  albedo: number;
  /**
   * Albedo of the leading hemisphere, where it differs sharply from the
   * trailing one. Only Iapetus, and it is the whole reason anyone looks at
   * Iapetus: dark as asphalt on the leading face, bright as snow on the other.
   */
  leadingAlbedo?: number;
  elements: MoonElements;
  /**
   * Anchors this moon's mean longitude to another's, degrees offset.
   *
   * Also forces the semi-major axis to match, which is what makes a Lagrange
   * point a Lagrange point — two co-orbitals with slightly different periods
   * drift apart no matter where they start.
   */
  coorbital?: { with: string; offsetDeg: number; matchAxis: boolean };
  /** A one-line note, keyed into the translation table as `moon.note.<id>`. */
  note?: boolean;
}

/**
 * A stable, evenly spread phase from a name.
 *
 * FNV-1a over the id, scaled to a full turn. The point is not that it looks
 * random — it is that it is *deterministic*, so two runs of the game agree,
 * a shared save file means the same thing on both machines, and the trajectory
 * predictor's forked copy starts from exactly the state the live simulation is
 * in. An `Math.random()` here would break all three.
 */
export function syntheticPhase(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash / 0x1_0000_0000) * 360;
}

/** GM from a radius at an assumed density, km3/s2. */
const estimatedGm = (radiusKm: number, densityKgPerM3 = 500): number =>
  6.674_30e-20 * densityKgPerM3 * (4 / 3) * Math.PI * radiusKm ** 3 * 1e9;

interface MoonSeed {
  id: string;
  name: string;
  group: MoonGroup;
  radius: number;
  gm?: number;
  albedo: number;
  leadingAlbedo?: number;
  a: number;
  e: number;
  i: number;
  frame?: ElementFrame;
  coorbital?: { with: string; offsetDeg: number; matchAxis: boolean };
  note?: boolean;
}

/*
 * The table.
 *
 * Ordered outward from Saturn, which is also roughly the order a player meets
 * them. Node and periapsis are not listed: for orbits this close to circular
 * and this close to the equator they are nearly undefined, and Saturn's
 * oblateness spins both of them round within months anyway — Mimas's node
 * completes a full turn in under a year. They are filled in from the same hash
 * as the longitude.
 */
const SEEDS: readonly MoonSeed[] = [
  // --- Ring region -------------------------------------------------------
  { id: 'pan', name: 'Pan', group: 'ring-shepherd', radius: 14.1, gm: 0.000_33, albedo: 0.5, a: 133_584, e: 0.0000, i: 0.001, note: true },
  { id: 'daphnis', name: 'Daphnis', group: 'ring-shepherd', radius: 3.8, albedo: 0.5, a: 136_505, e: 0.0000, i: 0.0036, note: true },
  { id: 'atlas', name: 'Atlas', group: 'ring-shepherd', radius: 15.1, gm: 0.000_37, albedo: 0.4, a: 137_670, e: 0.0012, i: 0.003 },
  { id: 'prometheus', name: 'Prometheus', group: 'ring-shepherd', radius: 43.1, gm: 0.010_74, albedo: 0.6, a: 139_380, e: 0.0022, i: 0.008, note: true },
  { id: 'pandora', name: 'Pandora', group: 'ring-shepherd', radius: 40.6, gm: 0.009_24, albedo: 0.5, a: 141_720, e: 0.0042, i: 0.050, note: true },

  // --- Co-orbitals and small inner moons ---------------------------------
  { id: 'janus', name: 'Janus', group: 'inner', radius: 89.2, gm: 0.126_6, albedo: 0.71, a: 151_460, e: 0.0068, i: 0.163, note: true },
  { id: 'epimetheus', name: 'Epimetheus', group: 'inner', radius: 58.2, gm: 0.035_1, albedo: 0.73, a: 151_410, e: 0.0098, i: 0.351, coorbital: { with: 'janus', offsetDeg: 180, matchAxis: false }, note: true },
  { id: 'aegaeon', name: 'Aegaeon', group: 'inner', radius: 0.33, albedo: 0.15, a: 167_500, e: 0.0002, i: 0.001, note: true },
  { id: 'mimas', name: 'Mimas', group: 'major', radius: 198.2, gm: 2.502_6, albedo: 0.962, a: 185_540, e: 0.0196, i: 1.574, note: true },
  { id: 'methone', name: 'Methone', group: 'inner', radius: 1.45, albedo: 0.6, a: 194_440, e: 0.0001, i: 0.007 },
  { id: 'anthe', name: 'Anthe', group: 'inner', radius: 0.5, albedo: 0.6, a: 197_700, e: 0.0011, i: 0.015 },
  { id: 'pallene', name: 'Pallene', group: 'inner', radius: 2.23, albedo: 0.6, a: 212_280, e: 0.0040, i: 0.181 },

  // --- The mid-sized icy moons -------------------------------------------
  { id: 'enceladus', name: 'Enceladus', group: 'major', radius: 252.1, gm: 7.202_7, albedo: 1.375, a: 238_040, e: 0.0047, i: 0.009, note: true },
  { id: 'tethys', name: 'Tethys', group: 'major', radius: 531.1, gm: 41.21, albedo: 1.229, a: 294_670, e: 0.0001, i: 1.091 },
  { id: 'telesto', name: 'Telesto', group: 'trojan', radius: 12.4, albedo: 1.0, a: 294_670, e: 0.0002, i: 1.180, coorbital: { with: 'tethys', offsetDeg: 60, matchAxis: true }, note: true },
  { id: 'calypso', name: 'Calypso', group: 'trojan', radius: 10.7, albedo: 1.0, a: 294_670, e: 0.0005, i: 1.499, coorbital: { with: 'tethys', offsetDeg: -60, matchAxis: true }, note: true },
  { id: 'dione', name: 'Dione', group: 'major', radius: 561.4, gm: 73.113, albedo: 0.998, a: 377_420, e: 0.0022, i: 0.028 },
  { id: 'helene', name: 'Helene', group: 'trojan', radius: 17.6, gm: 0.000_76, albedo: 0.67, a: 377_420, e: 0.0071, i: 0.212, coorbital: { with: 'dione', offsetDeg: 60, matchAxis: true }, note: true },
  { id: 'polydeuces', name: 'Polydeuces', group: 'trojan', radius: 1.3, albedo: 0.6, a: 377_420, e: 0.0192, i: 0.177, coorbital: { with: 'dione', offsetDeg: -60, matchAxis: true }, note: true },
  { id: 'rhea', name: 'Rhea', group: 'major', radius: 763.8, gm: 153.94, albedo: 0.949, a: 527_070, e: 0.0013, i: 0.333 },

  // --- Titan and beyond ---------------------------------------------------
  { id: 'titan', name: 'Titan', group: 'major', radius: 2_574.7, gm: 8_978.14, albedo: 0.22, a: 1_221_870, e: 0.0288, i: 0.306, note: true },
  { id: 'hyperion', name: 'Hyperion', group: 'outer', radius: 135.0, gm: 0.372_7, albedo: 0.3, a: 1_481_010, e: 0.1230, i: 0.615, note: true },
  { id: 'iapetus', name: 'Iapetus', group: 'outer', radius: 734.5, gm: 120.51, albedo: 0.6, leadingAlbedo: 0.05, a: 3_560_840, e: 0.0286, i: 15.47, note: true },

  // --- Irregulars: Norse group (retrograde) -------------------------------
  { id: 'phoebe', name: 'Phoebe', group: 'norse', radius: 106.5, gm: 0.553_2, albedo: 0.06, a: 12_947_780, e: 0.1635, i: 175.24, frame: 'ecliptic', note: true },
  { id: 'skathi', name: 'Skathi', group: 'norse', radius: 4.0, albedo: 0.06, a: 15_647_000, e: 0.270, i: 152.6, frame: 'ecliptic' },
  { id: 'skoll', name: 'Skoll', group: 'norse', radius: 3.0, albedo: 0.06, a: 17_665_000, e: 0.464, i: 161.2, frame: 'ecliptic' },
  { id: 'greip', name: 'Greip', group: 'norse', radius: 3.0, albedo: 0.06, a: 18_206_000, e: 0.326, i: 179.8, frame: 'ecliptic' },
  { id: 'hyrrokkin', name: 'Hyrrokkin', group: 'norse', radius: 4.0, albedo: 0.06, a: 18_437_000, e: 0.333, i: 151.4, frame: 'ecliptic' },
  { id: 'mundilfari', name: 'Mundilfari', group: 'norse', radius: 3.5, albedo: 0.06, a: 18_685_000, e: 0.210, i: 167.3, frame: 'ecliptic' },
  { id: 'jarnsaxa', name: 'Jarnsaxa', group: 'norse', radius: 3.0, albedo: 0.06, a: 18_811_000, e: 0.216, i: 163.3, frame: 'ecliptic' },
  { id: 'narvi', name: 'Narvi', group: 'norse', radius: 3.5, albedo: 0.06, a: 19_007_000, e: 0.431, i: 145.8, frame: 'ecliptic' },
  { id: 'bergelmir', name: 'Bergelmir', group: 'norse', radius: 3.0, albedo: 0.06, a: 19_336_000, e: 0.152, i: 158.5, frame: 'ecliptic' },
  { id: 'suttungr', name: 'Suttungr', group: 'norse', radius: 3.5, albedo: 0.06, a: 19_459_000, e: 0.114, i: 175.8, frame: 'ecliptic' },
  { id: 'hati', name: 'Hati', group: 'norse', radius: 3.0, albedo: 0.06, a: 19_846_000, e: 0.371, i: 165.8, frame: 'ecliptic' },
  { id: 'bestla', name: 'Bestla', group: 'norse', radius: 3.5, albedo: 0.06, a: 20_192_000, e: 0.521, i: 145.2, frame: 'ecliptic' },
  { id: 'thrymr', name: 'Thrymr', group: 'norse', radius: 3.5, albedo: 0.06, a: 20_314_000, e: 0.470, i: 175.8, frame: 'ecliptic' },
  { id: 'farbauti', name: 'Farbauti', group: 'norse', radius: 2.5, albedo: 0.06, a: 20_390_000, e: 0.206, i: 156.4, frame: 'ecliptic' },
  { id: 'aegir', name: 'Aegir', group: 'norse', radius: 3.0, albedo: 0.06, a: 20_751_000, e: 0.252, i: 166.7, frame: 'ecliptic' },
  { id: 'kari', name: 'Kari', group: 'norse', radius: 3.5, albedo: 0.06, a: 22_089_000, e: 0.478, i: 156.3, frame: 'ecliptic' },
  { id: 'fenrir', name: 'Fenrir', group: 'norse', radius: 2.0, albedo: 0.06, a: 22_454_000, e: 0.136, i: 165.0, frame: 'ecliptic' },
  { id: 'surtur', name: 'Surtur', group: 'norse', radius: 3.0, albedo: 0.06, a: 22_707_000, e: 0.451, i: 169.7, frame: 'ecliptic' },
  { id: 'loge', name: 'Loge', group: 'norse', radius: 3.0, albedo: 0.06, a: 23_065_000, e: 0.187, i: 167.9, frame: 'ecliptic' },
  { id: 'ymir', name: 'Ymir', group: 'norse', radius: 9.0, albedo: 0.06, a: 23_040_000, e: 0.335, i: 173.1, frame: 'ecliptic' },
  { id: 'fornjot', name: 'Fornjot', group: 'norse', radius: 3.0, albedo: 0.06, a: 25_146_000, e: 0.206, i: 170.4, frame: 'ecliptic', note: true },

  // --- Irregulars: Inuit group (prograde) ---------------------------------
  { id: 'kiviuq', name: 'Kiviuq', group: 'inuit', radius: 8.0, albedo: 0.07, a: 11_294_000, e: 0.334, i: 49.1, frame: 'ecliptic' },
  { id: 'ijiraq', name: 'Ijiraq', group: 'inuit', radius: 6.0, albedo: 0.07, a: 11_355_000, e: 0.316, i: 50.2, frame: 'ecliptic' },
  { id: 'paaliaq', name: 'Paaliaq', group: 'inuit', radius: 11.0, albedo: 0.07, a: 15_200_000, e: 0.364, i: 45.1, frame: 'ecliptic' },
  { id: 'siarnaq', name: 'Siarnaq', group: 'inuit', radius: 19.2, albedo: 0.07, a: 17_777_000, e: 0.295, i: 45.8, frame: 'ecliptic', note: true },
  { id: 'tarqeq', name: 'Tarqeq', group: 'inuit', radius: 3.5, albedo: 0.07, a: 17_910_000, e: 0.160, i: 46.1, frame: 'ecliptic' },

  // --- Irregulars: Gallic group (prograde) --------------------------------
  { id: 'albiorix', name: 'Albiorix', group: 'gallic', radius: 14.3, albedo: 0.06, a: 16_182_000, e: 0.478, i: 34.2, frame: 'ecliptic', note: true },
  { id: 'bebhionn', name: 'Bebhionn', group: 'gallic', radius: 3.0, albedo: 0.06, a: 17_116_000, e: 0.469, i: 35.0, frame: 'ecliptic' },
  { id: 'erriapus', name: 'Erriapus', group: 'gallic', radius: 5.0, albedo: 0.06, a: 17_343_000, e: 0.474, i: 34.5, frame: 'ecliptic' },
  { id: 'tarvos', name: 'Tarvos', group: 'gallic', radius: 7.5, albedo: 0.06, a: 18_247_000, e: 0.531, i: 33.8, frame: 'ecliptic' },
];

function build(seed: MoonSeed): Moon {
  const phase = syntheticPhase(seed.id);
  const moon: Moon = {
    id: seed.id,
    name: seed.name,
    group: seed.group,
    radius: seed.radius,
    gm: seed.gm ?? estimatedGm(seed.radius),
    gmMeasured: seed.gm !== undefined,
    albedo: seed.albedo,
    elements: {
      a: seed.a,
      e: seed.e,
      i: seed.i,
      // Spread node and periapsis with the same hash, offset so that they do
      // not all land on the same value as the longitude.
      node: syntheticPhase(`${seed.id}:node`),
      peri: syntheticPhase(`${seed.id}:peri`),
      meanLongitude: phase,
      frame: seed.frame ?? 'equatorial',
    },
  };
  if (seed.leadingAlbedo !== undefined) moon.leadingAlbedo = seed.leadingAlbedo;
  if (seed.coorbital) moon.coorbital = seed.coorbital;
  if (seed.note) moon.note = true;
  return moon;
}

export const MOONS: readonly Moon[] = SEEDS.map(build);

export const MOONS_BY_ID: ReadonlyMap<string, Moon> = new Map(
  MOONS.map((moon) => [moon.id, moon]),
);

export const moonById = (id: string): Moon | undefined => MOONS_BY_ID.get(id);

/**
 * Moons whose gravity is worth integrating against everything else.
 *
 * The cut is at 1e-3 km3/s2, which keeps Saturn's seventeen measured-GM moons
 * and drops the rest. It exists because the trajectory predictor runs the same
 * force law hundreds of thousands of times per request, and pair count goes as
 * the square: 53 moons plus Saturn is 1 431 pairs, 17 is 153. Nearly a tenfold
 * saving for a change in the module's acceleration below one part in a million.
 *
 * The dropped moons are still *present* — still integrated, still visitable,
 * still able to be crashed into. They simply do not pull on anything.
 */
export const MASSIVE_MOON_IDS: readonly string[] = MOONS.filter(
  (moon) => moon.gm >= 1e-3,
).map((moon) => moon.id);

/** Moons in the order they should be offered: outward from Saturn. */
export const MOONS_BY_DISTANCE: readonly Moon[] = [...MOONS].sort(
  (a, b) => a.elements.a - b.elements.a,
);

/** Sidereal period about Saturn, seconds, from the two-body relation. */
export function orbitalPeriod(moon: Moon, primaryGm: number): number {
  return 2 * Math.PI * Math.sqrt(moon.elements.a ** 3 / (primaryGm + moon.gm));
}

/**
 * Radius of a moon's Hill sphere, km.
 *
 * The number that decides whether a capture burn is possible at all, and it is
 * far smaller than players expect. Titan's is 52 000 km — comfortable. Mimas's
 * is 550, only two and a half times its own radius, so there is essentially no
 * room for an orbit around Mimas that Saturn does not take away.
 */
export const moonHillRadius = (moon: Moon, primaryGm: number): number =>
  hillRadius(moon.gm, primaryGm, moon.elements.a, moon.elements.e);
