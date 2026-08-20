/**
 * The interface around the canvas.
 *
 * Built once and then *updated*, rather than rebuilt each frame. That is not
 * an optimisation — 300 nodes would rebuild cheaply enough — it is a
 * correctness requirement: rebuilding would close every open panel, drop the
 * focus, and interrupt a slider mid-drag several times a second. So the
 * structure is constructed once, references to the changing text are kept, and
 * the update pass writes strings into them.
 *
 * Panels are ordered by how often a player touches them: the engine and the
 * navigation readout at the top on the right, the model's own settings below,
 * and the moon list — long, and browsed rather than operated — down the left.
 */

import { osculatingElements } from '@saturn/core/elements';
import { probeField } from '@saturn/core/field';
import {
  circulariseCost,
  deltaVRemaining,
  navigationReadout,
  totalMass,
  type ThrustMode,
} from '@saturn/core/module';
import { moonById, moonHillRadius, orbitalPeriod } from '@saturn/core/moons';
import {
  burnDuration,
  circulariseAtApoapsis,
  circulariseAtPeriapsis,
  emptyNode,
  hohmannTransfer,
  nodeFromAngles,
  nodeMagnitude,
  orbitAfter,
  raiseToRadius,
  type ManoeuvreNode,
} from '@saturn/core/manoeuvre';
import {
  OBJECTIVES,
  PARKING_RADIUS,
  RENDEZVOUS_DISTANCE,
  RENDEZVOUS_SPEED,
} from '@saturn/core/mission';
import { SATURN_EQUATORIAL_RADIUS, SATURN_GM } from '@saturn/core/saturn';
import { SATURN_INDEX } from '@saturn/core/system';
import { toDate } from '@saturn/core/time';
import {
  SECONDS_PER_DAY,
  escapeSpeed,
  massInKg,
  surfaceGravity,
} from '@saturn/core/units';
import { RAD, length, sub, type Vec3 } from '@saturn/core/vec';
import {
  formatDistance,
  formatDuration,
  formatExponent,
  formatNumber,
  formatDate,
  getLocale,
  setLocale,
  t,
} from '../i18n/i18n.js';
import type { Store } from '../state/store.js';
import { windowIsMeaningful } from '@saturn/core/transfer';
import { AttitudeDial } from './attitude.js';
import { button, div, element, panel, readout, select, slider, text, toggle } from './dom.js';

const THRUST_MODES: ThrustMode[] = [
  'prograde',
  'retrograde',
  'radial-out',
  'radial-in',
  'normal',
  'anti-normal',
  // Last, and set by dragging the dial rather than by pressing this — the
  // button is here so the mode is visible and can be returned to.
  'aimed',
];

/** Look-ahead options, in seconds. Geometric, from an orbit to a season. */
const LOOK_AHEAD = [
  3_600,
  6 * 3_600,
  SECONDS_PER_DAY,
  3 * SECONDS_PER_DAY,
  10 * SECONDS_PER_DAY,
  30 * SECONDS_PER_DAY,
  90 * SECONDS_PER_DAY,
];

export class Interface {
  private readonly root: HTMLElement;
  private readonly store: Store;
  private readonly onPredict: () => void;

  /** Nodes whose text is rewritten on the update pass. */
  private readonly values = new Map<string, HTMLElement>();
  private moonButtons = new Map<string, HTMLButtonElement>();
  private targetBody!: HTMLElement;
  private predictionBody!: HTMLElement;
  private fieldCursorBody!: HTMLElement;
  private crashLayer!: HTMLElement;
  private throttleInput!: HTMLInputElement;
  private modeButtons = new Map<ThrustMode, HTMLButtonElement>();
  private burnStatusBody!: HTMLElement;
  private dial!: AttitudeDial;
  private aimBody!: HTMLElement;
  private transferBody!: HTMLElement;
  private manoeuvreBody!: HTMLElement;
  private missionBody!: HTMLElement;

  /** Last position the pointer hovered, for the field readout. */
  cursorWorld: Vec3 | null = null;

  constructor(root: HTMLElement, store: Store, onPredict: () => void) {
    this.root = root;
    this.store = store;
    this.onPredict = onPredict;
    this.build();
  }

  private value(key: string, label: string, initial = '—'): HTMLElement {
    const row = readout(label, initial);
    this.values.set(key, row.lastElementChild as HTMLElement);
    return row;
  }

  private set(key: string, value: string, tone?: 'warn' | 'danger'): void {
    const node = this.values.get(key);
    if (!node) return;
    node.textContent = value;
    node.className = `readout-value${tone ? ` is-${tone}` : ''}`;
  }

  // ---------------------------------------------------------------- building

  private build(): void {
    this.root.replaceChildren();
    this.values.clear();
    this.moonButtons.clear();
    this.modeButtons.clear();

    /*
     * A cockpit rather than a document.
     *
     * Instruments frame the viewport on four sides and the middle is left
     * clear, because the middle is where Saturn and the trajectory are. The
     * flight controls — attitude, throttle, burn state — sit along the bottom
     * where a pilot's hands would be, and the planning instruments, which are
     * read rather than operated, go up the sides.
     */
    this.root.append(this.buildTopBar());
    this.root.append(
      div('column column-left', [
        this.buildNavigationPanel(),
        this.buildTargetPanel(),
        this.buildMoonPanel(),
      ]),
    );
    this.root.append(
      div('column column-right', [
        this.buildMissionPanel(),
        this.buildTransferPanel(),
        this.buildManoeuvrePanel(),
        this.buildPredictionPanel(),
        this.buildOverlayPanel(),
        this.buildFieldPanel(),
        this.buildAboutPanel(),
      ]),
    );
    this.root.append(this.buildFlightDeck());

    this.crashLayer = div('crash-layer is-hidden');
    this.root.append(this.crashLayer);
  }

