/**
 * Entry point: the canvas, the loop, and the input.
 *
 * ## The loop's one hard decision
 *
 * At a warp of 200 000, a single 60 Hz frame covers 3 300 seconds of simulated
 * time — 55 integration steps over 1 431 body pairs each. That fits, but only
 * just, and it fits on this machine rather than on every machine. So the loop
 * caps the number of steps it will take in one frame and lets the clock fall
 * behind rather than dropping the frame: a game that stutters is worse than one
 * that quietly runs at 150 000 instead of 200 000, and the readout shows the
 * warp actually achieved.
 *
 * What it never does is enlarge the step to catch up. The step size is what
 * keeps Pan's orbit resolved; trading it for wall-clock speed would let the
 * inner moons come apart, and the player would have no way of knowing that the
 * system they are flying in had stopped being the one the model describes.
 */

import { SATURN_INDEX } from '@saturn/core/system';
import { getLocale, setLocale } from './i18n/i18n.js';
import { drawScene, lastDrawn } from './render/scene.js';
import { Predictor } from './sim/predictor.js';
import { Store } from './state/store.js';
import { Interface } from './ui/panels.js';
import './style.css';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const ctx = canvas.getContext('2d', { alpha: false })!;

const store = new Store();

const predictor = new Predictor((prediction) => {
  store.prediction = prediction;
  store.predictionPending = false;
  store.predictionStale = false;
});

const panels = new Interface(ui, store, () => predictor.request(store));

setLocale(getLocale());

// ------------------------------------------------------------------- sizing

function resize(): void {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = window.innerWidth;
  const height = window.innerHeight;

  // Nothing to lay out yet, and writing a zero-width canvas would make every
  // later `getImageData` throw rather than simply return nothing.
  if (width === 0 || height === 0) return;

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  // Draw in CSS pixels and let the transform handle the device ratio, so
  // nothing downstream has to know about it.
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  store.camera.resize(width, height);
}

/*
 * Watch the element, not the window.
 *
 * A `resize` event only fires when the *window* changes, which misses the case
 * that actually breaks things: a page that loads while its container has no
 * size at all — a hidden pane, a background tab, a collapsed panel. There the
 * first measurement is 0 x 0, no resize event ever follows, and the canvas
 * stays blank forever with nothing in the console to say why.
 *
 * A ResizeObserver sees the element get its size whenever that happens, and
 * covers the ordinary window case as well.
 */
const observer = new ResizeObserver(() => resize());
observer.observe(document.body);
window.addEventListener('resize', resize);
resize();

// -------------------------------------------------------------------- input

let dragging: 'pan' | 'orbit' | null = null;
let lastX = 0;
let lastY = 0;
let dragDistance = 0;

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  dragging = event.button === 2 || event.shiftKey ? 'orbit' : 'pan';
  lastX = event.clientX;
  lastY = event.clientY;
  dragDistance = 0;
});

canvas.addEventListener('pointermove', (event) => {
  const dx = event.clientX - lastX;
  const dy = event.clientY - lastY;
  lastX = event.clientX;
  lastY = event.clientY;

  if (dragging) {
    dragDistance += Math.abs(dx) + Math.abs(dy);
    if (dragging === 'pan') {
      store.followModule = false;
      store.camera.panBy(dx, dy);
    } else {
      store.camera.orbitBy(dx * 0.005, -dy * 0.005);
    }
  }

  panels.cursorWorld = store.camera.unproject(event.clientX, event.clientY);
});

canvas.addEventListener('pointerup', (event) => {
  canvas.releasePointerCapture(event.pointerId);
  const wasDragging = dragging;
  dragging = null;

  // A click, not the end of a drag.
  if (wasDragging === 'pan' && dragDistance < 5) pick(event.clientX, event.clientY);
});

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    // Normalise across the three deltaMode conventions, then move by a fixed
    // ratio per notch so zooming feels the same everywhere in the range.
    const notches = event.deltaMode === 1 ? event.deltaY / 3 : event.deltaY / 100;
    store.camera.zoomBy(Math.pow(1.22, notches), event.clientX, event.clientY);
  },
  { passive: false },
);

