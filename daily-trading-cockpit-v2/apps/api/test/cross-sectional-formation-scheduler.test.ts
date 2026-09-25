import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CrossSectionalFormationScheduler,
  CROSS_SECTIONAL_FORMATION_POST_CLOSE_GRACE_MS,
} from "../src/lib/cross-sectional-formation-scheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CrossSectionalFormationScheduler", () => {
  it("anchors the first formation to the next completed 1h candle, not process-start phase", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:37:00.000Z"));
    const scheduler = new CrossSectionalFormationScheduler({
      featureMaxAgeMs: 5 * 60_000,
      runFormation: async () => ({ opened: 0 }),
      hasFreshFeature: () => false,
    });

    scheduler.start();

    expect(scheduler.getStatus()).toMatchObject({
      enabled: true,
      lastOutcome: "WINDOW_EXPIRED",
      nextDueAt: "2026-09-01T13:00:20.000Z",
      postCloseGraceMs: CROSS_SECTIONAL_FORMATION_POST_CLOSE_GRACE_MS,
    });
    scheduler.stop();
  });

  it("does not label an expired current-cutoff feature as entry-fresh after restart", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:37:00.000Z"));
    const scheduler = new CrossSectionalFormationScheduler({
      featureMaxAgeMs: 5 * 60_000,
      runFormation: async () => ({ opened: 0 }),
      hasFreshFeature: (cutoff) => cutoff === Date.parse("2026-09-01T12:00:00.000Z"),
    });

    scheduler.start();

    expect(scheduler.getStatus()).toMatchObject({
      lastOutcome: "WINDOW_EXPIRED",
      lastFeatureCutoffAt: "2026-09-01T12:00:00.000Z",
      nextDueAt: "2026-09-01T13:00:20.000Z",
    });
    scheduler.stop();
  });

  it("performs one bounded catch-up after restart inside the fresh window and hands a persisted signal to the executor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T01:01:00.000Z"));
    let fresh = false;
    let runs = 0;
    let handoffs = 0;
    const scheduler = new CrossSectionalFormationScheduler({
      featureMaxAgeMs: 5 * 60_000,
      runFormation: async () => {
        runs += 1;
        fresh = true;
        return { opened: 1, openedDynamicMom36Shock: 1 };
      },
      hasFreshFeature: (cutoff) => fresh && cutoff === Date.parse("2026-09-01T01:00:00.000Z"),
      onSignalFormed: () => { handoffs += 1; },
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(runs).toBe(1);
    expect(handoffs).toBe(1);
    expect(scheduler.getStatus()).toMatchObject({
      lastOutcome: "FORMED",
      lastFeatureCutoffAt: "2026-09-01T01:00:00.000Z",
      nextDueAt: "2026-09-01T02:00:20.000Z",
      attemptsForActiveFeature: 1,
    });
    scheduler.stop();
  });

  it("retries only while there is time to persist and dispatch a fresh feature", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T02:00:00.000Z"));
    let runs = 0;
    const scheduler = new CrossSectionalFormationScheduler({
      featureMaxAgeMs: 5 * 60_000,
      runFormation: async () => {
        runs += 1;
        return null;
      },
      hasFreshFeature: () => false,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000 + 3 * 60_000);
    await flush();

    expect(runs).toBe(4);
    expect(scheduler.getStatus()).toMatchObject({
      lastOutcome: "WINDOW_EXPIRED",
      nextDueAt: "2026-09-01T03:00:20.000Z",
      attemptsForActiveFeature: 4,
    });
    scheduler.stop();
  });

  it("does not overlap a slow formation pass or add a second start-trigger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T04:00:00.000Z"));
    let fresh = false;
    let resolveRun!: () => void;
    const waiting = new Promise<void>((resolve) => { resolveRun = resolve; });
    let runs = 0;
    const scheduler = new CrossSectionalFormationScheduler({
      featureMaxAgeMs: 5 * 60_000,
      runFormation: async () => {
        runs += 1;
        await waiting;
        fresh = true;
        return { opened: 0 };
      },
      hasFreshFeature: (cutoff) => fresh && cutoff === Date.parse("2026-09-01T04:00:00.000Z"),
    });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toBe(1);
    expect(scheduler.getStatus().inFlight).toBe(true);

    resolveRun();
    await flush();

    expect(runs).toBe(1);
    expect(scheduler.getStatus()).toMatchObject({
      inFlight: false,
      lastOutcome: "NO_TRADE",
      nextDueAt: "2026-09-01T05:00:20.000Z",
    });
    scheduler.stop();
  });
});