  private buildTopBar(): HTMLElement {
    const warpDown = button('◀', () => this.store.setWarp(this.store.warpIndex - 1), {
      className: 'button button-icon',
    });
    const warpUp = button('▶', () => this.store.setWarp(this.store.warpIndex + 1), {
      className: 'button button-icon',
    });

    const pause = button(t('time.pause'), () => {
      this.store.paused = !this.store.paused;
      pause.textContent = this.store.paused ? t('time.resume') : t('time.pause');
      pause.classList.toggle('is-active', this.store.paused);
    });

    const language = button(t('action.language'), () => {
      setLocale(getLocale() === 'cs' ? 'en' : 'cs');
      this.build();
      this.update();
    });

    return div('topbar', [
      div('brand', [
        text('brand-title', t('app.title')),
        text('brand-subtitle', t('app.subtitle')),
      ]),
      div('topbar-group', [
        this.value('clock', t('time.date')),
        this.value('elapsed', t('time.elapsed')),
      ]),
      div('topbar-group topbar-warp', [
        text('readout-label', t('time.warp')),
        warpDown,
        this.value('warp', '', '1×'),
        warpUp,
        pause,
      ]),
      div('topbar-group', [
        button(t('action.reset'), () => this.store.reset()),
        language,
      ]),
    ]);
  }

  private buildTargetPanel(): HTMLElement {
    this.targetBody = div('panel-body');
    return panel(t('panel.target'), this.targetBody, true);
  }

  /**
   * The moon list, grouped.
   *
   * Fifty-three entries is too many for a flat list to be usable, and the groups
   * are not a filing convenience — they are the actual structure of the system.
   * Ring shepherds, the mid-sized icy moons, and three separate captured
   * populations on wildly different orbits.
   */
  private buildMoonPanel(): HTMLElement {
    const body = div('panel-body moon-list');

    const saturnButton = button(
      t('target.saturn'),
      () => this.store.select('saturn'),
      { className: 'moon-button' },
    );
    this.moonButtons.set('saturn', saturnButton);
    body.append(saturnButton);

    const groups = new Map<string, HTMLElement>();
    for (const moon of this.store.moonList) {
      let group = groups.get(moon.group);
      if (!group) {
        group = div('moon-group');
        group.append(text('moon-group-title', t(`group.${moon.group}`)));
        groups.set(moon.group, group);
        body.append(group);
      }
      const node = button(moon.name, () => this.store.select(moon.id), {
        className: 'moon-button',
      });
      this.moonButtons.set(moon.id, node);
      group.append(node);
    }

    return panel(t('panel.moons'), body, false);
  }

  private buildNavigationPanel(): HTMLElement {
    const body = div('panel-body', [
      this.value('reference', t('nav.relativeTo')),
      this.value('altitude', t('nav.altitude')),
      this.value('speed', t('nav.speed')),
      this.value('radialRate', t('nav.radialRate')),
      this.value('gravity', t('nav.gravity')),
      element('hr', { class: 'rule' }),
      this.value('periapsis', t('nav.periapsis')),
      this.value('apoapsis', t('nav.apoapsis')),
      this.value('period', t('nav.period')),
      this.value('eccentricity', t('nav.eccentricity')),
      this.value('inclination', t('nav.inclination')),
      this.value('toPeriapsis', t('nav.timeToPeriapsis')),
      element('hr', { class: 'rule' }),
      this.value('influence', t('nav.influence')),
      this.value('dominant', t('nav.dominantPull')),
    ]);
    return panel(t('panel.navigation'), body, true);
  }

  /**
   * The manoeuvre planner.
   *
   * Rebuilt wholesale on each update rather than patched in place, because the
   * *set* of controls changes with the state: with no node there is a row of
   * solvers, and with one there are nudge controls, a resulting orbit, and a
   * countdown. It carries no slider, so nothing can be interrupted mid-drag.
   */
  /**
   * The bottom strip: attitude, throttle, cardinal headings, burn state.
   *
   * Everything here is touched *while flying*, which is why it is one strip
   * rather than a panel in a column — a control reached for during a burn
   * should not be behind a scroll position or a collapsed section.
   */
  private buildFlightDeck(): HTMLElement {
    this.dial = new AttitudeDial(132, {
      onAim: (yaw, pitch) => this.store.setAim(yaw, pitch),
    });
    this.dial.draw();

    const throttle = slider(
      t('engine.throttle'),
      0,
      0,
      1,
      0.01,
      (value) => this.store.setThrottle(value),
      (value) => `${Math.round(value * 100)} %`,
    );
    this.throttleInput = throttle.querySelector('input') as HTMLInputElement;

    const modes = div('mode-grid');
    for (const mode of THRUST_MODES) {
      const node = button(t(`engine.mode.${mode}`), () => this.store.setMode(mode), {
        className: 'button button-mode',
      });
      this.modeButtons.set(mode, node);
      modes.append(node);
    }

    this.aimBody = div('aim-readout');
    this.burnStatusBody = div('burn-status');

    return div('deck', [
      div('deck-dial', [this.dial.element, text('deck-caption', t('engine.aimCaption'))]),
      div('deck-controls', [
        throttle,
        modes,
        div('deck-row', [
          button(t('engine.cut'), () => this.store.setThrottle(0)),
          button(t('engine.full'), () => this.store.setThrottle(1)),
          toggle(t('engine.autopilot'), this.store.autopilot, (v) => {
            this.store.autopilot = v;
          }),
        ]),
      ]),
      div('deck-status', [
        this.aimBody,
        this.value('propellant', t('engine.propellant')),
        this.value('deltaV', t('engine.deltaV')),
        this.value('circularise', t('engine.circulariseCost')),
        this.burnStatusBody,
      ]),
    ]);
  }

