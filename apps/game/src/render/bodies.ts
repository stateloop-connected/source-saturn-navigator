/**
 * The moons, and the module.
 *
 * Almost every moon is far too small to draw at its true size — Daphnis is 4 km
 * across on a view 800 000 km wide, which is a millionth of a pixel — so each
 * gets a floor on its apparent radius. That is a lie, and an unavoidable one:
 * the alternative is a screen with Titan on it and nothing else.
 *
 * The lie is confined as tightly as it can be. The floor applies only to the
 * *drawn* radius, never to anything the physics reads; a moon drawn as three
 * pixels still has its real radius for collision, its real Hill sphere, and its
 * real disc the moment the player zooms in far enough for the true size to
 * exceed the floor. And the marker changes shape at that point, so it is
 * visible when a moon has stopped being a symbol and started being an object.
 */

import { moonById, type Moon } from '@saturn/core/moons';
import {
  apparentBrightness,
  illuminationOf,
  inSaturnShadow,
  twoFacedAlbedo,
} from '@saturn/core/illumination';
import { SATURN_INDEX, type SaturnSystem } from '@saturn/core/system';
import { moonHillRadius } from '@saturn/core/moons';
import { SATURN_GM } from '@saturn/core/saturn';
import { normalize, scale, sub, vec3, type Vec3 } from '@saturn/core/vec';
import type { Camera } from '../state/camera.js';
import { THEME, mix } from './theme.js';
import { fillLitDisc, screenAngleOf } from './shading.js';

/** Smallest a moon is ever drawn, in pixels. */
const MINIMUM_RADIUS = 1.6;

/** Above this apparent radius a moon is drawn as a lit sphere, not a dot. */
const DISC_THRESHOLD = 3.5;

export interface DrawnBody {
  index: number;
  moon: Moon;
  screenX: number;
  screenY: number;
  radiusPx: number;
  depth: number;
}

/**
 * Draw every moon, and report where each one landed.
 *
 * The returned list is what picking uses: clicking the scene finds the nearest
 * entry in screen space, which is the only way selection can agree with what
 * the player sees when the drawn size and the true size differ.
 */
export function drawMoons(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  system: SaturnSystem,
  toSun: Vec3,
  selection: string | null,
  showLabels: boolean,
): DrawnBody[] {
  const view = camera.viewDirection();
  const drawn: DrawnBody[] = [];

  for (let index = 1; index < system.count; index++) {
    const moon = system.bodies[index];
    if (!moon) continue;

    const position = system.saturnCentred(index);
    const projected = camera.project(position);
    if (!camera.onScreen(projected, 40)) continue;

    const trueRadiusPx = moon.radius * camera.scale;
    const radiusPx = Math.max(MINIMUM_RADIUS, trueRadiusPx);

    drawn.push({
      index,
      moon,
      screenX: projected.x,
      screenY: projected.y,
      radiusPx,
      depth: projected.depth,
    });
  }

  // Far ones first, so a moon in front covers one behind rather than the other
  // way round. Matters at close range, where two moons can overlap.
  drawn.sort((a, b) => a.depth - b.depth);

  for (const entry of drawn) {
    drawMoon(ctx, camera, system, entry, toSun, view, entry.moon.id === selection);
  }

  if (showLabels) {
    for (const entry of drawn) drawLabel(ctx, entry, selection);
  }

  return drawn;
}

