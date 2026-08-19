/**
 * The camera: an orthographic view of the ring plane, tiltable.
 *
 * Orthographic rather than perspective, and deliberately. This is a navigation
 * display before it is a picture: a player judging whether a periapsis clears
 * the F ring needs two lengths on screen to be comparable, and perspective
 * makes that a lie that depends on depth. Every real mission-planning tool is
 * orthographic for the same reason.
 *
 * ## The zoom problem
 *
 * The system spans from Daphnis, 4 km across, to Fornjot's orbit at 25 million
 * km. That is seven decades, and no linear zoom control can cross it — a slider
 * that moves comfortably at Titan's distance would take a thousand drags to
 * reach the rings. So zoom is logarithmic throughout: the control is the
 * *exponent*, and one notch always changes the view by the same factor
 * wherever you are.
 *
 * ## Frames
 *
 * Positions arrive Saturn-centred, which is what the player thinks in. Inside,
 * the camera rotates by azimuth about the pole and then tilts about the screen
 * horizontal, so tilt 0 looks straight down onto the rings and tilt 90 puts
 * them edge-on.
 */

import { DEG, rotateX, rotateZ, vec3, type Vec3 } from '@saturn/core/vec';

export interface Projected {
  x: number;
  y: number;
  /** Distance toward the viewer. Positive is nearer; used for draw order. */
  depth: number;
}

/** The narrowest and widest half-widths the view can show, km. */
export const MIN_HALF_WIDTH = 5;
export const MAX_HALF_WIDTH = 30_000_000;

export class Camera {
  /** Half-width of the viewport in kilometres — the one number zoom controls. */
  halfWidth = 400_000;

  /** Point at the centre of the screen, in the Saturn-centred frame, km. */
  centre: Vec3 = vec3(0, 0, 0);

  /** Rotation about Saturn's pole, radians. */
  azimuth = 0;

  /**
   * Angle between the view direction and Saturn's north pole, radians.
   *
   * Runs the whole way from 0 to pi, not 0 to pi/2, and that full range is
   * needed rather than decorative: at 0 the camera looks down on the north face
   * of the rings, at pi/2 it is edge-on, and beyond that it is *underneath*,
   * looking at the south face.
   *
   * Which matters because the rings only have one lit face at a time. Saturn's
   * axis is tilted 28 degrees and its year is 29 of ours, so the Sun spends a
   * decade and a half on each side. At J2000 it is 21 degrees below the ring
   * plane — southern summer — and a camera confined to the northern half would
   * open on the unlit face, which is very nearly black and stays that way for
   * fifteen years of simulated time.
   *
   * Opens at 25 degrees off the pole rather than 0. Flat-on is the more useful
   * *diagram*, every orbit undistorted, but it makes the rings concentric
   * circles with no thickness and Saturn a plain disc.
   */
  tilt = 25 * DEG;

  /** Viewport size in device-independent pixels. */
  width = 1;
  height = 1;