  /**
   * The transfer calculator.
   *
   * Two endpoints and the answer. Either may be a moon, and the origin may also
   * be the ship itself, because "from where I am to Titan" is the question
   * actually asked — a planner that insisted on a circular starting orbit would
   * be useless for most of a flight.
   *
   * The departure window is the reason this exists at all. The velocity change
   * to reach Titan's *orbit* is a sum anyone can do; leaving at the moment that
   * puts Titan at the meeting point is the part that takes an instrument.
   */
  private buildTransferPanel(): HTMLElement {
    this.transferBody = div('panel-body');
    return panel(t('panel.transfer'), this.transferBody, true);
  }

  private buildManoeuvrePanel(): HTMLElement {
    this.manoeuvreBody = div('panel-body');
    return panel(t('panel.manoeuvre'), this.manoeuvreBody, true);
  }

  private buildMissionPanel(): HTMLElement {
    this.missionBody = div('panel-body');
    return panel(t('panel.mission'), this.missionBody, true);
  }

  /**
   * One axis of the node, with symmetric nudge buttons.
   *
   * Three magnitudes per side, an order of magnitude apart. A slider would be
   * wrong here: the useful range runs from 1 m/s for a final trim to 10 000 m/s
   * for a departure burn, and no linear control covers both while staying
   * precise at the bottom.
   */
  private nudgeRow(
    label: string,
    value: number,
    onDelta: (delta: number) => void,
  ): HTMLElement {
    const row = div('nudge-row');
    row.append(text('nudge-label', label));

    for (const step of [100, 10, 1]) {
      row.append(
        button(`-${step}`, () => onDelta(-step), { className: 'button button-nudge' }),
      );
    }
    row.append(text('nudge-value', formatNumber(value, 1)));
    for (const step of [1, 10, 100]) {
      row.append(
        button(`+${step}`, () => onDelta(step), { className: 'button button-nudge' }),
      );
    }
    return row;
  }

  /**
   * Keep the dial showing where the engine is actually pointed.
   *
   * Under a cardinal mode the dial is a *readout* — it shows where "prograde"
   * or "normal" currently is, rather than a heading the player set — so it is
   * drawn dimmed. Free aim lights it up. Without that distinction the dial
   * would look identical whether or not it was in control of anything.
   */
  private updateAim(): void {
    const store = this.store;
    const mode = store.module.mode;

    if (mode === 'aimed') {
      this.dial.set(store.module.aimYaw, store.module.aimPitch);
      this.dial.cardinal = false;
    } else {
      const cardinalAngles: Record<string, [number, number]> = {
        prograde: [0, 0],
        retrograde: [Math.PI, 0],
        'radial-out': [Math.PI / 2, 0],
        'radial-in': [-Math.PI / 2, 0],
        normal: [0, Math.PI / 2],
        'anti-normal': [0, -Math.PI / 2],
        inertial: [0, 0],
      };
      const [yaw, pitch] = cardinalAngles[mode] ?? [0, 0];
      this.dial.set(yaw, pitch);
      this.dial.cardinal = true;
    }

    this.dial.active = store.burning || store.module.throttle > 0;
    this.dial.throttle = store.burning ? 1 : store.module.throttle;
    this.dial.draw();

    const { yaw, pitch } = this.dial.degrees();
    this.aimBody.replaceChildren(
      readout(t('engine.yaw'), `${formatNumber(yaw, 1)}°`),
      readout(t('engine.pitch'), `${formatNumber(pitch, 1)}°`),
    );
  }

