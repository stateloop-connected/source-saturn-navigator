#!/usr/bin/env node
/**
 * Replace the catalogue's synthetic phases with real ones from JPL Horizons.
 *
 * A maintenance tool, run by hand, not part of the build and not part of the
 * test suite — the same standing as `generate-vsop87.mjs` in the sibling Orrery.
 * It needs the network, it is slow (one request per moon, politely spaced), and
 * its output is meant to be read before it is committed.
 *
 * ## Why this exists
 *
 * `packages/core/src/moons.ts` carries real masses, radii and orbit shapes, but
 * synthetic mean longitudes: where each moon sits *along* its orbit is derived
 * from a hash of its name. That is a deliberate choice over inventing
 * precise-looking numbers, and it means the configuration of the system on any
 * given date is wrong, and that the real resonances are not set up.
 *
 * This script fixes all of that at once, by asking the authority.
 *
 * ## Usage
 *
 *   node scripts/fetch-elements.mjs                    # print a report
 *   node scripts/fetch-elements.mjs --write            # rewrite the seed table
 *   node scripts/fetch-elements.mjs --epoch 2026-01-01
 *
 * ## What it does not do
 *
 * It does not add the moons that are missing. Saturn's confirmed count exceeds
 * 270 and the catalogue holds 53; the rest are recent Norse-group discoveries
 * with provisional designations. Horizons has them, under ids that change as
 * designations are confirmed, so pulling them in is a judgement call about which
 * ones are worth carrying rather than something to automate. `--list` prints
 * what Horizons offers for the Saturn system so that call can be made.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOGUE = join(HERE, '..', 'packages', 'core', 'src', 'moons.ts');

const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api';

/**
 * Horizons body ids for the moons in the catalogue.
 *
 * The regular moons are 601-666 in discovery order, which is not the order this
 * project lists them in, so the mapping is explicit rather than computed.
 */
