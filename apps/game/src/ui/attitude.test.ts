import { describe, expect, it } from 'vitest';
import { fromDial, toDial } from './attitude.js';
import {
  directionFromAngles,
  orbitalBasis,
  thrustDirection,
  createModule,
} from '@saturn/core/module';
import { SATURN_GM } from '@saturn/core/saturn';
import { circularSpeed } from '@saturn/core/units';
import { dot, vec3 } from '@saturn/core/vec';

/*
 * The dial is a projection, and a projection that does not invert cleanly puts
 * the engine somewhere other than where the player pointed. Since the error
 * would be a smooth few degrees rather than anything obviously broken, it is
 * exactly the sort of thing to pin with arithmetic rather than by eye.
 */
describe('the attitude dial projection', () => {
  it('puts prograde at the centre', () => {
    expect(toDial(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('puts radial-out and normal at half radius, on their axes', () => {
    // 90 degrees from prograde is exactly halfway to the rim, because the
    // projection is equidistant.
    const radial = toDial(Math.PI / 2, 0);
    expect(radial.x).toBeCloseTo(0.5, 9);
    expect(radial.y).toBeCloseTo(0, 9);

    const normal = toDial(0, Math.PI / 2);
    expect(normal.x).toBeCloseTo(0, 9);
    expect(normal.y).toBeCloseTo(0.5, 9);
  });

  it('puts retrograde on the rim', () => {
    expect(Math.hypot(...Object.values(toDial(Math.PI, 0)))).toBeCloseTo(1, 9);
  });

  it('round-trips every aim it can represent', () => {
    for (let yawStep = 0; yawStep < 12; yawStep++) {
      for (let pitchStep = -4; pitchStep <= 4; pitchStep++) {
        const yaw = (yawStep / 12) * 2 * Math.PI - Math.PI;
        const pitch = (pitchStep / 4) * (Math.PI / 2) * 0.98;

        const point = toDial(yaw, pitch);
        const back = fromDial(point.x, point.y);

        // Compare directions rather than angle pairs: near the poles the yaw is
        // ill-conditioned and two very different yaws name the same aim.
        const basis = {
          prograde: vec3(1, 0, 0),
          radial: vec3(0, 1, 0),
          normal: vec3(0, 0, 1),
        };
        const original = directionFromAngles(basis, yaw, pitch);
        const recovered = directionFromAngles(basis, back.yaw, back.pitch);
        expect(dot(original, recovered)).toBeCloseTo(1, 8);
      }
    }
  });

  it('never leaves the face of the dial', () => {
    for (let yawStep = 0; yawStep < 20; yawStep++) {
      for (let pitchStep = -5; pitchStep <= 5; pitchStep++) {
        const point = toDial(
          (yawStep / 20) * 2 * Math.PI,
          (pitchStep / 5) * (Math.PI / 2),
        );
        expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('clamps a drag outside the rim rather than wrapping round', () => {
    // A pointer dragged past the edge should saturate at retrograde, not fold
    // back toward prograde.
    const outside = fromDial(3, 0);
    const rim = fromDial(1, 0);
    expect(Math.abs(outside.yaw)).toBeCloseTo(Math.abs(rim.yaw), 9);
  });
});

describe('the dial agrees with the engine', () => {
  /*
   * The dial's angles are fed straight to `setAim`, so its idea of "90 degrees
   * of yaw" has to be the engine's. If the two conventions drifted apart, free
   * aim would work and simply point somewhere other than the dial showed.
   */
  const position = vec3(300_000, 0, 0);
  const velocity = vec3(0, circularSpeed(SATURN_GM, 300_000), 0);
  const basis = orbitalBasis(position, velocity)!;

  const aimedAt = (yaw: number, pitch: number) =>
    thrustDirection(
      'aimed',
      { ...createModule(), aimYaw: yaw, aimPitch: pitch },
      position,
      velocity,
    );

  it('sends a centre aim prograde', () => {
    const { yaw, pitch } = fromDial(0, 0);
    expect(dot(aimedAt(yaw, pitch), basis.prograde)).toBeCloseTo(1, 9);
  });

  it('sends a right-hand aim radially outward', () => {
    const { yaw, pitch } = fromDial(0.5, 0);
    expect(dot(aimedAt(yaw, pitch), basis.radial)).toBeCloseTo(1, 8);
  });

  it('sends an upward aim along the normal', () => {
    const { yaw, pitch } = fromDial(0, 0.5);
    expect(dot(aimedAt(yaw, pitch), basis.normal)).toBeCloseTo(1, 8);
  });

  it('sends a rim aim retrograde', () => {
    const { yaw, pitch } = fromDial(1, 0);
    expect(dot(aimedAt(yaw, pitch), basis.prograde)).toBeCloseTo(-1, 8);
  });
});
