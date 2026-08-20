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
import {
  autopilotThrust,
  burnWindow,
  schedulable,
  type ManoeuvreNode,
} from '@saturn/core/manoeuvre';
import {
  START_RADIUS,
  evaluateMission,
  motherShipAt,
  newMission,
  type MissionProgress,
} from '@saturn/core/mission';
import { osculatingElements } from '@saturn/core/elements';
import {
  SATURN_GM,
  SATURN_EQUATORIAL_RADIUS,
  circularSpeedInField,
} from '@saturn/core/saturn';
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
  influence: boolean;
  mission: boolean;
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

  /**
   * Moon id, `saturn`, or null.
   *
   * Opens on Saturn, not on a moon: the module starts in low Saturn orbit, and
   * a navigation readout referred to a body 1.2 million km away would report an
   * escape trajectory on the first frame.
   */
  selection: string | null = 'saturn';
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
    influence: true,
    mission: true,
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

  /**
   * The planned manoeuvre, or null.
   *
   * One at a time. A queue of nodes is the obvious extension and deliberately
   * not here yet: with one node the interface can show a single unambiguous
   * "what this burn does to your orbit", and with several it has to show a tree.
   */
  node: ManoeuvreNode | null = null;

  /** Whether the autopilot flies the node when its window arrives. */
  autopilot = true;

  /** Which body's sphere of influence the module is in. */
  influenceIndex = SATURN_INDEX;

  /** Objectives ticked off so far. Latching — see `evaluateMission`. */
  readonly objectives = newMission();
  mission: MissionProgress | null = null;

  private readonly listeners = new Set<() => void>();

  constructor() {
    this.system = new SaturnSystem();
    this.probe = this.initialProbe();
    this.system.probes = [this.probe];
    this.sun = solarGeometry(this.system.time);
    this.camera.centre = this.saturnCentred(this.probe.position);
    this.influenceIndex = this.system.influenceAt(this.probe.position);
    this.updateMission();
  }

  /**
   * The starting orbit: circular and equatorial, skimming the cloud tops.
   *
   * 530 km above the 1-bar level and below the inner edge of the D ring, so the
   * rings are overhead from the first frame and the whole system is somewhere
   * to climb *to*. It is also the cheapest place in the system to start a
   * transfer from, which is the first thing the mission teaches.
   */
  private initialProbe(): Probe {
    const radius = START_RADIUS;
    const saturn = this.system.positionOf(SATURN_INDEX);
    return {
      position: add(saturn, vec3(radius, 0, 0)),
      velocity: add(
        this.system.velocityOf(SATURN_INDEX),
        // The field's own circular speed, not sqrt(GM/r). At this altitude J2
        // makes the difference 1.3%, which is the difference between a circular
        // orbit and one whose periapsis is 3 100 km underground.
        vec3(0, circularSpeedInField(vec3(radius, 0, 0)), 0),
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

  /**
   * The warp actually used, which is lower than the requested one near a burn.
   *
   * At 200 000x a frame covers nearly an hour of simulated time, and a burn
   * lasting five minutes would be stepped straight over — the autopilot's
   * window would open and close between two samples of the clock and the
   * manoeuvre would simply not happen. So the warp is clamped while a burn is
   * imminent or running, to keep a useful number of integration steps inside
   * the window.
   *
   * Reported separately from `warp` so the interface can show that the game has
   * slowed down on purpose rather than stalling.
   */
  get effectiveWarp(): number {
    const window = this.burnWindow;
    if (!window || !this.autopilot) return this.warp;

    const now = this.system.time;
    // Start easing down a little before the burn, so the first steps of it are
    // not taken at full warp.
    const lead = Math.max(60, window.duration);
    if (now < window.start - lead || now > window.end) return this.warp;

    // Aim for roughly 60 frames across the burn.
    const target = Math.max(1, window.duration / 1.5);
    return Math.min(this.warp, target);
  }

  /** When the planned node's engine burn runs, or null if there is no node. */
  get burnWindow(): { start: number; end: number; duration: number } | null {
    return this.node ? burnWindow(this.node, this.module) : null;
  }

  /** True while the engine is firing under autopilot control. */
  get burning(): boolean {
    const window = this.burnWindow;
    if (!window || !this.autopilot) return false;
    return this.system.time >= window.start && this.system.time < window.end;
  }

  /** The mother ship's state, Saturn-centred. */
  get motherShip() {
    return motherShipAt(this.system.time);
  }

  setNode(node: ManoeuvreNode | null): void {
    // Never accept a node whose burn has already half-elapsed: the autopilot
    // would fly only the remainder and quietly deliver half the velocity change.
    this.node = node ? schedulable(node, this.module, this.system.time) : null;
    this.predictionStale = true;
    this.notify();
  }

  /** Nudge one component of the node, m/s. */
  adjustNode(component: 'prograde' | 'normal' | 'radial', delta: number): void {
    if (!this.node) return;
    this.node = { ...this.node, [component]: this.node[component] + delta };
    this.predictionStale = true;
    this.notify();
  }

  /** Move the node in time, seconds. */
  slipNode(delta: number): void {
    if (!this.node) return;
    // Never behind the clock: a node in the past can no longer be flown, and
    // silently doing nothing is worse than refusing to go there.
    this.node = schedulable(
      { ...this.node, at: this.node.at + delta },
      this.module,
      this.system.time,
    );
    this.predictionStale = true;
    this.notify();
  }

  /** The module's orbit about whichever body it is currently governed by. */
  orbitAboutInfluence() {
    const index = this.influenceIndex;
    const gm = index === SATURN_INDEX ? SATURN_GM : this.system.bodies[index]?.gm ?? SATURN_GM;
    return osculatingElements(
      sub(this.probe.position, this.system.positionOf(index)),
      sub(this.probe.velocity, this.system.velocityOf(index)),
      gm,
    );
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

    /*
     * The autopilot outranks the throttle.
     *
     * Both could be made to add, and that would be wrong: a player who plans a
     * node and then forgets the throttle is still at 20% would fly a manoeuvre
     * that is not the one the prediction drew, and would have no way of seeing
     * why. While a node's window is open the engine belongs to it.
     */
    const auto = this.autopilot
      ? autopilotThrust(
          this.node,
          this.module,
          this.system.time,
          // The thrust is held across this whole interval, so the autopilot has
          // to know how long it is or it will over-run the end of the burn.
          seconds,
          sub(this.probe.position, this.system.positionOf(this.node?.referenceIndex ?? 0)),
          sub(this.probe.velocity, this.system.velocityOf(this.node?.referenceIndex ?? 0)),
        )
      : ZERO;

    const underAutopilot = length(auto) > 0;
    if (underAutopilot) {
      this.probe.thrust = auto;
    } else {
      const reference = this.module.referenceIndex;
      this.probe.thrust = thrustAcceleration(
        this.module,
        sub(this.probe.position, this.system.positionOf(reference)),
        sub(this.probe.velocity, this.system.velocityOf(reference)),
      );
    }

    const firing = underAutopilot || this.module.throttle > 0;
    if (firing && !this.module.infinitePropellant && this.module.propellant > 0) {
      const { state } = consumePropellant(
        underAutopilot ? { ...this.module, throttle: 1 } : this.module,
        seconds,
      );
      this.module = { ...state, throttle: this.module.throttle };
      this.predictionStale = true;
    }

    this.system.advance(seconds);
    this.sun = solarGeometry(this.system.time);

    // A node whose burn has finished has been flown, and keeping it on screen
    // would invite the player to "execute" it a second time.
    if (this.node && this.system.time >= burnWindow(this.node, this.module).end) {
      this.node = null;
      this.predictionStale = true;
    }

    this.influenceIndex = this.system.influenceAt(this.probe.position);
    this.updateMission();

    this.recordTrail();
    this.checkCollision();
  }

  /** Re-check the objectives against the module's orbit about Saturn. */
  private updateMission(): void {
    const orbit = osculatingElements(
      this.saturnCentred(this.probe.position),
      sub(this.probe.velocity, this.system.velocityOf(SATURN_INDEX)),
      SATURN_GM,
    );
    this.mission = evaluateMission(
      {
        time: this.system.time,
        position: this.saturnCentred(this.probe.position),
        velocity: sub(this.probe.velocity, this.system.velocityOf(SATURN_INDEX)),
        periapsis: orbit.periapsis,
        apoapsis: orbit.apoapsis,
        bound: orbit.bound,
      },
      this.objectives,
    );
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
    this.node = null;
    this.objectives.clear();
    this.updateMission();
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

    // Saturn's oblate field needs the real circular speed; a moon is a point
    // mass to well past the precision anyone will notice.
    const speed =
      index === SATURN_INDEX
        ? circularSpeedInField(vec3(radius, 0, 0))
        : circularSpeed(gm, radius);

    this.probe = {
      position: add(body, vec3(radius, 0, 0)),
      velocity: add(bodyVelocity, vec3(0, speed, 0)),
      thrust: ZERO,
    };
    this.system.probes = [this.probe];
    this.trail = [];
    this.prediction = null;
    this.predictionStale = true;
    this.crashed = null;
    this.node = null;
    this.followModule = true;
    this.influenceIndex = this.system.influenceAt(this.probe.position);
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
