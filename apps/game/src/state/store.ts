/**
 * One source of truth for the whole game.
 *
 * Plain mutable state with a subscriber list, not a framework. The render loop
 * reads it sixty times a second and does not want change detection in the way;
 * the interface panels only need to know when something they show has changed,
 * and a bare notify covers that.
 *
 * The important structural point is that **the simulation is state like
 * anything else**. There is no separate physics world that the display copies
 * from — the `SaturnSystem` in here *is* the game, and every panel, overlay and
 * readout is a view onto it.
 */

import { SaturnSystem, SATURN_INDEX, type Probe } from '@saturn/core/system';
import {
  createModule,
  thrustAcceleration,
  consumePropellant,
  type ModuleState,
  type ThrustMode,
} from '@saturn/core/module';
import { MOONS_BY_DISTANCE, moonById } from '@saturn/core/moons';
import { SATURN_GM, SATURN_EQUATORIAL_RADIUS } from '@saturn/core/saturn';
import { solarGeometry, type SolarGeometry } from '@saturn/core/sun';
import type { FieldGrid, FieldMode } from '@saturn/core/field';
import type { Prediction } from '@saturn/core/predict';
import { circularSpeed } from '@saturn/core/units';
import { ZERO, add, length, sub, vec3, type Vec3 } from '@saturn/core/vec';
import { Camera } from './camera.js';

export interface Overlays {
  orbits: boolean;
  moonLabels: boolean;
  trail: boolean;
  prediction: boolean;
  field: boolean;
  sunArrow: boolean;
  shadows: boolean;
  hillSpheres: boolean;
}

export interface FieldSettings {
  mode: FieldMode;
  /** Half-width of the sampled patch, km. Null follows the viewport. */
  halfWidth: number | null;
  resolution: number;
  /** Centre of the patch, or null to track the module. */
  centre: Vec3 | null;
}

export interface PredictionSettings {
  /** Look-ahead, seconds. */
  duration: number;
  samples: number;
  ghosts: number;
  /** Integration step for the prediction, seconds. */
  step: number;
}

/** How far the module's own trail is remembered, in samples. */
const TRAIL_LIMIT = 4_000;

/**
 * Time-warp settings offered.
 *
 * Geometric, roughly a factor of four apart, because the interesting timescales
 * are: a burn (seconds), an inner-moon orbit (a day), a Titan orbit (a
 * fortnight), and a seasonal change in the ring lighting (years). One list has
 * to reach all four.
 */
export const WARP_STEPS = [1, 5, 25, 100, 500, 2_500, 10_000, 50_000, 200_000] as const;

export class Store {
  readonly system: SaturnSystem;
  readonly camera = new Camera();

  module: ModuleState = createModule();
  probe: Probe;

  /** Simulation seconds per wall-clock second. */
  warpIndex = 3;
  paused = false;

  /** Moon id, `saturn`, or null. */
  selection: string | null = 'titan';
  /** Keep the camera on the module rather than on a fixed point. */
  followModule = true;

  overlays: Overlays = {
    orbits: true,
    moonLabels: true,
    trail: true,
    prediction: true,
    field: false,
    sunArrow: true,
    shadows: true,
    hillSpheres: false,
  };

  field: FieldSettings = {
    mode: 'relative',
    halfWidth: null,
    resolution: 17,
    centre: null,
  };

  fieldGrid: FieldGrid | null = null;

  predictionSettings: PredictionSettings = {
    duration: 3 * 86_400,
    samples: 400,
    ghosts: 4,
    step: 120,
  };

  prediction: Prediction | null = null;
  predictionPending = false;
  /** Set when the module has been moved since the last prediction. */
  predictionStale = true;

  /** The module's own history, Saturn-centred, km. */
  trail: Vec3[] = [];

  sun: SolarGeometry;

  /** Set when the module has hit something; cleared on reset. */
  crashed: { body: string; speed: number } | null = null;

  private readonly listeners = new Set<() => void>();

  constructor() {
    this.system = new SaturnSystem();
    this.probe = this.initialProbe();
    this.system.probes = [this.probe];
    this.sun = solarGeometry(this.system.time);
    this.camera.centre = this.saturnCentred(this.probe.position);
  }

