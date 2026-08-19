/**
 * Everything drawn over the scene that is not a body: orbits, the module's
 * trail, its predicted future, and the gravity field.
 *
 * These are the parts of the display that are *not* photographs. They show
 * quantities rather than objects, so they are drawn in the cool, saturated end
 * of the palette and Saturn is left in the warm end — the player should never
 * have to work out whether a curve on screen is a thing or a fact about a
 * thing.
 */

import { sampleOrbit } from '@saturn/core/elements';
import type { FieldGrid } from '@saturn/core/field';
import type { Prediction } from '@saturn/core/predict';
import type { SaturnSystem } from '@saturn/core/system';
import { splitDuration } from '@saturn/core/time';
import { normalize, vec3, type Vec3 } from '@saturn/core/vec';
import type { Camera } from '../state/camera.js';
import { THEME, fieldColour } from './theme.js';

/** Draw a polyline through world points, skipping anything far off screen. */
function polyline(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  points: readonly Vec3[],
  close = false,
): boolean {
  let started = false;
  let anyVisible = false;

  ctx.beginPath();
  for (const point of points) {
    const projected = camera.project(point);
    // A generous margin: a path that leaves and re-enters must stay connected,
    // or an eccentric orbit is drawn as a set of disconnected arcs.
    if (
      Math.abs(projected.x) > camera.width * 12 ||
      Math.abs(projected.y) > camera.height * 12
    ) {
      started = false;
      continue;
    }
    if (camera.onScreen(projected, 200)) anyVisible = true;
    if (started) ctx.lineTo(projected.x, projected.y);
    else {
      ctx.moveTo(projected.x, projected.y);
      started = true;
    }
  }
  if (close) ctx.closePath();
  return anyVisible;
}

/*
 * Orbit paths are recomputed on a timer rather than every frame.
 *
 * An osculating ellipse is a snapshot of a curve that is itself changing
 * slowly — Mimas's takes months to shift visibly — so recomputing 53 of them
 * at 180 samples each, sixty times a second, would be ten thousand Kepler
 * solves a frame to redraw the same lines. Every 400 ms is indistinguishable
 * and costs nothing.
 */
const ORBIT_CACHE_MS = 400;
let orbitCache: { at: number; paths: Map<number, Vec3[]> } | null = null;

export function drawOrbits(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  system: SaturnSystem,
  selection: string | null,
  now: number,
): void {
  if (!orbitCache || now - orbitCache.at > ORBIT_CACHE_MS) {
    const paths = new Map<number, Vec3[]>();
    for (let index = 1; index < system.count; index++) {
      const orbit = system.orbitOf(index);
      if (!orbit.bound) continue;
      paths.set(index, sampleOrbit(orbit, 160));
    }
    orbitCache = { at: now, paths };
  }

  ctx.lineWidth = 1;
  for (const [index, path] of orbitCache.paths) {
    const moon = system.bodies[index];
    if (!moon) continue;

    const selected = moon.id === selection;
    // An orbit smaller than a few pixels is noise; one larger than the screen
    // by a hundredfold is a straight line across it. Neither helps.
    const spanPx = moon.elements.a * camera.scale;
    if (!selected && (spanPx < 8 || spanPx > camera.width * 60)) continue;

    ctx.strokeStyle = selected
      ? THEME.orbit.selected
      : moon.elements.frame === 'ecliptic'
        ? THEME.orbit.irregular
        : THEME.orbit.regular;
    ctx.lineWidth = selected ? 1.6 : 1;
    if (polyline(ctx, camera, path, true)) ctx.stroke();
  }
}

/** Invalidate the orbit cache — used when the catalogue or system is replaced. */
export const resetOrbitCache = (): void => {
  orbitCache = null;
};

/** The module's own history. */
export function drawTrail(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  trail: readonly Vec3[],
): void {
  if (trail.length < 2) return;
  ctx.strokeStyle = THEME.module.trail;
  ctx.lineWidth = 1.2;
  if (polyline(ctx, camera, trail)) ctx.stroke();
}

