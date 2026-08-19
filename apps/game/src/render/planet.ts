/**
 * Saturn and the rings.
 *
 * ## Draw order
 *
 * The rings pass behind the planet and in front of it, so they cannot be one
 * layer. A point of the ring plane is nearer the viewer when its view-space
 * depth is positive, which for a plane through the origin means simply: the
 * half of the rings below Saturn's centre on screen is in front, the half above
 * is behind. Splitting on that line and drawing far rings, globe, near rings
 * gives the arrangement everybody recognises from a photograph, and costs two
 * clip rectangles.
 *
 * ## Shading
 *
 * Above a certain apparent size Saturn is shaded from real geometry: a grid of
 * samples across the disc, each one inverted back onto the spheroid to get a
 * surface point, a normal, a Lambert term, and the optical depth of whatever
 * ring lies between that point and the Sun. That last part is what draws the
 * ring shadows across the globe, and it comes out of the same function the
 * physics uses rather than being faked with stripes.
 *
 * Below that size the grid would cost more than it shows, and a two-stop
 * gradient with the classical terminator is used instead.
 *
 * ## Saturn's shadow on the rings
 *
 * An exact construction rather than an approximation, because it is cheap. The
 * shadow is an elliptical cylinder — Saturn's silhouette, swept anti-sunward —
 * and a cylinder cut by the ring plane is a conic. Tracing the silhouette and
 * projecting each point down the sunlight to z = 0 gives the shadow's outline
 * directly, which is why the wedge narrows and lengthens correctly as the
 * seasons change the Sun's elevation.
 */

import {
  RING_BANDS,
  SATURN_EQUATORIAL_RADIUS,
  SATURN_POLAR_RADIUS,
  MAIN_RING_OUTER,
} from '@saturn/core/saturn';
import { ringShadowDepth, transmission, ringLighting } from '@saturn/core/illumination';
import { cross, dot, normalize, scale, sub, vec3, type Vec3 } from '@saturn/core/vec';
import type { Camera } from '../state/camera.js';
import { THEME } from './theme.js';
import {
  cameraBasis,
  fillLitDisc,
  screenAngleOf,
  spheroidNormal,
  spheroidSurfacePoint,
} from './shading.js';

/** Apparent semi-axes of Saturn's silhouette, in pixels. */
export function saturnScreenRadii(camera: Camera): { rx: number; ry: number } {
  const scalePx = camera.scale;
  const cosTilt = Math.cos(camera.tilt);
  const sinTilt = Math.sin(camera.tilt);
  return {
    rx: SATURN_EQUATORIAL_RADIUS * scalePx,
    ry:
      Math.sqrt(
        SATURN_EQUATORIAL_RADIUS ** 2 * cosTilt * cosTilt +
          SATURN_POLAR_RADIUS ** 2 * sinTilt * sinTilt,
      ) * scalePx,
  };
}

/**
 * The outline of Saturn's shadow where it falls on the ring plane.
 *
 * Returns the polygon in Saturn-centred world coordinates, or null when the Sun
 * is so nearly in the ring plane that the shadow runs off to infinity — which
 * happens at Saturn's equinoxes, and at which point the rings are edge-on and
 * invisible anyway.
 */
export function ringShadowOutline(toSun: Vec3, samples = 48): Vec3[] | null {
  const elevation = toSun.z;
  if (Math.abs(elevation) < 0.02) return null;

  // Basis on Saturn's silhouette as seen from the Sun.
  const poleComponent = elevation;
  const northRaw = sub(vec3(0, 0, 1), scale(toSun, poleComponent));
  const northLength = Math.hypot(northRaw.x, northRaw.y, northRaw.z);
  if (northLength < 1e-9) return null;
  const north = scale(northRaw, 1 / northLength);
  const east = cross(toSun, north);

  const sinLatitude = Math.min(1, Math.abs(poleComponent));
  const cosLatitude = Math.sqrt(1 - sinLatitude * sinLatitude);
  const shortAxis = Math.sqrt(
    SATURN_EQUATORIAL_RADIUS ** 2 * sinLatitude ** 2 +
      SATURN_POLAR_RADIUS ** 2 * cosLatitude ** 2,
  );

  const limit = MAIN_RING_OUTER * 3;
  const outline: Vec3[] = [];

  for (let k = 0; k <= samples; k++) {
    const phi = -Math.PI / 2 + (Math.PI * k) / samples;
    const boundary = vec3(
      shortAxis * Math.cos(phi) * north.x + SATURN_EQUATORIAL_RADIUS * Math.sin(phi) * east.x,
      shortAxis * Math.cos(phi) * north.y + SATURN_EQUATORIAL_RADIUS * Math.sin(phi) * east.y,
      shortAxis * Math.cos(phi) * north.z,
    );

    // Slide down the sunlight to the ring plane. `east.z` is identically zero,
    // so only the north term contributes to the height.
    const t = boundary.z / elevation;
    if (t < 0) continue;

    const point = vec3(
      boundary.x - t * toSun.x,
      boundary.y - t * toSun.y,
      0,
    );
    const radius = Math.hypot(point.x, point.y);
    outline.push(radius > limit ? scale(point, limit / radius) : point);
  }

  return outline.length > 2 ? outline : null;
}