  /**
   * The starting orbit: circular, equatorial, just outside the F ring.
   *
   * Chosen so that the first thing on screen is the rings from close up, and so
   * that the player begins somewhere genuinely precarious — 160 000 km is
   * inside Janus and Epimetheus, and a careless retrograde burn drops the
   * periapsis into the A ring within one orbit.
   */
  private initialProbe(): Probe {
    const radius = 160_000;
    const saturn = this.system.positionOf(SATURN_INDEX);
    return {
      position: add(saturn, vec3(radius, 0, 0)),
      velocity: add(
        this.system.velocityOf(SATURN_INDEX),
        vec3(0, circularSpeed(SATURN_GM, radius), 0),
      ),
      thrust: ZERO,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  get warp(): number {
    return WARP_STEPS[this.warpIndex] ?? 1;
  }

  setWarp(index: number): void {
    this.warpIndex = Math.min(WARP_STEPS.length - 1, Math.max(0, index));
    this.notify();
  }

  /** A world position expressed relative to Saturn, which is what is drawn. */
  saturnCentred(point: Vec3): Vec3 {
    return sub(point, this.system.positionOf(SATURN_INDEX));
  }

  /** Index of the selected body, or Saturn's if nothing sensible is selected. */
  get selectedIndex(): number {
    if (!this.selection || this.selection === 'saturn') return SATURN_INDEX;
    const index = this.system.indexOf(this.selection);
    return index < 0 ? SATURN_INDEX : index;
  }

  get selectedRadius(): number {
    if (this.selectedIndex === SATURN_INDEX) return SATURN_EQUATORIAL_RADIUS;
    return this.system.bodies[this.selectedIndex]?.radius ?? 1;
  }

  get selectedGm(): number {
    if (this.selectedIndex === SATURN_INDEX) return SATURN_GM;
    return this.system.bodies[this.selectedIndex]?.gm ?? SATURN_GM;
  }

  select(id: string | null): void {
    this.selection = id;
    this.module.referenceIndex = this.selectedIndex;
    this.notify();
  }

  setThrottle(value: number): void {
    this.module.throttle = Math.min(1, Math.max(0, value));
    this.predictionStale = true;
    this.notify();
  }

  setMode(mode: ThrustMode): void {
    this.module.mode = mode;
    this.predictionStale = true;
    this.notify();
  }

  /**
   * Advance the simulation by `seconds` of simulated time.
   *
   * Thrust is resolved once per call rather than once per integration step,
   * which is right: the player's controls cannot change faster than a frame, so
   * sampling them more often would only cost time. Propellant is spent against
   * the same interval.
   */
  advance(seconds: number): void {
    if (seconds <= 0 || this.crashed) return;

    const reference = this.module.referenceIndex;
    this.probe.thrust = thrustAcceleration(
      this.module,
      sub(this.probe.position, this.system.positionOf(reference)),
      sub(this.probe.velocity, this.system.velocityOf(reference)),
    );

    if (this.module.throttle > 0 && this.module.propellant > 0) {
      const { state } = consumePropellant(this.module, seconds);
      this.module = state;
      this.predictionStale = true;
    }

    this.system.advance(seconds);
    this.sun = solarGeometry(this.system.time);

    this.recordTrail();
    this.checkCollision();
  }

  private recordTrail(): void {
    const point = this.saturnCentred(this.probe.position);
    const last = this.trail[this.trail.length - 1];
    // Only record when the module has actually moved a pixel's worth, or the
    // trail fills with thousands of coincident points at low warp.
    const threshold = this.camera.halfWidth / 400;
    if (!last || length(sub(point, last)) > threshold) {
      this.trail.push(point);
      if (this.trail.length > TRAIL_LIMIT) this.trail.shift();
    }
  }

  /**
   * Has the module hit anything?
   *
   * Checked against every body each step, which sounds expensive and is not:
   * 55 distance tests against a frame budget of 16 ms is nothing, and the
   * alternative — testing only nearby bodies — needs a spatial structure that
   * would have to be rebuilt every frame anyway.
   */
  private checkCollision(): void {
    for (let i = 0; i < this.system.count; i++) {
      const relative = sub(this.probe.position, this.system.positionOf(i));
      const distance = length(relative);
      const radius =
        i === SATURN_INDEX
          ? SATURN_EQUATORIAL_RADIUS
          : this.system.bodies[i]?.radius ?? 0;

      if (distance < radius) {
        this.crashed = {
          body: i === SATURN_INDEX ? 'saturn' : this.system.bodies[i]?.id ?? '?',
          speed: length(sub(this.probe.velocity, this.system.velocityOf(i))),
        };
        this.module.throttle = 0;
        this.notify();
        return;
      }
    }
  }

  /** Put the module back on its starting orbit, with full tanks. */
  reset(): void {
    this.probe = this.initialProbe();
    this.system.probes = [this.probe];
    this.module = createModule();
    this.module.referenceIndex = this.selectedIndex;
    this.trail = [];
    this.prediction = null;
    this.predictionStale = true;
    this.crashed = null;
    this.notify();
  }

  /**
   * Drop the module into a circular orbit about the selected body.
   *
   * A teleport, and openly so — it is a sandbox tool, not a manoeuvre. Getting
   * to Iapetus under power is a forty-day flight, and a player who wants to
   * look at the field around Iapetus should not have to fly it first.
   */
  placeInOrbit(altitudeFactor = 3): void {
    const index = this.selectedIndex;
    const body = this.system.positionOf(index);
    const bodyVelocity = this.system.velocityOf(index);
    const radius = this.selectedRadius * altitudeFactor;
    const gm = this.selectedGm;

    this.probe = {
      position: add(body, vec3(radius, 0, 0)),
      velocity: add(bodyVelocity, vec3(0, circularSpeed(gm, radius), 0)),
      thrust: ZERO,
    };
    this.system.probes = [this.probe];
    this.trail = [];
    this.prediction = null;
    this.predictionStale = true;
    this.crashed = null;
    this.followModule = true;
    this.notify();
  }

  /** Every moon, outward, for the selection list. */
  get moonList() {
    return MOONS_BY_DISTANCE;
  }

  moonName(id: string): string {
    return id === 'saturn' ? 'Saturn' : moonById(id)?.name ?? id;
  }
}