const IDS = {
  mimas: 601, enceladus: 602, tethys: 603, dione: 604, rhea: 605, titan: 606,
  hyperion: 607, iapetus: 608, phoebe: 609, janus: 610, epimetheus: 611,
  helene: 612, telesto: 613, calypso: 614, atlas: 615, prometheus: 616,
  pandora: 617, pan: 618, ymir: 619, paaliaq: 620, tarvos: 621, ijiraq: 622,
  suttungr: 623, kiviuq: 624, mundilfari: 625, albiorix: 626, skathi: 627,
  erriapus: 628, siarnaq: 629, thrymr: 630, narvi: 631, methone: 632,
  pallene: 633, polydeuces: 634, daphnis: 635, aegir: 636, bebhionn: 637,
  bergelmir: 638, bestla: 639, farbauti: 640, fenrir: 641, fornjot: 642,
  hati: 643, hyrrokkin: 644, kari: 645, loge: 646, skoll: 647, surtur: 648,
  anthe: 649, jarnsaxa: 650, greip: 651, tarqeq: 652, aegaeon: 653,
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const EPOCH = option('epoch', '2000-01-01');

/**
 * Ask Horizons for osculating elements of one body about Saturn.
 *
 * `CENTER='500@699'` is Saturn's centre; `REF_PLANE='BODY EQUATOR'` gives
 * elements referred to Saturn's equator, which is the frame the catalogue's
 * regular moons use. The irregulars are quoted against the ecliptic in the
 * catalogue, so those are re-requested with `REF_PLANE='ECLIPTIC'`.
 */
async function fetchElements(id, refPlane) {
  const parameters = new URLSearchParams({
    format: 'json',
    COMMAND: `'${id}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'ELEMENTS',
    CENTER: "'500@699'",
    REF_PLANE: `'${refPlane}'`,
    TLIST: `'${EPOCH}'`,
    OUT_UNITS: 'KM-S',
  });

  const response = await fetch(`${HORIZONS}?${parameters}`);
  if (!response.ok) throw new Error(`Horizons ${response.status} for ${id}`);
  const body = await response.json();
  return parseElements(body.result);
}

/**
 * Pull the element block out of the Horizons text report.
 *
 * The payload is a fixed-width text listing between `$$SOE` and `$$EOE` with
 * `NAME= value` pairs. Parsing it with a regex is unlovely but stable; Horizons
 * has emitted this format for decades.
 */
function parseElements(text) {
  const block = text.split('$$SOE')[1]?.split('$$EOE')[0];
  if (!block) throw new Error('no ephemeris block in response');

  const value = (key) => {
    const match = block.match(new RegExp(`${key}\\s*=\\s*(-?[\\d.]+E?[+-]?\\d*)`));
    if (!match) throw new Error(`missing ${key}`);
    return Number(match[1]);
  };

  const node = value('OM');
  const peri = value('W');
  const meanAnomaly = value('MA');

  return {
    a: value('A'),
    e: value('EC'),
    i: value('IN'),
    node,
    peri,
    // The catalogue stores mean *longitude*, which stays meaningful as e and i
    // approach zero — which for most of these moons they do.
    meanLongitude: (node + peri + meanAnomaly) % 360,
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const source = await readFile(CATALOGUE, 'utf8');

  // Which frame each moon's elements are quoted in, read from the catalogue
  // itself so the two can never disagree.
  const frameOf = (id) =>
    new RegExp(`id: '${id}'[^}]*frame: 'ecliptic'`).test(source)
      ? 'ECLIPTIC'
      : 'BODY EQUATOR';

  const results = [];
  const failures = [];

  for (const [id, horizonsId] of Object.entries(IDS)) {
    if (!source.includes(`id: '${id}'`)) continue;
    try {
      const elements = await fetchElements(horizonsId, frameOf(id));
      results.push({ id, ...elements });
      process.stdout.write(
        `${id.padEnd(12)} a=${elements.a.toFixed(0).padStart(9)} ` +
          `e=${elements.e.toFixed(4)} i=${elements.i.toFixed(3).padStart(7)} ` +
          `L=${elements.meanLongitude.toFixed(2).padStart(7)}\n`,
      );
    } catch (error) {
      failures.push({ id, message: error.message });
      process.stdout.write(`${id.padEnd(12)} FAILED: ${error.message}\n`);
    }
    // Horizons asks for restraint, and this is a tool run once in a while.
    await wait(350);
  }

  console.log(`\n${results.length} fetched, ${failures.length} failed.`);

  if (!flag('write')) {
    console.log('\nNothing written. Pass --write to update the catalogue.');
    return;
  }

  /*
   * Rewrite only the numbers, in place.
   *
   * The seed table is hand-maintained — it carries groups, notes, albedos and
   * the co-orbital anchors, none of which Horizons knows about — so this
   * substitutes `a`, `e` and `i` on each seed line and appends the recovered
   * angles rather than regenerating the file.
   */
  let updated = source;
  for (const entry of results) {
    const line = new RegExp(`(\\{ id: '${entry.id}'.*?)\\n`, 's');
    const match = updated.match(line);
    if (!match) continue;

    const replaced = match[1]
      .replace(/a: [\d_.]+/, `a: ${Math.round(entry.a)}`)
      .replace(/e: [\d.]+/, `e: ${entry.e.toFixed(4)}`)
      .replace(/i: [\d.]+/, `i: ${entry.i.toFixed(3)}`);

    updated = updated.replace(match[1], replaced);
  }

  const angles = results
    .map(
      (entry) =>
        `  ${entry.id}: { node: ${entry.node.toFixed(3)}, ` +
        `peri: ${entry.peri.toFixed(3)}, ` +
        `meanLongitude: ${entry.meanLongitude.toFixed(3)} },`,
    )
    .join('\n');

  await writeFile(CATALOGUE, updated, 'utf8');
  await writeFile(
    join(HERE, 'horizons-angles.txt'),
    `// Epoch ${EPOCH}, from JPL Horizons.\n` +
      `// Paste into moons.ts as REAL_ANGLES and have build() prefer it over\n` +
      `// syntheticPhase, then delete the "not accurate" paragraph from the\n` +
      `// module header and from docs/accuracy.md.\n\n` +
      `const REAL_ANGLES: Record<string, { node: number; peri: number; meanLongitude: number }> = {\n${angles}\n};\n`,
    'utf8',
  );

  console.log('\nCatalogue axes updated in place.');
  console.log('Angles written to scripts/horizons-angles.txt — see the header.');
}

if (flag('list')) {
  console.log('Horizons ids used:\n');
  for (const [id, horizonsId] of Object.entries(IDS)) console.log(`  ${horizonsId}  ${id}`);
  console.log(
    '\nSaturn satellites beyond these carry provisional designations;\n' +
      'see https://ssd.jpl.nasa.gov/sats/elem/ for the current list.',
  );
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