  private updateTransfer(): void {
    const store = this.store;
    const body = this.transferBody;
    body.replaceChildren();

    const options = [
      { value: 'module', label: t('transfer.module') },
      ...store.moonList.map((moon) => ({ value: moon.id, label: moon.name })),
    ];

    body.append(
      div('transfer-row', [
        text('readout-label', t('transfer.from')),
        select(store.transferFrom, options, (value) => {
          store.transferFrom = value;
          this.updateTransfer();
        }),
      ]),
      div('transfer-row', [
        text('readout-label', t('transfer.to')),
        select(
          store.transferTo,
          options.filter((option) => option.value !== 'module'),
          (value) => {
            store.transferTo = value;
            this.updateTransfer();
          },
        ),
      ]),
    );

    store.updateTransfer();
    const solution = store.transfer;
    if (!solution) {
      body.append(text('panel-help', t('transfer.unavailable')));
      return;
    }

    body.append(element('hr', { class: 'rule' }));
    body.append(
      readout(t('transfer.departure'), `${formatNumber(solution.departureDeltaV, 0)} m/s`),
      readout(t('transfer.arrival'), `${formatNumber(solution.arrivalDeltaV, 0)} m/s`),
      readout(t('transfer.total'), `${formatNumber(solution.totalDeltaV, 0)} m/s`),
    );

    if (solution.planeChangeDeltaV > 1) {
      body.append(
        readout(
          t('transfer.planeChange'),
          `${formatNumber(solution.planeChangeDeltaV, 0)} m/s`,
          'warn',
        ),
      );
    }

    body.append(readout(t('transfer.flightTime'), formatDuration(solution.flightTime)));

    if (windowIsMeaningful(solution)) {
      body.append(element('hr', { class: 'rule' }));
      body.append(text('panel-help', t('transfer.windowHelp')));
      body.append(
        readout(
          t('transfer.requiredPhase'),
          `${formatNumber(solution.requiredPhase * RAD, 1)}°`,
        ),
        readout(
          t('transfer.currentPhase'),
          `${formatNumber(solution.currentPhase * RAD, 1)}°`,
        ),
        readout(
          t('transfer.window'),
          formatDuration(solution.timeToWindow),
          solution.timeToWindow < 3_600 ? 'warn' : undefined,
        ),
        readout(t('transfer.synodic'), formatDuration(solution.synodicPeriod)),
      );
    }

    // The departure burn is only the ship's to make when the ship is leaving.
    if (store.transferFrom === 'module') {
      body.append(
        button(
          t('transfer.planDeparture'),
          () => {
            const index = store.influenceIndex;
            const base = emptyNode(
              store.system.time + Math.max(60, solution.timeToWindow),
              index,
            );
            store.setNode(
              nodeFromAngles(
                base,
                Math.abs(solution.departureDeltaV),
                solution.departureDeltaV < 0 ? Math.PI : 0,
                0,
              ),
            );
          },
          { className: 'button button-primary' },
        ),
      );
    }
  }

  private updateManoeuvre(): void {
    const store = this.store;
    const body = this.manoeuvreBody;
    body.replaceChildren();

    /*
     * Manoeuvres are planned in the frame the module is actually in, not the
     * one the player happens to have selected.
     *
     * Those differ constantly — a player looking at Titan while flying a low
     * Saturn orbit is the normal case — and relative to a body the module is
     * not bound to, the orbit is hyperbolic and every solver correctly returns
     * nothing. The button then does nothing at all, which reads as broken.
     * Planning in the sphere of influence is also the only frame in which
     * "circularise" means anything.
     */
    const index = store.influenceIndex;
    const gm =
      index === SATURN_INDEX ? SATURN_GM : store.system.bodies[index]?.gm ?? SATURN_GM;
    const relative = sub(store.probe.position, store.system.positionOf(index));
    const relativeVelocity = sub(store.probe.velocity, store.system.velocityOf(index));
    const orbit = osculatingElements(relative, relativeVelocity, gm);
    const now = store.system.time;
    const frameName =
      index === SATURN_INDEX
        ? t('target.saturn')
        : store.moonName(store.system.bodies[index]?.id ?? 'saturn');

    if (!store.node) {
      body.append(text('panel-help', t('manoeuvre.help')));
      body.append(readout(t('manoeuvre.frame'), frameName));

      if (!orbit.bound) {
        // Nothing to circularise and nothing to raise; say so rather than
        // offering buttons that quietly decline.
        body.append(text('panel-help is-warn', t('manoeuvre.unbound')));
      }

      const add = (node: ManoeuvreNode | null): void => {
        if (node) store.setNode(node);
      };

      body.append(
        div('solver-grid', [
          button(t('manoeuvre.circulariseApo'), () =>
            add(circulariseAtApoapsis(now, orbit, gm, index)),
          ),
          button(t('manoeuvre.circularisePeri'), () =>
            add(circulariseAtPeriapsis(now, orbit, gm, index)),
          ),
          button(t('manoeuvre.raiseTitan'), () =>
            add(raiseToRadius(now, orbit, gm, 1_221_870, index)),
          ),
          button(t('manoeuvre.raiseParking'), () =>
            add(raiseToRadius(now, orbit, gm, PARKING_RADIUS, index)),
          ),
        ]),
      );

      body.append(
        button(t('manoeuvre.addBlank'), () => store.setNode(emptyNode(now + 600, index)), {
          className: 'button button-primary',
        }),
      );

      // What the textbook transfer to the parking orbit costs from here, so the
      // player can see whether this is anywhere near a good place to depart.
      const plan = hohmannTransfer(relative, relativeVelocity, gm, PARKING_RADIUS);
      body.append(element('hr', { class: 'rule' }));
      body.append(text('panel-help', t('manoeuvre.transferHint')));
      body.append(readout(t('manoeuvre.departure'), `${formatNumber(plan.departure, 0)} m/s`));
      body.append(readout(t('manoeuvre.arrival'), `${formatNumber(plan.arrival, 0)} m/s`));
      body.append(readout(t('manoeuvre.flightTime'), formatDuration(plan.flightTime)));
      return;
    }

    const node = store.node;
    const magnitude = nodeMagnitude(node);
    const duration = burnDuration(node, store.module);
    const countdown = node.at - now;

    body.append(
      readout(t('manoeuvre.frame'), frameName),
      readout(t('manoeuvre.total'), `${formatNumber(magnitude, 1)} m/s`),
      readout(
        t('manoeuvre.countdown'),
        countdown > 0 ? formatDuration(countdown) : t('manoeuvre.now'),
        countdown < duration / 2 ? 'warn' : undefined,
      ),
      readout(t('manoeuvre.burnLength'), formatDuration(duration)),
    );

    body.append(element('hr', { class: 'rule' }));
    body.append(
      this.nudgeRow(t('manoeuvre.prograde'), node.prograde, (d) =>
        store.adjustNode('prograde', d),
      ),
      this.nudgeRow(t('manoeuvre.normal'), node.normal, (d) =>
        store.adjustNode('normal', d),
      ),
      this.nudgeRow(t('manoeuvre.radial'), node.radial, (d) =>
        store.adjustNode('radial', d),
      ),
    );

    body.append(
      div('nudge-row', [
        text('nudge-label', t('manoeuvre.timing')),
        button('-1h', () => store.slipNode(-3_600), { className: 'button button-nudge' }),
        button('-10m', () => store.slipNode(-600), { className: 'button button-nudge' }),
        button('-1m', () => store.slipNode(-60), { className: 'button button-nudge' }),
        text('nudge-value', ''),
        button('+1m', () => store.slipNode(60), { className: 'button button-nudge' }),
        button('+10m', () => store.slipNode(600), { className: 'button button-nudge' }),
        button('+1h', () => store.slipNode(3_600), { className: 'button button-nudge' }),
      ]),
    );

    // Two-body preview of what the burn does, updated instantly. The predicted
    // path in the scene is the authority; this fills the second before the
    // worker answers, and a control with a second of lag is unusable.
    const after = orbitAfter(node, relative, relativeVelocity, gm);
    const radius =
      index === SATURN_INDEX
        ? SATURN_EQUATORIAL_RADIUS
        : store.system.bodies[index]?.radius ?? 0;

    body.append(element('hr', { class: 'rule' }));
    body.append(text('panel-help', t('manoeuvre.resulting')));
    body.append(
      readout(
        t('nav.periapsis'),
        formatDistance(after.periapsis - radius),
        after.periapsis < radius ? 'danger' : undefined,
      ),
      readout(
        t('nav.apoapsis'),
        after.bound ? formatDistance(after.apoapsis - radius) : t('nav.unbound'),
      ),
    );

    body.append(
      div('button-row', [
        button(t('manoeuvre.clear'), () => store.setNode(null)),
        button(
          t('manoeuvre.executeNow'),
          () => {
            // Bring the node to the present, allowing half the burn's length so
            // the autopilot still gets its symmetric window.
            store.setNode({
              ...node,
              at: now + burnDuration(node, store.module) / 2 + 1,
            });
          },
          { className: 'button button-primary' },
        ),
      ]),
    );
  }

