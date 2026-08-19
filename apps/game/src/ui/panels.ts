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
import { button, div, element, panel, readout, select, slider, text, toggle } from './dom.js';

const THRUST_MODES: ThrustMode[] = [
  'prograde',
  'retrograde',
  'radial-out',
  'radial-in',
  'normal',
  'anti-normal',
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

    this.root.append(this.buildTopBar());
    this.root.append(
      div('column column-left', [this.buildTargetPanel(), this.buildMoonPanel()]),
    );
    this.root.append(
      div('column column-right', [
        this.buildNavigationPanel(),
        this.buildEnginePanel(),
        this.buildOverlayPanel(),
        this.buildFieldPanel(),
        this.buildPredictionPanel(),
        this.buildAboutPanel(),
      ]),
    );

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
      this.value('dominant', t('nav.dominantPull')),
    ]);
    return panel(t('panel.navigation'), body, true);
  }

  private buildEnginePanel(): HTMLElement {
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

    const body = div('panel-body', [
      throttle,
      modes,
      this.value('propellant', t('engine.propellant')),
      this.value('deltaV', t('engine.deltaV')),
      this.value('circularise', t('engine.circularise', { cost: '' })),
    ]);
    return panel(t('panel.engine'), body, true);
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
      element('hr', { class: 'rule' }),
      toggle(t('target.follow'), this.store.followModule, (v) => (this.store.followModule = v)),
      div('button-row', [
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
    const empty = store.module.propellant <= 0;

    this.set(
      'propellant',
      empty
        ? t('engine.empty')
        : `${formatNumber(store.module.propellant, 0)} kg / ${formatNumber(totalMass(store.module), 0)} kg`,
      empty ? 'danger' : store.module.propellant < 100 ? 'warn' : undefined,
    );
    this.set('deltaV', `${formatNumber(deltaVRemaining(store.module), 0)} m/s`);

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