  /** Pixels per kilometre. */
  get scale(): number {
    return this.width / (2 * this.halfWidth);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  /**
   * Zoom by a factor about a fixed screen point.
   *
   * Keeping the point under the cursor stationary is what makes wheel-zoom feel
   * like a magnifier rather than a slider. Without it the player chases their
   * target across the screen, and at these zoom ranges the target leaves the
   * viewport entirely within two notches.
   */
  zoomBy(factor: number, screenX?: number, screenY?: number): void {
    const anchor =
      screenX === undefined || screenY === undefined
        ? null
        : this.unproject(screenX, screenY);

    this.halfWidth = Math.min(
      MAX_HALF_WIDTH,
      Math.max(MIN_HALF_WIDTH, this.halfWidth * factor),
    );

    if (anchor && screenX !== undefined && screenY !== undefined) {
      const after = this.unproject(screenX, screenY);
      this.centre = vec3(
        this.centre.x + (anchor.x - after.x),
        this.centre.y + (anchor.y - after.y),
        this.centre.z + (anchor.z - after.z),
      );
    }
  }

  /** Pan by a screen-space displacement in pixels. */
  panBy(dx: number, dy: number): void {
    const perPixel = 1 / this.scale;
    // Undo the tilt: a pixel of vertical screen motion covers more ground when
    // the view is oblique, and diverges as the rings go edge-on. The magnitude
    // is what matters — from below the plane the squash is negative, and using
    // it signed here would send the drag the wrong way.
    const cosTilt = Math.max(0.05, Math.abs(Math.cos(this.tilt)));
    const local = vec3(-dx * perPixel, (dy * perPixel) / cosTilt, 0);
    const world = rotateZ(local, this.azimuth);
    this.centre = vec3(
      this.centre.x + world.x,
      this.centre.y + world.y,
      this.centre.z,
    );
  }

  /** Rotate the view about Saturn's pole and about the screen horizontal. */
  orbitBy(deltaAzimuth: number, deltaTilt: number): void {
    this.azimuth += deltaAzimuth;
    this.tilt = Math.min(Math.PI, Math.max(0, this.tilt + deltaTilt));
  }

  /**
   * Swing round to look at whichever ring face the Sun is lighting.
   *
   * Used to choose the opening view, and offered as a control, because
   * "everything is black" is otherwise an entirely correct rendering that
   * looks exactly like a bug.
   *
   * Setting the view direction equal to the Sun direction would give zero phase
   * angle — full illumination, and a flat picture with no terminator anywhere.
   * The offset backs off from that by a few tens of degrees, which is roughly
   * the phase Saturn is seen at from Earth and enough to model the globe.
   */
  faceSun(toSun: Vec3, offsetRadians = 25 * DEG): void {
    const elevation = Math.max(-1, Math.min(1, toSun.z));
    this.tilt = Math.acos(elevation);

    const horizontal = Math.hypot(toSun.x, toSun.y);
    if (horizontal > 1e-9) {
      this.azimuth = Math.atan2(toSun.x, -toSun.y) + offsetRadians;
    }

    // Keep a little off the pole, so the rings never open to a perfect circle.
    const minimum = 12 * DEG;
    if (this.tilt < minimum) this.tilt = minimum;
    if (this.tilt > Math.PI - minimum) this.tilt = Math.PI - minimum;
  }

  /** World point (Saturn-centred) to screen pixels. */
  project(point: Vec3): Projected {
    const relative = vec3(
      point.x - this.centre.x,
      point.y - this.centre.y,
      point.z - this.centre.z,
    );
    const view = rotateX(rotateZ(relative, -this.azimuth), -this.tilt);
    const scale = this.scale;
    return {
      x: this.width / 2 + view.x * scale,
      y: this.height / 2 - view.y * scale,
      depth: view.z,
    };
  }

  /**
   * Screen pixels back to a world point on the ring plane.
   *
   * The inverse is ambiguous — a pixel names a whole line through space — so it
   * is resolved by intersecting with z = 0. That is the right choice for this
   * game, where the plane is where nearly everything is and where the player
   * expects a click to land.
   */
  unproject(screenX: number, screenY: number): Vec3 {
    const scale = this.scale;
    const viewX = (screenX - this.width / 2) / scale;
    const viewY = (this.height / 2 - screenY) / scale;

    // Undo the tilt for a point known to lie on z = 0 in world terms. The view
    // y and z mix under tilt; solving for the z = 0 plane gives this.
    const cosTilt = Math.cos(this.tilt);
    const local =
      Math.abs(cosTilt) < 1e-6
        ? vec3(viewX, 0, 0) // Edge-on: every screen row is the same plane line.
        : vec3(viewX, viewY / cosTilt, 0);

    const world = rotateZ(local, this.azimuth);
    return vec3(this.centre.x + world.x, this.centre.y + world.y, 0);
  }

  /**
   * Unit vector from Saturn toward the viewer, in the world frame.
   *
   * Illumination needs it: the phase of a moon is the angle at the moon between
   * the Sun and this direction, so a player who tilts the camera round to the
   * night side should see the moons go to crescents.
   */
  viewDirection(): Vec3 {
    return rotateZ(rotateX(vec3(0, 0, 1), this.tilt), this.azimuth);
  }

  /**
   * How much a circle in the ring plane is squashed vertically on screen.
   *
   * Signed: negative when the camera is below the ring plane. Callers drawing
   * an ellipse want the magnitude; callers inverting the projection want the
   * sign, because it is what says which way round the plane is being seen.
   */
  get ringSquash(): number {
    return Math.cos(this.tilt);
  }

  /** Is a projected point worth drawing at all? */
  onScreen(point: Projected, margin = 64): boolean {
    return (
      point.x > -margin &&
      point.x < this.width + margin &&
      point.y > -margin &&
      point.y < this.height + margin
    );
  }

  /** Frame a body of the given radius, leaving it a comfortable share of the view. */
  frame(centre: Vec3, radiusKm: number): void {
    this.centre = centre;
    this.halfWidth = Math.min(
      MAX_HALF_WIDTH,
      Math.max(MIN_HALF_WIDTH, Math.max(radiusKm * 4, MIN_HALF_WIDTH)),
    );
  }
}