  private updateMission(): void {
    const store = this.store;
    const body = this.missionBody;
    body.replaceChildren();

    const progress = store.mission;
    if (!progress) return;

    body.append(text('panel-help', t('mission.brief')));

    for (const objective of OBJECTIVES) {
      const done = progress.achieved.has(objective.id);
      const current = progress.current === objective.id;
      body.append(
        div(`objective${done ? ' is-done' : ''}${current ? ' is-current' : ''}`, [
          text('objective-mark', done ? 'OK' : current ? '>' : '-'),
          text('objective-label', t(`mission.objective.${objective.id}`)),
        ]),
      );
    }

    body.append(element('hr', { class: 'rule' }));
    body.append(
      readout(
        t('mission.distance'),
        formatDistance(progress.distance),
        progress.distance < RENDEZVOUS_DISTANCE ? 'warn' : undefined,
      ),
      readout(
        t('mission.relativeSpeed'),
        `${formatNumber(progress.relativeSpeed * 1000, 1)} m/s`,
        progress.relativeSpeed < RENDEZVOUS_SPEED ? 'warn' : undefined,
      ),
    );

    if (progress.complete) {
      body.append(text('panel-help is-success', t('mission.complete')));
    }

    body.append(
      button(t('mission.frameShip'), () => {
        store.followModule = false;
        store.camera.frame(store.motherShip.position, 40_000);
      }),
    );
  }

  private updateBurnStatus(): void {
    const store = this.store;
    const body = this.burnStatusBody;
    body.replaceChildren();

    const window = store.burnWindow;
    if (!window) return;

    if (store.burning) {
      const left = window.end - store.system.time;
      body.append(text('burn-live', t('engine.burning', { time: formatDuration(left) })));
    } else if (store.system.time < window.start) {
      body.append(
        text(
          'panel-help',
          t('engine.ignition', {
            time: formatDuration(window.start - store.system.time),
          }),
        ),
      );
    }

    // The warp clamp is deliberate and needs saying, or it reads as a stall.
    if (store.effectiveWarp < store.warp) {
      body.append(text('panel-help is-warn', t('engine.warpHeld')));
    }
  }