function drawMoon(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  system: SaturnSystem,
  entry: DrawnBody,
  toSun: Vec3,
  view: Vec3,
  selected: boolean,
): void {
  const { moon, screenX, screenY, radiusPx } = entry;
  const position = system.saturnCentred(entry.index);

  const eclipsed = inSaturnShadow(position, toSun);
  const illumination = illuminationOf(toSun, view, eclipsed);

  // Iapetus is two moons' worth of albedo on one body, and which one you see
  // depends on which way it is going.
  const albedo =
    moon.leadingAlbedo === undefined
      ? moon.albedo
      : twoFacedAlbedo(
          moon.albedo,
          moon.leadingAlbedo,
          scale(view, -1),
          sub(system.velocityOf(entry.index), system.velocityOf(SATURN_INDEX)),
        );

  const brightness = Math.min(1, apparentBrightness(albedo, illumination));

  if (radiusPx < DISC_THRESHOLD) {
    // A symbol, not an object: a flat dot whose brightness still carries the
    // phase, so the inner moons visibly dim as they swing round the far side.
    ctx.beginPath();
    ctx.arc(screenX, screenY, radiusPx, 0, Math.PI * 2);
    ctx.fillStyle = eclipsed
      ? THEME.moon.dark
      : mix(THEME.moon.dark, THEME.moon.lit, 0.25 + 0.75 * brightness);
    ctx.fill();
  } else {
    // Large enough to be a body: draw the unlit disc, then the lit part over it.
    ctx.beginPath();
    ctx.arc(screenX, screenY, radiusPx, 0, Math.PI * 2);
    ctx.fillStyle = THEME.moon.dark;
    ctx.fill();

    if (!eclipsed && illumination.fraction > 0.002) {
      const brightAngle = screenAngleOf(
        illumination.brightLimb,
        camera.azimuth,
        camera.tilt,
      );
      fillLitDisc(
        ctx,
        screenX,
        screenY,
        radiusPx,
        radiusPx,
        brightAngle,
        Math.cos(illumination.phaseAngle),
        mix(THEME.moon.dim, THEME.moon.lit, Math.min(1, albedo)),
      );
    }
  }

  if (selected) {
    ctx.beginPath();
    ctx.arc(screenX, screenY, radiusPx + 5, 0, Math.PI * 2);
    ctx.strokeStyle = THEME.moon.selected;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
}

/**
 * Labels, thinned by importance so a wide view is not a wall of text.
 *
 * At full zoom-out there are 53 moons within a few hundred pixels of each
 * other. Everything below Mimas's size is dropped unless it is selected or the
 * view is close enough for the name to belong to something the player can see.
 */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  entry: DrawnBody,
  selection: string | null,
): void {
  const selected = entry.moon.id === selection;
  const notable = entry.moon.radius > 100 || entry.radiusPx > 4;
  if (!selected && !notable) return;

  ctx.font = selected
    ? '600 12px ui-sans-serif, system-ui, sans-serif'
    : '11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = selected ? THEME.moon.selected : THEME.moon.label;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(entry.moon.name, entry.screenX + entry.radiusPx + 6, entry.screenY);
}

/**
 * The Hill sphere of the selected body.
 *
 * Drawn as a circle in the ring plane, which is a simplification of a sphere
 * but the right one here — the interesting question is always whether an orbit
 * fits inside it, and orbits are nearly in that plane. Worth having on screen
 * because the radii are so much smaller than players expect: Mimas's is barely
 * twice its own body.
 */
export function drawHillSphere(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  system: SaturnSystem,
  index: number,
): void {
  const moon = system.bodies[index];
  if (!moon) return;

  const radius = moonHillRadius(moon, SATURN_GM);
  const centre = system.saturnCentred(index);
  const projected = camera.project(centre);
  const radiusPx = radius * camera.scale;
  if (radiusPx < 6 || radiusPx > 6_000) return;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(
    projected.x,
    projected.y,
    radiusPx,
    radiusPx * Math.abs(camera.ringSquash),
    0,
    0,
    Math.PI * 2,
  );
  ctx.strokeStyle = THEME.orbit.hill;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 5]);
  ctx.stroke();
  ctx.restore();
}

/**
 * The module.
 *
 * Always drawn at a fixed size, because it is a marker rather than a body — a
 * few metres of spacecraft has no apparent size at any zoom this game offers,
 * and pretending otherwise would make it invisible.
 */
export function drawModule(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  position: Vec3,
  velocity: Vec3,
  thrust: Vec3,
  crashed: boolean,
): void {
  const projected = camera.project(position);

  // A chevron pointing along the direction of travel: the player's heading is
  // the one thing about the module that is worth reading at a glance.
  const ahead = camera.project(vec3(
    position.x + velocity.x,
    position.y + velocity.y,
    position.z + velocity.z,
  ));
  const angle = Math.atan2(ahead.y - projected.y, ahead.x - projected.x);

  ctx.save();
  ctx.translate(projected.x, projected.y);

  // Thrust plume, drawn behind and opposite the acceleration.
  const thrustMagnitude = Math.hypot(thrust.x, thrust.y, thrust.z);
  if (thrustMagnitude > 0) {
    const direction = normalize(thrust);
    const plumeAngle = screenAngleOf(direction, camera.azimuth, camera.tilt);
    ctx.save();
    ctx.rotate(plumeAngle);
    const gradient = ctx.createLinearGradient(-6, 0, -22, 0);
    gradient.addColorStop(0, THEME.module.thrust);
    gradient.addColorStop(1, 'rgba(255, 209, 102, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(-5, -3.5);
    ctx.lineTo(-22, 0);
    ctx.lineTo(-5, 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.lineTo(-5, -5);
  ctx.lineTo(-2, 0);
  ctx.lineTo(-5, 5);
  ctx.closePath();
  ctx.fillStyle = crashed ? THEME.module.impact : THEME.module.body;
  ctx.fill();
  ctx.restore();

  if (crashed) {
    ctx.beginPath();
    ctx.arc(projected.x, projected.y, 12, 0, Math.PI * 2);
    ctx.strokeStyle = THEME.module.impact;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
}

/** Look up a moon for the UI without reaching into the system. */
export const nameOf = (id: string): string => moonById(id)?.name ?? id;
