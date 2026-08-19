/**
 * The main thread's side of the predictor.
 *
 * Two behaviours worth naming, because both come from the same fact — that a
 * prediction takes long enough to be overtaken by the player.
 *
 * **One in flight at a time.** A player dragging the look-ahead slider would
 * otherwise queue thirty requests, each of which the worker would dutifully
 * finish long after its answer stopped being wanted. Instead a request made
 * while one is running replaces the pending one, and only the latest is sent
 * when the worker frees up.
 *
 * **Results are matched by id.** A prediction that arrives after the player has
 * already burnt again describes a future that no longer exists, and drawing it
 * would be worse than drawing nothing.
 */

import type { Prediction } from '@saturn/core/predict';
import type { Store } from '../state/store.js';
import type {
  PredictRequestMessage,
  PredictResponseMessage,
} from './predict.worker.js';

export class Predictor {
  private readonly worker: Worker;
  private nextId = 1;
  private inFlight = 0;
  private queued: Store | null = null;

  constructor(private readonly onResult: (prediction: Prediction) => void) {
    this.worker = new Worker(new URL('./predict.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<PredictResponseMessage>) => {
      this.receive(event.data);
    };
  }

  /** Ask for a prediction of the store's current state. */
  request(store: Store): void {
    if (this.inFlight !== 0) {
      this.queued = store;
      return;
    }
    this.send(store);
  }

  private send(store: Store): void {
    const id = this.nextId++;
    this.inFlight = id;
    store.predictionPending = true;

    const message: PredictRequestMessage = {
      id,
      time: store.system.time,
      // Copies, not the live arrays: the simulation keeps running while the
      // worker thinks, and transferring the originals would empty them.
      positions: store.system.positions.slice(),
      velocities: store.system.velocities.slice(),
      probePosition: [
        store.probe.position.x,
        store.probe.position.y,
        store.probe.position.z,
      ],
      probeVelocity: [
        store.probe.velocity.x,
        store.probe.velocity.y,
        store.probe.velocity.z,
      ],
      module: store.module,
      request: {
        duration: store.predictionSettings.duration,
        samples: store.predictionSettings.samples,
        ghosts: store.predictionSettings.ghosts,
        step: store.predictionSettings.step,
      },
    };

    this.worker.postMessage(message, [
      message.positions.buffer,
      message.velocities.buffer,
    ]);
  }

  private receive(response: PredictResponseMessage): void {
    if (response.id !== this.inFlight) return;
    this.inFlight = 0;

    const prediction: Prediction = {
      times: response.times,
      path: response.path,
      sampleCount: response.sampleCount,
      ghosts: response.ghostPositions.map((positions, index) => ({
        time: response.ghostTimes[index] ?? 0,
        positions,
      })),
      approaches: response.approaches,
      impact: response.impact,
      propellantRemaining: response.propellantRemaining,
      elapsedMs: response.elapsedMs,
    };

    this.onResult(prediction);

    if (this.queued) {
      const store = this.queued;
      this.queued = null;
      this.send(store);
    }
  }

  dispose(): void {
    this.worker.terminate();
  }
}