  private buildOverlayPanel(): HTMLElement {
    const overlays = this.store.overlays;
    const body = div('panel-body', [
      toggle(t('overlay.orbits'), overlays.orbits, (v) => (overlays.orbits = v)),
      toggle(t('overlay.moonLabels'), overlays.moonLabels, (v) => (overlays.moonLabels = v)),
      toggle(t('overlay.trail'), overlays.trail, (v) => (overlays.trail = v)),
      toggle(t('overlay.prediction'), overlays.prediction, (v) => (overlays.prediction = v)),
      toggle(t('overlay.sunArrow'), overlays.sunArrow, (v) => (overlays.sunArrow = v)),
      toggle(t('overlay.shadows'), overlays.shadows, (v) => (overlays.shadows = v)),
      toggle(t('overlay.hillSpheres'), overlays.hillSpheres, (v) => (overlays.hillSpheres = v)),
      toggle(t('overlay.influence'), overlays.influence, (v) => (overlays.influence = v)),
      toggle(t('overlay.mission'), overlays.mission, (v) => (overlays.mission = v)),
      element('hr', { class: 'rule' }),
      toggle(t('target.follow'), this.store.followModule, (v) => (this.store.followModule = v)),
      toggle(t('camera.autoZoom'), this.store.autoZoom, (v) => {
        this.store.autoZoom = v;
      }),
      div('button-row', [
        button(t('camera.zoomToShip'), () => this.store.zoomToShip(), {
          className: 'button button-primary',
        }),
        button(t('camera.faceSun'), () =>
          this.store.camera.faceSun(this.store.sun.direction),
        ),
        button(t('camera.topDown'), () => {
          // Straight down the pole: the undistorted diagram, for reading orbits
          // rather than looking at Saturn.
          this.store.camera.tilt = 0;
        }),
      ]),
    ]);
    return panel(t('panel.overlays'), body, true);
  }

  private buildFieldPanel(): HTMLElement {
    const settings = this.store.field;
    const help = text('panel-help', t(`field.mode.help.${settings.mode}`));

    const modeSelect = select(
      settings.mode,
      [
        { value: 'absolute' as const, label: t('field.mode.absolute') },
        { value: 'relative' as const, label: t('field.mode.relative') },
        { value: 'rotating' as const, label: t('field.mode.rotating') },
      ],
      (value) => {
        settings.mode = value;
        help.textContent = t(`field.mode.help.${value}`);
      },
    );

    this.fieldCursorBody = div('field-cursor');

    const body = div('panel-body', [
      toggle(t('overlay.field'), this.store.overlays.field, (v) => {
        this.store.overlays.field = v;
      }),
      div('field-row', [text('readout-label', t('field.mode')), modeSelect]),
      help,
      slider(
        t('field.resolution'),
        settings.resolution,
        7,
        33,
        2,
        (value) => (settings.resolution = value),
        (value) => `${value}×${value}`,
      ),
      this.fieldCursorBody,
    ]);
    return panel(t('panel.field'), body, false);
  }

  private buildPredictionPanel(): HTMLElement {
    const settings = this.store.predictionSettings;
    this.predictionBody = div('prediction-results');

    const body = div('panel-body', [
      text('panel-help', t('prediction.help')),
      slider(
        t('prediction.duration'),
        LOOK_AHEAD.indexOf(settings.duration) < 0 ? 3 : LOOK_AHEAD.indexOf(settings.duration),
        0,
        LOOK_AHEAD.length - 1,
        1,
        (index) => {
          settings.duration = LOOK_AHEAD[index] ?? SECONDS_PER_DAY;
          this.store.predictionStale = true;
        },
        (index) => formatDuration(LOOK_AHEAD[index] ?? SECONDS_PER_DAY),
      ),
      slider(
        t('prediction.ghosts'),
        settings.ghosts,
        0,
        10,
        1,
        (value) => {
          settings.ghosts = value;
          this.store.predictionStale = true;
        },
      ),
      slider(
        t('prediction.step'),
        settings.step,
        30,
        600,
        30,
        (value) => {
          settings.step = value;
          this.store.predictionStale = true;
        },
        (value) => `${value} s`,
      ),
      button(t('prediction.compute'), () => this.onPredict(), {
        className: 'button button-primary',
      }),
      this.predictionBody,
    ]);
    return panel(t('panel.prediction'), body, true);
  }

  private buildAboutPanel(): HTMLElement {
    const body = div('panel-body', [
      text('panel-help', t('about.text')),
      text('panel-help', t('about.accuracy')),
      element('hr', { class: 'rule' }),
      text('panel-help', `${t('help.pan')} · ${t('help.zoom')} · ${t('help.rotate')}`),
      text('panel-help', `${t('help.pick')} · ${t('help.throttle')} · ${t('help.warp')} · ${t('help.pauseKey')}`),
    ]);
    return panel(t('panel.about'), body, false);
  }

  // ---------------------------------------------------------------- updating

  /** Rewrite everything that changes. Called a few times a second, not per frame. */
  update(): void {
    const store = this.store;
    const system = store.system;

    this.set('clock', formatDate(toDate(system.time)));
    this.set('elapsed', formatDuration(system.time));
    this.set('warp', `${store.warp.toLocaleString(getLocale() === 'cs' ? 'cs-CZ' : 'en-GB')}×`);

    for (const [id, node] of this.moonButtons) {
      node.classList.toggle('is-active', id === store.selection);
    }
    for (const [mode, node] of this.modeButtons) {
      node.classList.toggle('is-active', mode === store.module.mode);
    }
    if (document.activeElement !== this.throttleInput) {
      this.throttleInput.value = String(store.module.throttle);
    }

    this.updateNavigation();
    this.updateEngine();
    this.updateAim();
    this.updateTransfer();
    this.updateBurnStatus();
    this.updateManoeuvre();
    this.updateMission();
    this.updateTarget();
    this.updatePrediction();
    this.updateFieldCursor();
    this.updateCrash();
  }

