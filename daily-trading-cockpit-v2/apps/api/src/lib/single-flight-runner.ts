/**
 * Runs at most one asynchronous job at a time while retaining one catch-up request. Timers may
 * fire faster than a slow job completes; dropping those ticks silently loses collection work,
 * while running them concurrently causes overlapping exchange and resolver work. This keeps the
 * latest missed tick and drains it immediately once the active job settles.
 */
export function createSingleFlightRunner(
  run: () => Promise<void>,
  opts: { onQueued?: () => void; onError?: (error: unknown) => void } = {},
) {
  let inFlight = false;
  let queued = false;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    if (inFlight) {
      // Coalesce any number of missed timer firings into exactly one follow-up run.
      if (!queued) opts.onQueued?.();
      queued = true;
      return;
    }
    inFlight = true;
    Promise.resolve(run())
      .catch((error) => opts.onError?.(error))
      .finally(() => {
        inFlight = false;
        if (queued && !stopped) {
          queued = false;
          tick();
        }
      });
  };

  return {
    tick,
    stop: () => { stopped = true; queued = false; },
    getStatus: () => ({ inFlight, queued, stopped }),
  };
}