/**
 * The predicted path, the moons where they will be, and what it runs into.
 *
 * The ghosts are the part that makes this legible. A curve alone says nothing
 * about whether an encounter happens — the moon it is aimed at will have moved
 * by the time the module arrives. Drawing that moon at its *arrival* position,
 * faintly and with the time on it, turns the overlay from a shape into a plan.
 */
export function drawPrediction(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  system: SaturnSystem,
  prediction: Prediction,
  stale: boolean,
): void {
  const points: Vec3[] = [];
  for (let k = 0; k < prediction.sampleCount; k++) {
    points.push(
      vec3(
        prediction.path[k * 3]!,
        prediction.path[k * 3 + 1]!,
        prediction.path[k * 3 + 2]!,
      ),
    );
  }
  if (points.length < 2) return;

  ctx.save();
  ctx.strokeStyle = stale ? THEME.module.predictionDim : THEME.module.prediction;
  ctx.lineWidth = 1.6;
  ctx.setLineDash(stale ? [3, 5] : []);
  if (polyline(ctx, camera, points)) ctx.stroke();
  ctx.setLineDash([]);

  // Ghost moons: where everything will be at each sampled instant.
  ctx.globalAlpha = 0.9;
  for (const ghost of prediction.ghosts) {
    for (let index = 1; index < system.count; index++) {
      const moon = system.bodies[index];
      if (!moon || moon.radius < 80) continue;

      const position = vec3(
        ghost.positions[index * 3]!,
        ghost.positions[index * 3 + 1]!,
        ghost.positions[index * 3 + 2]!,
      );
      const projected = camera.project(position);
      if (!camera.onScreen(projected, 20)) continue;

      const radiusPx = Math.max(2.5, moon.radius * camera.scale);
      ctx.beginPath();
      ctx.arc(projected.x, projected.y, radiusPx, 0, Math.PI * 2);
      ctx.strokeStyle = THEME.module.ghost;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The module's own ghost, with how far ahead it is.
    const sampleIndex = nearestSample(prediction, ghost.time);
    const modulePoint = points[sampleIndex];
    if (modulePoint) {
      const projected = camera.project(modulePoint);
      if (camera.onScreen(projected, 20)) {
        ctx.beginPath();
        ctx.arc(projected.x, projected.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = THEME.module.prediction;
        ctx.fill();

        const { value, unit } = splitDuration(ghost.time);
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = THEME.module.ghost;
        ctx.textAlign = 'center';
        ctx.fillText(`+${value.toFixed(1)}${unit}`, projected.x, projected.y - 8);
      }
    }
  }
  ctx.globalAlpha = 1;

  if (prediction.impact) {
    const projected = camera.project(prediction.impact.position);
    ctx.beginPath();
    ctx.arc(projected.x, projected.y, 7, 0, Math.PI * 2);
    ctx.strokeStyle = THEME.module.impact;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(projected.x - 5, projected.y - 5);
    ctx.lineTo(projected.x + 5, projected.y + 5);
    ctx.moveTo(projected.x + 5, projected.y - 5);
    ctx.lineTo(projected.x - 5, projected.y + 5);
    ctx.stroke();
  }

  ctx.restore();
}

function nearestSample(prediction: Prediction, time: number): number {
  let best = 0;
  let bestGap = Infinity;
  for (let k = 0; k < prediction.sampleCount; k++) {
    const gap = Math.abs((prediction.times[k] ?? 0) - time);
    if (gap < bestGap) {
      bestGap = gap;
      best = k;
    }
  }
  return best;
}

/**
 * The gravity field, as arrows on a grid.
 *
 * Arrow *colour* carries magnitude and arrow *length* carries it again, but
 * compressed: the field varies by orders of magnitude across a single patch
 * near a moon, and lengths proportional to it would give one visible arrow and
 * a grid of invisible ones. So length runs on a fourth root and colour on a
 * logarithm, and the readout beneath the cursor gives the actual number.
 */
export function drawFieldGrid(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  grid: FieldGrid,
): void {
  if (grid.samples.length === 0) return;

  const spacingPx =
    ((2 * grid.region.halfWidth) / (grid.resolution - 1)) * camera.scale;
  const maxLength = Math.max(4, spacingPx * 0.44);

  const logMin = Math.log10(Math.max(1e-12, grid.minMagnitude));
  const logMax = Math.log10(Math.max(1e-11, grid.maxMagnitude));
  const span = Math.max(1e-6, logMax - logMin);

  ctx.save();
  ctx.lineWidth = 1.4;

  for (const sample of grid.samples) {
    if (sample.inside || sample.magnitude <= 0) continue;

    const base = camera.project(sample.position);
    if (!camera.onScreen(base, 30)) continue;

    const t = (Math.log10(sample.magnitude) - logMin) / span;
    const colour = fieldColour(t);

    // Fourth root keeps the weakest arrows visible without letting the
    // strongest run across the whole patch.
    const length = maxLength * Math.pow(Math.min(1, Math.max(0.02, t)), 0.25);

    const direction = normalize(sample.acceleration);
    const tip = camera.project(
      vec3(
        sample.position.x + direction.x,
        sample.position.y + direction.y,
        sample.position.z + direction.z,
      ),
    );
    const angle = Math.atan2(tip.y - base.y, tip.x - base.x);
    const endX = base.x + Math.cos(angle) * length;
    const endY = base.y + Math.sin(angle) * length;

    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    const head = Math.min(5, length * 0.42);
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - head * Math.cos(angle - 0.5), endY - head * Math.sin(angle - 0.5));
    ctx.lineTo(endX - head * Math.cos(angle + 0.5), endY - head * Math.sin(angle + 0.5));
    ctx.closePath();
    ctx.fill();
  }

  // Frame the sampled patch so it is clear where the overlay stops applying.
  const corners: Vec3[] = [];
  const { centre, halfWidth } = grid.region;
  for (const [su, sv] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    corners.push(
      vec3(
        centre.x + (grid.u.x * su + grid.v.x * sv) * halfWidth,
        centre.y + (grid.u.y * su + grid.v.y * sv) * halfWidth,
        centre.z + (grid.u.z * su + grid.v.z * sv) * halfWidth,
      ),
    );
  }
  ctx.strokeStyle = THEME.rule;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  polyline(ctx, camera, corners, true);
  ctx.stroke();
  ctx.restore();
}

/**
 * A scale bar, because an orthographic view has exactly one and it is worth
 * stating.
 *
 * Snapped to a 1-2-5 sequence so the number is always round, which is what
 * makes it readable at a glance across seven decades of zoom.
 */
export function drawScaleBar(ctx: CanvasRenderingContext2D, camera: Camera): void {
  const targetPx = Math.min(220, camera.width * 0.22);
  const rawKm = targetPx / camera.scale;

  const magnitude = Math.pow(10, Math.floor(Math.log10(rawKm)));
  const normalised = rawKm / magnitude;
  const step = normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1;
  const km = step * magnitude;
  const widthPx = km * camera.scale;

  const x = 20;
  const y = camera.height - 26;

  ctx.save();
  ctx.strokeStyle = THEME.ruleStrong;
  ctx.fillStyle = THEME.hud.text;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y);
  ctx.lineTo(x + widthPx, y);
  ctx.lineTo(x + widthPx, y - 5);
  ctx.stroke();

  const label =
    km >= 1e6
      ? `${(km / 1e6).toFixed(km / 1e6 >= 10 ? 0 : 1)} mil. km`
      : km >= 1
        ? `${km.toLocaleString('cs-CZ')} km`
        : `${(km * 1000).toFixed(0)} m`;

  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, x, y - 8);
  ctx.restore();
}
