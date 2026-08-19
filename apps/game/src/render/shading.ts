/**
 * Lighting geometry that both Saturn and the moons need.
 *
 * Two things live here. One is the classical phase construction — a lit region
 * bounded by a semicircle and half an ellipse — which is how every body from
 * Mimas to Saturn gets its terminator. The other is the inverse projection onto
 * a spheroid, which is what lets Saturn be shaded from real surface normals
 * rather than with a gradient that merely looks like shading.
 */

import { rotateX, rotateZ, vec3, type Vec3 } from '@saturn/core/vec';

/**
 * Fill the lit part of a disc.
 *
 * Drawn in a unit circle and then scaled, so the same code serves a circular
 * moon and an oblate Saturn squashed further by the camera tilt.
 *
 * `cosPhase` is the cosine of the Sun-body-viewer angle: +1 full, 0 half, -1
 * new. The terminator is the half-ellipse through (-cosPhase, 0), which lands
 * on the anti-sunward limb at full, through the centre at half, and on the
 * sunward limb at new — the three cases that make the construction easy to
 * check by eye.
 */
export function fillLitDisc(
  ctx: CanvasRenderingContext2D,
  centreX: number,
  centreY: number,
  radiusX: number,
  radiusY: number,
  /** Screen angle of the bright limb, radians, measured as atan2(dy, dx). */
  brightAngle: number,
  cosPhase: number,
  fill: string | CanvasGradient,
): void {
  const k = Math.max(-1, Math.min(1, cosPhase));

  ctx.save();
  ctx.translate(centreX, centreY);
  ctx.rotate(brightAngle);
  ctx.scale(radiusX, radiusY);

  ctx.beginPath();
  // The sunward half of the limb.
  ctx.ellipse(0, 0, 1, 1, 0, -Math.PI / 2, Math.PI / 2, false);
  // The terminator, closing the region back to where it started.
  if (Math.abs(k) < 1e-4) {
    ctx.lineTo(0, -1);
  } else {
    ctx.ellipse(0, 0, Math.abs(k), 1, 0, Math.PI / 2, -Math.PI / 2, k <= 0);
  }
  ctx.closePath();

  ctx.restore();
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * Screen angle of a world direction, once projected.
 *
 * The bright limb is a direction in space; the renderer needs it as an angle on
 * the canvas. Projecting the direction as a displacement rather than as a point
 * keeps it independent of where the body happens to be.
 */
export function screenAngleOf(direction: Vec3, azimuth: number, tilt: number): number {
  const view = rotateX(rotateZ(direction, -azimuth), -tilt);
  // Canvas y runs downward, so the sign flips.
  return Math.atan2(-view.y, view.x);
}

/** How much of a direction survives the projection — zero when it points at us. */
export function projectedLength(direction: Vec3, azimuth: number, tilt: number): number {
  const view = rotateX(rotateZ(direction, -azimuth), -tilt);
  return Math.hypot(view.x, view.y);
}

/**
 * The camera's basis, expressed in world axes.
 *
 * `e3` points from the scene toward the viewer, so a surface whose normal has a
 * positive component along it is facing us. Returned as three world vectors
 * because the spheroid solve below has to work in world coordinates — that is
 * where the spheroid is defined.
 */
export function cameraBasis(azimuth: number, tilt: number): [Vec3, Vec3, Vec3] {
  const inverse = (v: Vec3): Vec3 => rotateZ(rotateX(v, tilt), azimuth);
  return [inverse(vec3(1, 0, 0)), inverse(vec3(0, 1, 0)), inverse(vec3(0, 0, 1))];
}

/**
 * The point on a spheroid that a screen position looks at, or null if the ray
 * misses.
 *
 * Screen coordinates come in as view-plane offsets in kilometres, not pixels,
 * so the caller does the scaling and this stays a piece of geometry.
 *
 * Substituting the ray into the spheroid gives a quadratic in the depth; the
 * larger root is the near surface, which is the one facing the camera. This is
 * what makes real per-point shading possible: with the surface point in hand,
 * the normal, the Lambert term and the ring shadow all follow.
 */
export function spheroidSurfacePoint(
  viewX: number,
  viewY: number,
  basis: readonly [Vec3, Vec3, Vec3],
  equatorialRadius: number,
  polarRadius: number,
): Vec3 | null {
  const [e1, e2, e3] = basis;

  const px = viewX * e1.x + viewY * e2.x;
  const py = viewX * e1.y + viewY * e2.y;
  const pz = viewX * e1.z + viewY * e2.z;

  const a2 = equatorialRadius * equatorialRadius;
  const c2 = polarRadius * polarRadius;

  const A = (e3.x * e3.x + e3.y * e3.y) / a2 + (e3.z * e3.z) / c2;
  const B = 2 * ((px * e3.x + py * e3.y) / a2 + (pz * e3.z) / c2);
  const C = (px * px + py * py) / a2 + (pz * pz) / c2 - 1;

  const discriminant = B * B - 4 * A * C;
  if (discriminant < 0) return null;

  const depth = (-B + Math.sqrt(discriminant)) / (2 * A);
  return vec3(px + depth * e3.x, py + depth * e3.y, pz + depth * e3.z);
}

/**
 * Outward normal of a spheroid at a surface point.
 *
 * Not the position direction — for an oblate body those differ by up to a
 * degree and a half, which is the difference between the geographic and
 * geocentric latitudes that navigators have to keep apart.
 */
export function spheroidNormal(
  point: Vec3,
  equatorialRadius: number,
  polarRadius: number,
): Vec3 {
  const a2 = equatorialRadius * equatorialRadius;
  const c2 = polarRadius * polarRadius;
  const nx = point.x / a2;
  const ny = point.y / a2;
  const nz = point.z / c2;
  const norm = Math.hypot(nx, ny, nz);
  return norm === 0 ? vec3(0, 0, 1) : vec3(nx / norm, ny / norm, nz / norm);
}
