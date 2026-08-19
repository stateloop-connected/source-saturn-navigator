/**
 * Trajectory prediction, off the frame thread.
 *
 * A useful look-ahead is days to months of simulated time, which is tens of
 * thousands of integration steps over 1 431 body pairs each. That is a second
 * or several — perfectly affordable, and utterly unaffordable between two
 * frames. So the whole job goes to a worker, and the main thread keeps drawing
 * the old prediction until a new one arrives.
 *
 * What crosses the boundary is the raw state, not a handle: positions,
 * velocities, the clock, and the module. The worker rebuilds a system from the
 * same catalogue and overwrites it with what it was sent, so the copy it flies
 * is bit-for-bit the one the player is looking at. Anything less and the
 * prediction would be of a slightly different system than the game — which is
 * exactly the failure the whole design is trying to avoid.
 */

import { MOONS } from '@saturn/core/moons';
import { predict, type Prediction, type PredictionRequest } from '@saturn/core/predict';
import { SaturnSystem, type Probe } from '@saturn/core/system';
import { createModule, type ModuleState } from '@saturn/core/module';
import { ZERO, vec3 } from '@saturn/core/vec';

export interface PredictRequestMessage {
  id: number;
  time: number;
  positions: Float64Array;
  velocities: Float64Array;
  probePosition: [number, number, number];
  probeVelocity: [number, number, number];
  module: ModuleState;
  request: PredictionRequest;
}

export interface PredictResponseMessage {
  id: number;
  times: Float64Array;
  path: Float64Array;
  sampleCount: number;
  ghostTimes: Float64Array;
  ghostPositions: Float64Array[];
  approaches: Prediction['approaches'];
  impact: Prediction['impact'];
  propellantRemaining: number;
  elapsedMs: number;
}

/*
 * One system, reused across requests.
 *
 * Constructing it means seeding 53 moons from their elements and computing a
 * first acceleration pass — a few milliseconds, but a few milliseconds on every
 * keystroke while a player drags the look-ahead slider. Its contents are
 * overwritten wholesale each time, so nothing carries over.
 */
let scratch: SaturnSystem | null = null;

self.onmessage = (event: MessageEvent<PredictRequestMessage>) => {
  const message = event.data;

  const step = message.request.step ?? 120;
  if (!scratch || scratch.step !== step) {
    scratch = new SaturnSystem(message.time, step, MOONS);
  }

  scratch.positions.set(message.positions);
  scratch.velocities.set(message.velocities);
  scratch.time = message.time;
  scratch.probes = [];

  const probe: Probe = {
    position: vec3(...message.probePosition),
    velocity: vec3(...message.probeVelocity),
    thrust: ZERO,
  };

  const module: ModuleState = { ...createModule(), ...message.module };

  const prediction = predict(scratch, module, probe, message.request);

  const ghostTimes = new Float64Array(prediction.ghosts.map((ghost) => ghost.time));
  const ghostPositions = prediction.ghosts.map((ghost) => ghost.positions);

  const response: PredictResponseMessage = {
    id: message.id,
    times: prediction.times,
    path: prediction.path,
    sampleCount: prediction.sampleCount,
    ghostTimes,
    ghostPositions,
    approaches: prediction.approaches,
    impact: prediction.impact,
    propellantRemaining: prediction.propellantRemaining,
    elapsedMs: prediction.elapsedMs,
  };

  // Hand the buffers over rather than copying them: a long prediction is a few
  // megabytes of path and ghost data, and transferring is free where a
  // structured clone is not.
  const transfer: Transferable[] = [
    response.times.buffer,
    response.path.buffer,
    response.ghostTimes.buffer,
    ...ghostPositions.map((array) => array.buffer),
  ];
  (self as unknown as Worker).postMessage(response, transfer);
};