  private updateNavigation(): void {
    const store = this.store;
    const index = store.selectedIndex;
    const system = store.system;

    const bodyPosition = system.positionOf(index);
    const bodyVelocity = system.velocityOf(index);
    const radius =
      index === SATURN_INDEX ? SATURN_EQUATORIAL_RADIUS : system.bodies[index]?.radius ?? 1;

    const nav = navigationReadout(
      store.probe.position,
      store.probe.velocity,
      bodyPosition,
      bodyVelocity,
      radius,
      // The real local field, sampled where the module is.
      probeFieldVector(store),
    );

    this.set('reference', store.moonName(store.selection ?? 'saturn'));
    this.set(
      'altitude',
      formatDistance(nav.altitude),
      nav.altitude < radius * 0.05 ? 'danger' : undefined,
    );
    this.set('speed', `${formatNumber(nav.speed, 3)} km/s`);
    this.set('radialRate', `${formatNumber(nav.radialRate * 1000, 1)} m/s`);
    this.set('gravity', `${formatExponent(nav.gravity)} m/s²`);

    const orbit = osculatingElements(
      sub(store.probe.position, bodyPosition),
      sub(store.probe.velocity, bodyVelocity),
      index === SATURN_INDEX ? SATURN_GM : system.bodies[index]?.gm ?? SATURN_GM,
    );

    if (orbit.bound) {
      this.set(
        'periapsis',
        formatDistance(orbit.periapsis - radius),
        orbit.periapsis < radius ? 'danger' : undefined,
      );
      this.set('apoapsis', formatDistance(orbit.apoapsis - radius));
      this.set('period', formatDuration(orbit.period));
      this.set('toPeriapsis', formatDuration(orbit.timeToPeriapsis));
    } else {
      this.set('periapsis', formatDistance(orbit.periapsis - radius));
      this.set('apoapsis', t('nav.unbound'), 'warn');
      this.set('period', '—');
      this.set('toPeriapsis', '—');
    }
    this.set('eccentricity', formatNumber(orbit.e, 4));
    this.set('inclination', `${formatNumber(orbit.i * RAD, 2)}°`);

    // Which body actually governs the module, which is not the same question as
    // which body pulls hardest — Saturn pulls hardest almost everywhere.
    const influence = store.influenceIndex;
    this.set(
      'influence',
      influence === SATURN_INDEX
        ? t('target.saturn')
        : store.moonName(store.system.bodies[influence]?.id ?? 'saturn'),
      influence === SATURN_INDEX ? undefined : 'warn',
    );

    const probe = probeField(store.system, store.saturnCentred(store.probe.position));
    const dominant = probe.contributions[0];
    this.set(
      'dominant',
      dominant
        ? `${store.moonName(dominant.id)} · ${formatNumber(dominant.share * 100, 1)} %`
        : '—',
    );
  }

  private updateEngine(): void {
    const store = this.store;

    // With the tanks unlimited both figures are meaningless as numbers, and
    // printing "Infinity m/s" is worse than saying so.
    if (store.module.infinitePropellant) {
      this.set('propellant', t('engine.unlimited'));
      this.set('deltaV', t('engine.unlimited'));
    } else {
      const empty = store.module.propellant <= 0;
      this.set(
        'propellant',
        empty
          ? t('engine.empty')
          : `${formatNumber(store.module.propellant, 0)} kg / ${formatNumber(totalMass(store.module), 0)} kg`,
        empty ? 'danger' : store.module.propellant < 100 ? 'warn' : undefined,
      );
      this.set('deltaV', `${formatNumber(deltaVRemaining(store.module), 0)} m/s`);
    }

    const index = store.selectedIndex;
    const cost = circulariseCost(
      sub(store.probe.position, store.system.positionOf(index)),
      sub(store.probe.velocity, store.system.velocityOf(index)),
      index === SATURN_INDEX ? SATURN_GM : store.system.bodies[index]?.gm ?? SATURN_GM,
    );
    this.set('circularise', `${formatNumber(cost, 0)} m/s`);
  }

