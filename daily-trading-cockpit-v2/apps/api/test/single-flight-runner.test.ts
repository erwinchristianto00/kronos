import { describe, expect, it } from "vitest";
import { createSingleFlightRunner } from "../src/lib/single-flight-runner.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  // Promise.finally schedules the catch-up in a later microtask chain; yielding one event-loop
  // turn proves the runner actually drained it rather than making this test timing-dependent.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("createSingleFlightRunner", () => {
  it("coalesces missed timer ticks into one immediate catch-up without overlapping work", async () => {
    const first = deferred();
    const second = deferred();
    const runs: number[] = [];
    const queued: number[] = [];
    const runner = createSingleFlightRunner(async () => {
      runs.push(runs.length + 1);
      return runs.length === 1 ? first.promise : second.promise;
    }, { onQueued: () => queued.push(1) });

    runner.tick();
    runner.tick();
    runner.tick();
    expect(runs).toEqual([1]);
    expect(queued).toHaveLength(1);
    expect(runner.getStatus()).toEqual({ inFlight: true, queued: true, stopped: false });

    first.resolve();
    await flush();
    expect(runs).toEqual([1, 2]);
    expect(runner.getStatus()).toEqual({ inFlight: true, queued: false, stopped: false });

    second.resolve();
    await flush();
    expect(runner.getStatus()).toEqual({ inFlight: false, queued: false, stopped: false });
  });

  it("does not run a queued catch-up after stop", async () => {
    const gate = deferred();
    let runs = 0;
    const runner = createSingleFlightRunner(async () => {
      runs += 1;
      await gate.promise;
    });

    runner.tick();
    runner.tick();
    runner.stop();
    gate.resolve();
    await flush();

    expect(runs).toBe(1);
    expect(runner.getStatus()).toEqual({ inFlight: false, queued: false, stopped: true });
  });
});