/**
 * Select whatever was clicked.
 *
 * Picks against where bodies were *drawn*, not where they are, because most
 * moons are drawn larger than their true size — clicking the dot that
 * represents Daphnis should select Daphnis, even though the real moon is a
 * millionth of a pixel across.
 */
function pick(clientX: number, clientY: number): void {
  let best: string | null = null;
  let bestDistance = 22;

  for (const entry of lastDrawn) {
    const distance = Math.hypot(entry.screenX - clientX, entry.screenY - clientY);
    const reach = Math.max(12, entry.radiusPx + 8);
    if (distance < reach && distance < bestDistance) {
      bestDistance = distance;
      best = entry.moon.id;
    }
  }

  if (!best) {
    // Nothing hit: fall back to Saturn if the click landed on the globe.
    const centre = store.camera.project(store.system.saturnCentred(SATURN_INDEX));
    const radiusPx = 60_268 * store.camera.scale;
    if (Math.hypot(centre.x - clientX, centre.y - clientY) < radiusPx) best = 'saturn';
  }

  if (best) store.select(best);
}

window.addEventListener('keydown', (event) => {
  // Leave the interface's own controls alone.
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;

  switch (event.key) {
    case ' ':
      event.preventDefault();
      store.paused = !store.paused;
      break;
    case ',':
      store.setWarp(store.warpIndex - 1);
      break;
    case '.':
      store.setWarp(store.warpIndex + 1);
      break;
    case 'Shift':
      store.setThrottle(Math.min(1, store.module.throttle + 0.25));
      break;
    case 'Control':
      store.setThrottle(Math.max(0, store.module.throttle - 0.25));
      break;
    case 'x':
      store.setThrottle(0);
      break;
    case 'z':
      store.setThrottle(1);
      break;
    case 'f':
      store.followModule = !store.followModule;
      break;
    case 'p':
      predictor.request(store);
      break;
    default:
      break;
  }
});

// --------------------------------------------------------------------- loop

/** Never take more than this many integration steps in one frame. */
const MAX_STEPS_PER_FRAME = 320;

let lastFrame = performance.now();
let lastUiUpdate = 0;
let lastAutoPredict = 0;

function frame(now: number): void {
  const wallDelta = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (!store.paused && !store.crashed) {
    const wanted = wallDelta * store.warp;
    const affordable = MAX_STEPS_PER_FRAME * store.system.step;
    store.advance(Math.min(wanted, affordable));
  }

  if (store.followModule) {
    store.camera.centre = store.saturnCentred(store.probe.position);
  }

  drawScene(ctx, store, now);

  // The interface changes far more slowly than the scene; ten times a second is
  // past the point where a person can read a changing number anyway.
  if (now - lastUiUpdate > 100) {
    lastUiUpdate = now;
    panels.update();
  }

  /*
   * Refresh the prediction on a slow timer once it has gone stale.
   *
   * Not on every change: a player nudging the throttle would otherwise queue a
   * prediction per frame, and each one costs a second of worker time. Two
   * seconds of quiet is enough to mean they have finished adjusting.
   */
  if (
    store.overlays.prediction &&
    store.predictionStale &&
    !store.predictionPending &&
    now - lastAutoPredict > 2_000
  ) {
    lastAutoPredict = now;
    predictor.request(store);
  }

  requestAnimationFrame(frame);
}

// The module has moved the moment the simulation starts, so ask once up front
// rather than making the player wait two seconds for the first prediction.
predictor.request(store);
requestAnimationFrame(frame);

/*
 * The opening view: the module's orbit, rings filling it, lit face toward us.
 *
 * `faceSun` is what makes the last part work. Saturn's seasons put the Sun on
 * one side of the ring plane for fifteen years at a stretch, and at J2000 it is
 * on the south side — so a camera that simply started above the plane would
 * open on the unlit face and render an almost entirely black picture. Correct,
 * and a terrible first impression.
 */
store.camera.halfWidth = 420_000;
store.camera.faceSun(store.sun.direction);