function pathThrough(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  points: readonly Vec3[],
): void {
  ctx.beginPath();
  points.forEach((point, index) => {
    const projected = camera.project(point);
    if (index === 0) ctx.moveTo(projected.x, projected.y);
    else ctx.lineTo(projected.x, projected.y);
  });
  ctx.closePath();
}

/** One ring band as an elliptical annulus, in screen space. */
function ringAnnulus(
  ctx: CanvasRenderingContext2D,
  centreX: number,
  centreY: number,
  scalePx: number,
  squash: number,
  inner: number,
  outer: number,
): void {
  ctx.beginPath();
  ctx.ellipse(centreX, centreY, outer * scalePx, outer * scalePx * squash, 0, 0, Math.PI * 2);
  ctx.ellipse(
    centreX,
    centreY,
    inner * scalePx,
    inner * scalePx * squash,
    0,
    0,
    Math.PI * 2,
    true,
  );
}

export interface RingDrawOptions {
  shadows: boolean;
}

/**
 * Draw one half of the ring system, split at Saturn's centre line.
 *
 * `half` selects which side of that line survives the clip: `far` is the part
 * that passes behind the globe, `near` the part in front of it.
 */
export function drawRings(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  toSun: Vec3,
  half: 'far' | 'near',
  options: RingDrawOptions,
): void {
  const centre = camera.project(vec3(0, 0, 0));
  const squash = Math.abs(camera.ringSquash);
  const scalePx = camera.scale;

  // Nothing to see when the rings are within a pixel of edge-on.
  if (MAIN_RING_OUTER * scalePx * squash < 0.5 && squash < 0.02) return;

  const lighting = ringLighting(toSun, camera.viewDirection());

  /*
   * Which half of the screen holds the near half of the rings.
   *
   * A ring-plane point is nearer the viewer when its view-space depth is
   * positive, and for a plane through the origin that reduces to a question of
   * which side of Saturn's centre line it falls on. But the answer *inverts*
   * once the camera passes through the ring plane: seen from below, the near
   * half is the upper one. Getting this wrong does not look like an error, it
   * looks like Saturn floating in front of its own rings.
   */
  const frontIsBelow = Math.cos(camera.tilt) > 0;
  const clipAbove = (half === 'far') === frontIsBelow;

  ctx.save();
  ctx.beginPath();
  if (clipAbove) {
    ctx.rect(0, 0, camera.width, Math.max(0, centre.y));
  } else {
    ctx.rect(0, Math.max(0, centre.y), camera.width, camera.height);
  }
  ctx.clip();

  for (const band of RING_BANDS) {
    const colour = THEME.rings[band.id];
    if (!colour) continue;
    // Sub-pixel bands would alias into a moire pattern; skip them.
    if ((band.outer - band.inner) * scalePx < 0.35 && band.id !== 'F') continue;

    ctx.globalAlpha = Math.min(1, Math.max(0.03, lighting.brightness));
    ctx.fillStyle = colour;
    ringAnnulus(ctx, centre.x, centre.y, scalePx, squash, band.inner, band.outer);
    ctx.fill('evenodd');
  }
  ctx.globalAlpha = 1;

  if (options.shadows) {
    const outline = ringShadowOutline(toSun);
    if (outline) {
      ctx.save();
      // Confine the shadow to the rings themselves.
      ringAnnulus(ctx, centre.x, centre.y, scalePx, squash, 66_900, MAIN_RING_OUTER);
      ctx.clip('evenodd');
      pathThrough(ctx, camera, outline);
      ctx.fillStyle = 'rgba(4, 6, 12, 0.88)';
      ctx.fill();
      ctx.restore();
    }
  }

  ctx.restore();
}

/**
 * Shade the globe from real surface geometry.
 *
 * One sample per cell of a square grid across the silhouette: invert to a
 * surface point, take the normal, apply Lambert, and multiply by how much
 * sunlight survived the rings on the way in. Cells are drawn a shade larger
 * than their spacing so that rounding never leaves seams between them.
 */
