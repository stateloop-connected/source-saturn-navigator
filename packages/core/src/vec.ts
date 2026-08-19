/**
 * Three-component vectors, immutable.
 *
 * The integrator does not use these — its inner loop runs over flat
 * `Float64Array`s, because allocating three objects per body per step dominates
 * everything else. Everything outside the inner loop does, because readable
 * geometry is worth more than the allocations it costs.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const ZERO: Vec3 = vec3(0, 0, 0);

export const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);

export const sub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);

export const scale = (a: Vec3, k: number): Vec3 => vec3(a.x * k, a.y * k, a.z * k);

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const length = (a: Vec3): number => Math.sqrt(dot(a, a));

export const lengthSquared = (a: Vec3): number => dot(a, a);

export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export const normalize = (a: Vec3): Vec3 => {
  const len = length(a);
  return len === 0 ? ZERO : scale(a, 1 / len);
};

/** Linear interpolation; `t` is not clamped. */
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const TAU = Math.PI * 2;

/** Wrap an angle in radians into [0, 2pi). */
export const wrapRad = (radians: number): number => {
  const wrapped = radians % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
};

/** Wrap an angle in degrees into [0, 360). */
export const wrapDeg = (degrees: number): number => {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
};

/** Rotate about the x-axis by `angle` radians, right-handed. */
export const rotateX = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
};

/** Rotate about the z-axis by `angle` radians, right-handed. */
export const rotateZ = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z);
};

/**
 * An orthonormal basis whose first axis is `primary`.
 *
 * Used wherever a direction has to become a frame — laying a sampling grid
 * across a chosen patch of space, or resolving a thrust command given in
 * prograde/normal/radial terms back into the simulation frame. The second axis
 * is seeded from whichever cardinal direction `primary` is least aligned with,
 * so the construction never degenerates.
 */
export function basisFrom(primary: Vec3): [Vec3, Vec3, Vec3] {
  const first = normalize(primary);
  const seed = Math.abs(first.z) < 0.9 ? vec3(0, 0, 1) : vec3(1, 0, 0);
  const second = normalize(cross(seed, first));
  const third = cross(first, second);
  return [first, second, third];
}

/** Angle between two vectors, radians, robust for near-parallel inputs. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const lengths = length(a) * length(b);
  if (lengths === 0) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot(a, b) / lengths)));
}