  /**
   * The selected body's own figures.
   *
   * Rebuilt rather than updated in place, because the *set* of rows changes:
   * Saturn has no orbital period about itself, an estimated GM is flagged where
   * a measured one is not, and only some moons carry a note.
   */
  private updateTarget(): void {
    const store = this.store;
    const id = store.selection ?? 'saturn';
    const body = this.targetBody;
    body.replaceChildren();

    if (id === 'saturn') {
      body.append(
        readout(t('target.radius'), formatDistance(SATURN_EQUATORIAL_RADIUS)),
        readout(t('target.gm'), `${formatExponent(SATURN_GM)} km³/s²`),
        readout(t('target.mass'), `${formatExponent(massInKg(SATURN_GM))} kg`),
        readout(
          t('target.surfaceGravity'),
          `${formatNumber(surfaceGravity(SATURN_GM, SATURN_EQUATORIAL_RADIUS), 2)} m/s²`,
        ),
        readout(
          t('target.escape'),
          `${formatNumber(escapeSpeed(SATURN_GM, SATURN_EQUATORIAL_RADIUS), 2)} km/s`,
        ),
      );
    } else {
      const moon = moonById(id);
      if (!moon) return;

      body.append(
        readout(t('target.group'), t(`group.${moon.group}`)),
        readout(t('target.radius'), formatDistance(moon.radius)),
        readout(
          t('target.gm'),
          `${formatExponent(moon.gm)} km³/s²${moon.gmMeasured ? '' : ` · ${t('target.gmEstimated')}`}`,
        ),
        readout(t('target.mass'), `${formatExponent(massInKg(moon.gm))} kg`),
        readout(
          t('target.surfaceGravity'),
          `${formatExponent(surfaceGravity(moon.gm, moon.radius))} m/s²`,
        ),
        readout(t('target.albedo'), formatNumber(moon.albedo, 3)),
        readout(t('target.orbitRadius'), formatDistance(moon.elements.a)),
        readout(t('target.orbitPeriod'), formatDuration(orbitalPeriod(moon, SATURN_GM))),
        readout(t('target.hill'), formatDistance(moonHillRadius(moon, SATURN_GM))),
        readout(t('target.escape'), `${formatNumber(escapeSpeed(moon.gm, moon.radius) * 1000, 1)} m/s`),
      );

      if (moon.note) body.append(text('panel-help', t(`moon.note.${moon.id}`)));
    }

    body.append(
      div('button-row', [
        button(t('target.goTo'), () => {
          const index = store.selectedIndex;
          store.followModule = false;
          store.camera.frame(
            store.system.saturnCentred(index),
            index === SATURN_INDEX ? SATURN_EQUATORIAL_RADIUS * 5 : (store.system.bodies[index]?.radius ?? 1) * 6,
          );
        }),
        button(t('target.placeInOrbit'), () => store.placeInOrbit(), {
          className: 'button button-primary',
        }),
      ]),
    );
  }

  private updatePrediction(): void {
    const store = this.store;
    const body = this.predictionBody;
    body.replaceChildren();

    if (store.predictionPending) {
      body.append(text('panel-help', t('prediction.pending')));
      return;
    }
    if (!store.prediction) return;

    const prediction = store.prediction;

    if (store.predictionStale) {
      body.append(text('panel-help is-warn', t('prediction.stale')));
    }

    body.append(
      text(
        'panel-help',
        t('prediction.cost', {
          steps: Math.round(store.predictionSettings.duration / store.predictionSettings.step),
          ms: Math.round(prediction.elapsedMs),
        }),
      ),
    );

    if (prediction.impact) {
      const name =
        prediction.impact.bodyIndex === SATURN_INDEX
          ? t('target.saturn')
          : store.moonName(store.system.bodies[prediction.impact.bodyIndex]?.id ?? '?');
      body.append(
        text(
          'panel-help is-danger',
          t('prediction.impact', {
            body: name,
            time: formatDuration(prediction.impact.time),
          }),
        ),
      );
    }

    const notable = prediction.approaches
      .filter((approach) => approach.bodyIndex !== SATURN_INDEX)
      .slice(0, 4);

    if (notable.length === 0) {
      body.append(text('panel-help', t('prediction.noApproach')));
    } else {
      for (const approach of notable) {
        const moon = store.system.bodies[approach.bodyIndex];
        if (!moon) continue;
        body.append(
          readout(
            moon.name,
            `${formatDistance(approach.distance - moon.radius)} · ${formatDuration(approach.time)}`,
            approach.distance < moon.radius * 3 ? 'warn' : undefined,
          ),
        );
      }
    }
  }

  private updateFieldCursor(): void {
    const body = this.fieldCursorBody;
    body.replaceChildren();
    if (!this.cursorWorld || !this.store.overlays.field) return;

    const probe = probeField(this.store.system, this.cursorWorld);
    body.append(
      readout(t('field.atCursor'), `${formatExponent(probe.magnitude)} m/s²`),
      text('readout-label', t('field.strongest')),
    );
    for (const contribution of probe.contributions.slice(0, 3)) {
      body.append(
        readout(
          this.store.moonName(contribution.id),
          `${formatNumber(contribution.share * 100, 1)} %`,
        ),
      );
    }
  }

  private updateCrash(): void {
    const crashed = this.store.crashed;
    this.crashLayer.classList.toggle('is-hidden', crashed === null);
    if (!crashed) return;
    if (this.crashLayer.childElementCount > 0) return;

    this.crashLayer.append(
      div('crash-card', [
        text('crash-title', t('crash.title')),
        text(
          'crash-body',
          t('crash.body', {
            body: this.store.moonName(crashed.body),
            speed: formatNumber(crashed.speed, 2),
          }),
        ),
        button(t('crash.restart'), () => {
          this.store.reset();
          this.crashLayer.replaceChildren();
        }, { className: 'button button-primary' }),
      ]),
    );
  }
}

/** The gravitational acceleration where the module is, in the display frame. */
function probeFieldVector(store: Store): Vec3 {
  const probe = probeField(store.system, store.saturnCentred(store.probe.position));
  return {
    x: probe.direction.x * probe.magnitude * 1e-3,
    y: probe.direction.y * probe.magnitude * 1e-3,
    z: probe.direction.z * probe.magnitude * 1e-3,
  };
}

/** Distance between two world points, for callers that only need the number. */
export const separation = (a: Vec3, b: Vec3): number => length(sub(a, b));