function shadeGlobeFromGeometry(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  toSun: Vec3,
  centreX: number,
  centreY: number,
  radiusPx: number,
): void {
  const basis = cameraBasis(camera.azimuth, camera.tilt);
  const cells = Math.max(24, Math.min(110, Math.round(radiusPx / 2.2)));
  const stepPx = (2 * radiusPx) / cells;
  const perPixelKm = 1 / camera.scale;

  for (let row = 0; row <= cells; row++) {
    for (let column = 0; column <= cells; column++) {
      const offsetX = -radiusPx + column * stepPx;
      const offsetY = -radiusPx + row * stepPx;

      const point = spheroidSurfacePoint(
        offsetX * perPixelKm,
        -offsetY * perPixelKm,
        basis,
        SATURN_EQUATORIAL_RADIUS,
        SATURN_POLAR_RADIUS,
      );
      if (!point) continue;

      const normal = spheroidNormal(point, SATURN_EQUATORIAL_RADIUS, SATURN_POLAR_RADIUS);
      const lambert = Math.max(0, dot(normal, toSun));

      // Latitude picks the band colour; the poles are the coolest tone.
      const latitude = Math.abs(point.z) / SATURN_POLAR_RADIUS;
      const bands = THEME.saturn.bands;
      const tint = bands[Math.min(bands.length - 1, Math.floor(latitude * bands.length))]!;

      const throughRings = transmission(ringShadowDepth(point, toSun));
      const brightness = 0.045 + 0.955 * lambert * throughRings;

      ctx.globalAlpha = 1;
      ctx.fillStyle = tint;
      ctx.globalAlpha = Math.min(1, brightness);
      ctx.fillRect(
        centreX + offsetX - stepPx * 0.05,
        centreY + offsetY - stepPx * 0.05,
        stepPx * 1.1,
        stepPx * 1.1,
      );
    }
  }
  ctx.globalAlpha = 1;
}

/** Draw the globe: silhouette, shading, limb. */
export function drawSaturn(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  toSun: Vec3,
  shadows: boolean,
): void {
  const centre = camera.project(vec3(0, 0, 0));
  const { rx, ry } = saturnScreenRadii(camera);
  if (rx < 0.4) return;

  const silhouette = (): void => {
    ctx.beginPath();
    ctx.ellipse(centre.x, centre.y, rx, ry, 0, 0, Math.PI * 2);
  };

  // Night side first, so anything the shading does not cover reads as dark
  // rather than as a hole in the scene.
  silhouette();
  ctx.fillStyle = THEME.saturn.night;
  ctx.fill();

  ctx.save();
  silhouette();
  ctx.clip();

  const detailed = shadows && rx > 26;
  if (detailed) {
    shadeGlobeFromGeometry(ctx, camera, toSun, centre.x, centre.y, Math.max(rx, ry));
  } else {
    // Small on screen: the classical phase construction with a banded fill.
    const view = camera.viewDirection();
    const cosPhase = dot(normalize(toSun), view);
    const brightAngle = screenAngleOf(toSun, camera.azimuth, camera.tilt);

    const gradient = ctx.createLinearGradient(
      centre.x,
      centre.y - ry,
      centre.x,
      centre.y + ry,
    );
    const bands = THEME.saturn.bands;
    bands.forEach((colour, index) => {
      // Mirrored about the equator: pole, mid, equator, mid, pole.
      const t = index / (bands.length - 1);
      gradient.addColorStop(t * 0.5, colour);
      gradient.addColorStop(1 - t * 0.5, colour);
    });

    fillLitDisc(ctx, centre.x, centre.y, rx, ry, brightAngle, cosPhase, gradient);
  }

  ctx.restore();

  // Limb, to keep the planet from bleeding into the background.
  silhouette();
  ctx.strokeStyle = THEME.saturn.limb;
  ctx.lineWidth = Math.min(1.5, Math.max(0.4, rx * 0.006));
  ctx.stroke();
}

/**
 * The whole planet-and-rings assembly, in the right order.
 *
 * Kept as one call because the ordering is the point: anything that draws the
 * globe without the far rings behind it and the near rings over it gets a
 * Saturn that reads as a sticker.
 */
export function drawPlanetSystem(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  toSun: Vec3,
  shadows: boolean,
): void {
  drawRings(ctx, camera, toSun, 'far', { shadows });
  drawSaturn(ctx, camera, toSun, shadows);
  drawRings(ctx, camera, toSun, 'near', { shadows });
}

/** Where the Sun is, drawn as an arrow from Saturn out past the rings. */
export function drawSunArrow(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  toSun: Vec3,
): void {
  const reach = Math.min(camera.halfWidth * 0.82, MAIN_RING_OUTER * 14);
  const tip = camera.project(scale(toSun, reach));
  const base = camera.project(scale(toSun, reach * 0.72));

  ctx.save();
  ctx.strokeStyle = THEME.sun;
  ctx.fillStyle = THEME.sun;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1.4;
  ctx.setLineDash([7, 6]);

  const origin = camera.project(vec3(0, 0, 0));
  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Arrowhead, oriented along the projected direction.
  const angle = Math.atan2(tip.y - base.y, tip.x - base.x);
  const size = 9;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(
    tip.x - size * Math.cos(angle - 0.4),
    tip.y - size * Math.sin(angle - 0.4),
  );
  ctx.lineTo(
    tip.x - size * Math.cos(angle + 0.4),
    tip.y - size * Math.sin(angle + 0.4),
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
