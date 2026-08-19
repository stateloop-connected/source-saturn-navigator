/**
 * What is lit, what is not, and how much.
 *
 * The Sun is 1.4 billion km away and the whole moon system spans 25 million, so
 * to a very good approximation every body here is lit from the same direction
 * by parallel light. That one simplification makes all of this cheap: phase is
 * an angle, the terminator is a projection, and a shadow is a cylinder.
 *
 * Which is worth doing properly, because out here shadows are not decoration.
 * Saturn's shadow crosses the rings as a hard black wedge that turns with the
 * seasons; a module in a low orbit passes through it every couple of hours and
 * loses all solar power while it does; and the rings themselves throw a banded
 * shadow onto Saturn that is the most recognisable thing in any photograph of
 * the planet.
 */

import {
  SATURN_EQUATORIAL_RADIUS,
  SATURN_POLAR_RADIUS,
  MAIN_RING_OUTER,
  RING_BANDS,
} from './saturn.js';
import {
  ZERO,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
  type Vec3,
} from './vec.js';

export interface Illumination {
  /** Angle Sun-body-viewer, radians. Zero is full, pi is new. */
  phaseAngle: number;
  /** Illuminated fraction of the visible disc, 0 to 1. */
  fraction: number;
  /**
   * Direction of the bright limb, as a unit vector in the simulation frame.
   *
   * The renderer projects this into screen space to orient the terminator. It
   * is returned in three dimensions rather than as a screen angle so that this
   * module never has to know what the camera is doing.
   */
  brightLimb: Vec3;
  /** True when the body is in Saturn's shadow and lit by nothing at all. */
  eclipsed: boolean;
}

/**
 * Phase of a body as seen from a given direction.
 *
 * `toViewer` points from the body toward the observer, `toSun` from the body
 * toward the Sun. Both are assumed normalised; passing raw differences works
 * too, and only costs a square root.
 */
export function illuminationOf(
  toSun: Vec3,
  toViewer: Vec3,
  eclipsed = false,
): Illumination {
  const sun = normalize(toSun);
  const viewer = normalize(toViewer);

  const cosPhase = Math.min(1, Math.max(-1, dot(sun, viewer)));
  const phaseAngle = Math.acos(cosPhase);

  // The bright limb lies along the component of the Sun direction that is
  // perpendicular to the line of sight.
  const perpendicular = sub(sun, scale(viewer, cosPhase));
  const brightLimb = length(perpendicular) < 1e-12 ? ZERO : normalize(perpendicular);

  return {
    phaseAngle,
    fraction: eclipsed ? 0 : (1 + cosPhase) / 2,
    brightLimb,
    eclipsed,
  };
}

/**
 * Is a point inside Saturn's shadow?
 *
 * Modelled as a cylinder rather than a cone. The Sun subtends about 0.055
 * degrees at Saturn, so the umbra converges to a point only after 1.25e8 km —
 * five times further out than Fornjot, the most distant moon. Within the system
 * the shadow is parallel-sided to well under a kilometre, and treating it as a
 * cone would be arithmetic spent on nothing.
 *
 * The cross-section is an ellipse, not a circle, because Saturn is visibly
 * oblate: at an equinox the shadow is 5 900 km narrower across the poles than
 * across the equator. Its shape therefore depends on how high the Sun stands
 * above the ring plane, which is what the `alongPole` term below carries.
 *
 * `point` is Saturn-centred, `toSun` is the unit vector from Saturn toward the
 * Sun.
 */
export function inSaturnShadow(point: Vec3, toSun: Vec3): boolean {
  const alongSun = dot(point, toSun);
  // Sunward of Saturn's centre: cannot be behind it.
  if (alongSun > 0) return false;

  // Component of the position perpendicular to the sunlight.
  const perpendicular = sub(point, scale(toSun, alongSun));

  // A basis in that perpendicular plane: `north` is Saturn's pole projected
  // into it, `east` completes the pair and lies in the equatorial plane.
  const pole = vec3(0, 0, 1);
  const poleAlongSun = dot(pole, toSun);
  const northRaw = sub(pole, scale(toSun, poleAlongSun));
  const northLength = length(northRaw);

  if (northLength < 1e-9) {
    // Sun directly over a pole: the silhouette is a circle of the equatorial
    // radius. Cannot happen for Saturn, whose tilt maxes out at 28 degrees, but
    // the branch costs nothing and the alternative is a division by zero.
    return length(perpendicular) < SATURN_EQUATORIAL_RADIUS;
  }

  const north = scale(northRaw, 1 / northLength);
  const east = cross(toSun, north);

  // Semi-axis across the silhouette's short direction. `poleAlongSun` is the
  // sine of the Sun's latitude: zero at an equinox, when the silhouette is at
  // its flattest and the short axis is the polar radius.
  const sinLatitude = Math.min(1, Math.abs(poleAlongSun));
  const cosLatitude = Math.sqrt(1 - sinLatitude * sinLatitude);
  const shortAxis = Math.sqrt(
    SATURN_EQUATORIAL_RADIUS ** 2 * sinLatitude ** 2 +
      SATURN_POLAR_RADIUS ** 2 * cosLatitude ** 2,
  );

  const alongNorth = dot(perpendicular, north) / shortAxis;
  const alongEast = dot(perpendicular, east) / SATURN_EQUATORIAL_RADIUS;

  return alongNorth * alongNorth + alongEast * alongEast < 1;
}

