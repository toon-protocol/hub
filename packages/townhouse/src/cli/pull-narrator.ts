/**
 * Pull-progress narrator (Epic 49 Followup D).
 *
 * Dockerode's `pullProgress` events fire many times per second per layer
 * (e.g., a single 80 MB layer emits one event per a few KB downloaded). If we
 * naively forwarded every event to stdout the operator would see ~thousands of
 * lines per image — exactly the noise we are trying to fix.
 *
 * This narrator:
 *   1. Always prints layer-state TRANSITIONS (`Pulling fs layer` →
 *      `Downloading` → `Extracting` → `Pull complete`). Operators care about
 *      these because each one tells them the pull is still alive.
 *   2. Throttles repeated `Downloading`/`Extracting` updates to at most one
 *      line per second PER IMAGE so a slow download still narrates progress
 *      without flooding.
 *   3. Always passes through final image-level statuses
 *      (`Status: Downloaded newer image for ...`,
 *       `Status: Image is up to date for ...`,
 *       `Pull complete`, `Already exists`) — the operator's signal that the
 *      image is done.
 *
 * It is a pure stateful object — no I/O — so unit tests can drive a sequence
 * of events and assert the rendered lines deterministically.
 */

/** Subset of the dockerode pull-progress event shape we consume. */
export interface PullProgressEvent {
  image: string;
  status: string;
  id?: string | undefined;
  progress?: string | undefined;
}

/** Per-image throttle bookkeeping. */
interface ImageState {
  /** Last status string we PRINTED for this image (any layer). */
  lastStatus: string | undefined;
  /** Wall-clock ms of the last printed `Downloading`/`Extracting` line. */
  lastThrottledAtMs: number;
}

/**
 * Status strings that are noisy ("happens many times per second per layer")
 * and therefore subject to the per-image 1Hz throttle.
 *
 * Everything NOT in this set is treated as a transition and printed verbatim.
 */
const THROTTLED_STATUSES = new Set(['Downloading', 'Extracting']);

export interface PullNarratorOptions {
  /** Wall-clock source. Defaults to `Date.now`. Tests inject a fake clock. */
  now?: () => number;
  /** Throttle interval for noisy statuses (ms). Default 1000. */
  throttleMs?: number;
}

/**
 * Throttling state machine for pull-progress events. Stateful but I/O-free.
 *
 * Usage:
 * ```
 * const narrator = new PullNarrator();
 * orch.on('pullProgress', (event) => {
 *   const line = narrator.format(event);
 *   if (line !== null) console.log(line);
 * });
 * ```
 */
export class PullNarrator {
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly perImage = new Map<string, ImageState>();

  constructor(options: PullNarratorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.throttleMs = options.throttleMs ?? 1000;
  }

  /**
   * Render an event to a stdout-ready line, or `null` if it should be
   * suppressed by the throttle.
   */
  format(event: PullProgressEvent): string | null {
    const status = event.status;
    // Drop empty-status events (dockerode occasionally emits them on errored
    // streams). Nothing useful to narrate.
    if (!status) {
      return null;
    }
    const state = this.perImage.get(event.image) ?? {
      lastStatus: undefined,
      lastThrottledAtMs: 0,
    };

    const isThrottled = THROTTLED_STATUSES.has(status);
    const isTransition = state.lastStatus !== status;

    if (isThrottled && !isTransition) {
      // Same noisy status as last print — apply the per-image 1Hz throttle.
      const elapsed = this.now() - state.lastThrottledAtMs;
      if (elapsed < this.throttleMs) {
        return null;
      }
    }

    // Print this event. Update bookkeeping.
    state.lastStatus = status;
    if (isThrottled) {
      state.lastThrottledAtMs = this.now();
    }
    this.perImage.set(event.image, state);

    const progress = event.progress ? ` ${event.progress}` : '';
    return `  [pull] ${event.image}: ${status}${progress}`;
  }

  /**
   * Reset the narrator's per-image state. Useful between separate pull
   * batches in the same process.
   */
  reset(): void {
    this.perImage.clear();
  }
}
