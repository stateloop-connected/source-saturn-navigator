/**
 * The frame, in order.
 *
 * Draw order is the whole content of this file, and it is not arbitrary:
 * orbits sit under everything because they are scaffolding; the planet
 * assembly draws its own three layers internally; the field goes over the
 * bodies because it describes the space between them; and the module and its
 * predicted path go last because they are what the player is actually flying.
 */

import { sampleField } from '@saturn/core/field';
import { vec3 } from '@saturn/core/vec';
import type { Store } from '../state/store.js';
import { drawHillSphere, drawModule, drawMoons, type DrawnBody } from './bodies.js';
import { drawPlanetSystem, drawSunArrow } from './planet.js';
import {
  drawFieldGrid,
  drawOrbits,
  drawPrediction,
  drawScaleBar,
  drawTrail,
} from './overlays.js';
import { THEME } from './theme.js';

/**
 * A fixed starfield.
 *
 * Generated once from a seeded sequence and held in screen space, so it does
 * not swim about as the camera pans. It is scenery and makes no claim to be a
 * sky — the real one would need the camera's absolute orientation, and this
 * game's camera is defined relative to Saturn.
 */
let stars: { x: number; y: number; r: number; a: number }[] = [];
let starfieldSize = '';

function ensureStarfield(width: number, height: number): void {
  const key = `${Math.round(width)}x${Math.round(height)}`;
  if (key === starfieldSize) return;
  starfieldSize = key;

  let seed = 0x2f6e2b1;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };

  const count = Math.round((width * height) / 5_200);
  stars = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: random() * width,
      y: random() * height,
      r: 0.3 + random() * random() * 1.1,
      a: 0.16 + random() * 0.5,
    });
  }
}

/** Bodies as they were last drawn, for picking. */
export let lastDrawn: DrawnBody[] = [];

export function drawScene(ctx: CanvasRenderingContext2D, store: Store, now: number): void {
  const { camera, system, overlays } = store;
  const toSun = store.sun.direction;

  ctx.fillStyle = THEME.space;
  ctx.fillRect(0, 0, camera.width, camera.height);

  ensureStarfield(camera.width, camera.height);
  for (const star of stars) {
    ctx.globalAlpha = star.a;
    ctx.fillStyle = '#cfe0f5';
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (overlays.orbits) drawOrbits(ctx, camera, system, store.selection, now);

  drawPlanetSystem(ctx, camera, toSun, overlays.shadows);

  if (overlays.sunArrow) drawSunArrow(ctx, camera, toSun);

  lastDrawn = drawMoons(
    ctx,
    camera,
    system,
    toSun,
    store.selection,
    overlays.moonLabels,
  );

  if (overlays.hillSpheres && store.selectedIndex > 0) {
    drawHillSphere(ctx, camera, system, store.selectedIndex);
  }

  if (overlays.field) {
    const centre =
      store.field.centre ?? store.saturnCentred(store.probe.position);
    const halfWidth = store.field.halfWidth ?? camera.halfWidth * 0.55;

    store.fieldGrid = sampleField(system, {
      centre,
      halfWidth,
      resolution: store.field.resolution,
      mode: store.field.mode,
      referenceIndex: store.selectedIndex,
      u: vec3(1, 0, 0),
      v: vec3(0, 1, 0),
    });
    drawFieldGrid(ctx, camera, store.fieldGrid);
  } else {
    store.fieldGrid = null;
  }

  if (overlays.trail) drawTrail(ctx, camera, store.trail);

  if (overlays.prediction && store.prediction) {
    drawPrediction(ctx, camera, system, store.prediction, store.predictionStale);
  }

  drawModule(
    ctx,
    camera,
    store.saturnCentred(store.probe.position),
    store.probe.velocity,
    store.probe.thrust,
    store.crashed !== null,
  );

  drawScaleBar(ctx, camera);
}