/**
 * Is a point shadowed by the rings?
 *
 * Traces back along the sunlight to where it would have crossed the ring plane,
 * and reports the optical depth it would have passed through. Returns 0 in
 * full sun and up to about 1.5 under the densest part of the B ring.
 *
 * The transmitted fraction is exp(-tau / sin(elevation)) — the slant path is
 * longer than the vertical one, which is why the ring shadows on Saturn are
 * broad and soft near an equinox and narrow and sharp near a solstice.
 */
export function ringShadowDepth(point: Vec3, toSun: Vec3): number {
  // Sunlight arrives along -toSun; step back toward the Sun to find the
  // crossing of z = 0.
  if (Math.abs(toSun.z) < 1e-9) return 0;

  const distanceToPlane = -point.z / toSun.z;
  // A negative parameter would put the crossing behind the Sun, meaning the
  // point is on the sunlit side of the ring plane and nothing is above it.
  if (distanceToPlane <= 0) return 0;

  const crossing = {
    x: point.x + toSun.x * distanceToPlane,
    y: point.y + toSun.y * distanceToPlane,
  };
  const radius = Math.hypot(crossing.x, crossing.y);
  if (radius > MAIN_RING_OUTER) return 0;

  for (const band of RING_BANDS) {
    if (band.id === 'E' || band.id === 'G') continue;
    if (radius >= band.inner && radius < band.outer) {
      const elevation = Math.abs(toSun.z);
      return elevation < 1e-6 ? band.opticalDepth * 1e6 : band.opticalDepth / elevation;
    }
  }
  return 0;
}

/** Fraction of sunlight surviving an optical depth. */
export const transmission = (opticalDepth: number): number => Math.exp(-opticalDepth);

export interface RingLighting {
  /** Sine of the Sun's elevation above the ring plane; sign gives the lit face. */
  sunElevation: number;
  /** Sine of the viewer's elevation. Same sign means the lit face is toward us. */
  viewElevation: number;
  /** True when the viewer is looking at the unlit face, seeing only what leaks through. */
  seeingUnlitFace: boolean;
  /**
   * Brightness multiplier for the rings, 0 to 1.
   *
   * Two effects. Face-on, more of each particle's lit hemisphere is turned
   * toward the viewer and the rings blaze; edge-on they all but vanish. And on
   * the unlit face only the light that got *through* is seen, so the dense B
   * ring — the brightest band from the lit side — becomes the darkest from
   * behind. That inversion is real and is the most striking thing about a
   * back-lit view of Saturn.
   */
  brightness: number;
}

/**
 * How the rings are lit for a given Sun and viewer.
 *
 * `toSun` and `toViewer` are unit vectors from Saturn.
 */
export function ringLighting(toSun: Vec3, toViewer: Vec3): RingLighting {
  const sunElevation = toSun.z;
  const viewElevation = toViewer.z;
  const seeingUnlitFace = sunElevation * viewElevation < 0;

  const openness = Math.min(1, Math.abs(sunElevation));
  const viewOpenness = Math.min(1, Math.abs(viewElevation));

  // Lit face: brightness climbs with how open the rings are to both Sun and
  // viewer. Unlit face: what is seen is transmitted light, so it falls away
  // steeply with optical depth and never gets bright.
  const brightness = seeingUnlitFace
    ? 0.12 * openness * viewOpenness
    : Math.min(1, 0.15 + 0.85 * Math.sqrt(openness * viewOpenness));

  return { sunElevation, viewElevation, seeingUnlitFace, brightness };
}

/**
 * Apparent brightness of a moon, relative to a full, face-on, unit-albedo disc.
 *
 * Albedo times illuminated fraction, with an opposition surge: at phase angles
 * below about 2 degrees an icy regolith stops shadowing itself and brightens
 * sharply. It is a real effect and a large one on these moons — the shadow
 * hiding term roughly doubles Enceladus at true opposition — and it costs one
 * exponential.
 */
export function apparentBrightness(albedo: number, illumination: Illumination): number {
  if (illumination.eclipsed) return 0;
  const surge = 1 + 0.9 * Math.exp(-illumination.phaseAngle / 0.035);
  return albedo * illumination.fraction * surge;
}

/**
 * Iapetus's albedo at a point on its surface, which is the whole reason to look
 * at Iapetus.
 *
 * One hemisphere is as dark as asphalt and the other as bright as snow, split
 * almost exactly along the leading/trailing line: it is tidally locked, and the
 * leading face has been sweeping up dark dust from Phoebe for four billion
 * years. A factor of twelve in albedo across one body, and Cassini noticed the
 * difference from Earth in 1671 — he could see it on one side of Saturn and not
 * the other.
 *
 * `toPoint` is a direction on the moon's surface in the simulation frame;
 * `velocity` is the moon's own, which is where "leading" is measured from.
 */
export function twoFacedAlbedo(
  trailingAlbedo: number,
  leadingAlbedo: number,
  toPoint: Vec3,
  velocity: Vec3,
): number {
  const forward = normalize(velocity);
  const alignment = dot(normalize(toPoint), forward);
  // Smooth over the middle 40 degrees rather than switching hard at the
  // terminator of the two terrains, which is roughly how sharp it really is.
  const blend = Math.min(1, Math.max(0, (alignment + 0.34) / 0.68));
  return trailingAlbedo + (leadingAlbedo - trailingAlbedo) * blend;
}
